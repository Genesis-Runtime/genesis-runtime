# Plugin API 1.6: home view, reply panel, scoped context and model provider types

Core API 1.6.0 adds four extension points for host applications:

- choosing the view a host's interface opens on
- a collapsible reply panel
- letting a conversation see a plugin's data when, and only when, a message is about it
- adding new kinds of model endpoint, such as a Meterless Runtime

All four are additive. Manifests written for 1.5 normalise exactly as before, and the new permissions are off unless declared.

## Home view

The home view is the view a host UI opens on and returns to. It is either a host view id (`world`, `tasks`, `plugins`…) or a plugin primary tab, written `plugin:<pluginId>:<tabId>`.

Genesis resolves it from these candidates, and the first usable one wins:

1. `GENESIS_HOME_VIEW`, set by the deployment.
2. `profile.ui.homeView`.
3. A plugin's claim: a primary tab registered with `home: true` by a plugin whose manifest grants `permissions.homeView`. The lowest `homePriority` wins, then the earliest registration.
4. `profile.ui.defaultTab`, the older setting, which can only name a host view.
5. The host's `defaultHomeView`, passed to `initializePluginManager` or `createGenesisPluginManager`.

A plugin view counts only while an enabled, visible plugin has registered that tab. A profile that names a plugin which isn't installed falls through to the next candidate instead of opening an empty view, and the reason is reported.

```js
// manifest.permissions.homeView: true
api.registerUiPrimaryTab({ id: "main", title: "Orders", scriptUrl: "/api/plugin-ui/orders/tab.js", home: true });
```

```json
{ "ui": { "homeView": "plugin:orders:main" } }
```

A host UI reads the result at startup with `GET /api/ui/settings` (public, nothing secret), `pluginManager.getUiSettings()`, or `api.getUiSettings()` from a plugin:

```json
{ "ok": true, "title": "Genesis", "hiddenTabs": [], "homeView": "plugin:orders:main",
  "homeViewSource": "plugin", "homeViewClaimedBy": "orders",
  "homeTab": { "id": "main", "pluginId": "orders", "title": "Orders", "scriptUrl": "..." },
  "unavailableHomeViews": [] }
```

Drawing the view is the host UI's job. For example, it can place `homeTab` first in its navigation and open it on load.

## Reply panel

The box a host shows the model's reply in can be minimised. Genesis supplies the behaviour and the settings, and the host supplies the markup.

`profile.ui.responsePanel` sets four options, all optional. They reach the host UI as `responsePanel` in `/api/ui/settings`:

| Setting | Default | Meaning |
|---|---|---|
| `collapsible` | `true` | The panel has a Minimise/Expand toggle |
| `startCollapsed` | `false` | It opens minimised |
| `expandOnNewReply` | `true` | A new reply opens it, so it is never missed behind a minimised box |
| `rememberState` | `true` | The viewer's last choice is kept in their browser |

The helper is framework-free and lives in Observer Compat, which hosts already serve (`/observer-compat/browser/collapsible.js`; the package export `genesis-runtime/compat/collapsible`):

```js
import { createCollapsible } from "/observer-compat/browser/collapsible.js";
const { responsePanel } = await (await fetch("/api/ui/settings")).json();
const panel = createCollapsible({
  container: document.querySelector("#responseDock"),
  body: document.querySelector("#responseText"),     // hidden while collapsed
  toggle: document.querySelector("#responseToggle"),  // label, aria-expanded and aria-controls kept in step
  storageKey: "app.reply", settings: responsePanel     // labels: { collapse: "Minimise", expand: "Expand" }
});
// when a reply arrives:
panel.reveal();
```

The helper also exposes `collapse()`, `expand()`, `toggle()`, `isCollapsed()`, `onChange(fn)` and `destroy()`. A blocked `localStorage`, as in a private window, does not break it.

## Scoped context providers

A plugin that holds data a conversation may ask about registers a **context provider**. A host about to answer a message calls `collectContext`, and the model is shown only the notes from providers the message is in scope for, each block labelled with the plugin it came from. Genesis owns the contract, the scoping, the budgets and the failure isolation. It never calls a model.

```js
// manifest.permissions.contextProviders: ["history"]   (or true for any id)
api.registerContextProvider({
  id: "history",
  title: "Order history",
  instruction: "Answer questions about these orders only from these notes. If they do not answer it, say so.",
  audiences: ["chat"],                          // chat | intake | worker | planner; default chat
  match: { keywords: ["order", "refund"], patterns: ["\\bORD-\\d+\\b"] },
  priority: 100,                                // lower runs and is placed first
  maxChars: 2400                                // this provider's share
}, async ({ message, audience, scope, metadata }) => {
  const orders = findOrdersMentioned(message, scope.patterns);
  return orders.length ? { notes: orders.map(summary), sources: orders.map((order) => order.id) } : null;
});
```

Scope is decided in two steps, and both are optional:

- **`match`** is either declarative or a function. In declarative form, `keywords` match at the start of a word (so "invoice" also matches "invoices"), `patterns` are regular expressions, and no plugin code runs if neither hits. A function `(request) => truthy` lets the provider decide itself. The matched keywords and pattern texts reach `provide` as `scope`.
- **`provide`** returns `null` when the message is not about the plugin's data. This is how a provider scopes on things only its own data knows, such as which order ids exist. It returns a string, a list of strings, or `{ notes, instruction, sources }`.

A provider with neither keywords, patterns nor a match function is asked about every message.

Collecting:

```js
const context = await pluginManager.collectContext({
  message, audience: "chat",
  maxChars: 6000,           // total budget; a section that does not fit is reported, not cut
  timeoutMs: 2000,          // per provider; default is the plugin hook timeout
  providers: [],            // only these "<pluginId>:<providerId>" keys, if given
  exclude: [],              // never these
  metadata: { sessionId }   // passed through to providers
});
// context.text     prompt-ready, one "## <title> (from <plugin>)" block per section
// context.sections [{ key, pluginId, providerId, title, instruction, notes, sources, scope, truncated }]
// context.skipped  [{ key, reason }]  out of scope | nothing in scope | disabled | not requested | context budget exhausted
// context.failures [{ key, error }]   thrown or timed out; recorded as a plugin failure, never thrown
```

The same is available as `POST /api/context/collect` and `GET /api/context/providers` (both admin), and to plugins as `api.collectContext(request)` with `permissions.contextCollect: true`, for chat plugins that build their own prompts. A profile switches providers off with `context.disabledProviders: ["<pluginId>:<providerId>"]`.

Providers of disabled or profile-hidden plugins are never asked. `listPlugins()` reports each plugin's `contextProviders` and `homeViewClaim`.

### Compared with `*:prompt:build` hooks

The `intake:prompt:build` and `worker:prompt:build` hooks still work, but they are unscoped, ordered by mutation, and anonymous: every plugin edits every prompt. Use a context provider for "my data, when the message is about it". Keep the hooks for changing how a prompt is built.

## Model provider types

Genesis runs no models, but a host that hard-codes which kinds of model endpoint it understands (`ollama`, `openai-compatible`, ...) has to be changed for every new kind. A plugin now registers a **provider type**. A host lists the registered types beside its built-in ones, builds its model editor from their descriptions, and calls `generateWithModelProvider` for any processor whose `provider` is a registered type.

```js
// manifest.permissions.modelProviders: ["meterless"]
api.registerModelProvider({
  id: "meterless",                  // stored as the processor's provider; global, first plugin wins
  label: "Meterless Runtime",
  protocol: "openai-chat",          // informational
  defaults: { baseUrl: "http://127.0.0.1:8088/v1", model: "meterless/auto", contextSize: 32768 },
  fields: [                         // the editor's fields: text | url | number | select | textarea | checkbox
    { id: "baseUrl", label: "Runtime address", type: "url", required: true },
    { id: "model", label: "Routing mode or pinned model", type: "select", optionsFrom: "probe" }
  ],
  secrets: [{ handle: "meterless_runtime_token", label: "Runtime token" }],
  actions: [{ id: "detect", label: "Auto Detect" }, { id: "connect", label: "Save token" }],
  capabilities: { chat: true, json: false, tools: false }
}, {
  normalizeConfig(config, ctx) { /* validate and canonicalise; throw TypeError to refuse */ },
  async probe(config, ctx)     { return { status: "online" | "unauthorized" | "offline", models: [{ id, description }], detail }; },
  async generate(config, request, ctx) { return { text, finishReason, usage, model }; },
  actions: { async detect(input, ctx) {}, async connect(input, ctx) {} }
});
```

- **`generate`** receives `request.messages` (a bare `prompt` is turned into one user message), along with `temperature`, `maxTokens`, `timeoutMs`, `signal` and anything else the host passes. Genesis adds no timeout of its own, because some runtimes take minutes to load a model; the provider honours the request's timeout.
- **`probe`** and **actions** run within the plugin hook timeout. A probe never throws: errors become `{ status: "offline", detail }`.
- **Secrets.** `ctx.secrets.get`, `has` and `set` reach only the handles the provider declared. They go through the installed `secrets:get` and `secrets:set` capabilities (the secrets plugin, or a host's own store), and `get` falls back to an environment variable of the same name. No route or result returns a secret value.

For hosts, the manager offers `listModelProviders()`, `normalizeModelProviderConfig(id, config)`, `probeModelProvider(id, config)`, `runModelProviderAction(id, action, input)`, `setModelProviderSecret(id, handle, value)` and `generateWithModelProvider(id, config, request)`. The same operations are on admin routes under `/api/model-providers` (`GET`, then `POST …/:id/normalize`, `/probe`, `/actions/:action`, `/secrets/:handle` and `/generate`). Plugins may list provider types freely. They need `permissions.modelProviderUse: true` to probe or generate.

The first provider type is the `meterless` plugin in the genesis-plugins catalog. It supports routing modes and pinned models, Auto Detect, connect links and the token in the secret store. It refuses a connect link pasted as an address, so the token never ends up in a saved configuration.
