# Genesis Runtime

A minimal runtime for hosting plugins, tools, and orchestration components. Genesis supplies
infrastructure only — behaviour comes from plugins. See the Genesis Core Extraction Directive
and `../genesis-core/docs/GENESIS-EXTRACTION-CLASSIFICATION.md` for the full extraction plan
this package implements.

## Reusable host API (0.4)

Genesis can be embedded by host applications instead of only running
`server.js`. Exported subpaths provide the plugin loader, plugin system, profile manager, admin
security, and HTTP hooks. `initializePluginManager` accepts explicit `pluginDirectories`,
`externalPluginImportMode`, and `hostCapabilities`. Host capabilities participate in ordinary
plugin dependency checks and `api.getCapability(...)` resolution without representing the host
application as a plugin. Call `pluginManager.shutdown()` during orderly host shutdown so enabled
plugins receive `onDisable`.

Version 0.3 closes the registered-tool execution gap. Plugins may now use
`api.registerTool(descriptor, handler)`, and embedded hosts invoke it through
`pluginManager.executeTool(name, args, context)`. Existing plugins that expose a descriptor and
handle execution through `intake:tool-call` remain compatible; `executeTool` falls back to that
hook when no direct handler was registered. Tool discovery through `listTools()` is unchanged.

Version 0.4 (core plugin API 1.5.0) lets a plugin declare what it is about. The optional
manifest field `topics: { keywords: [...], examples: [...] }` lists the subjects, services and platforms
it covers (up to 24 keywords) and requests it serves (up to 12 examples). The field is normalised like the
rest of the manifest and reported through `listPlugins()` in each plugin's `manifest`. A host can use it to
choose when to offer the plugin's tools, for example by matching incoming messages against it.
Topics grant nothing: permissions, capabilities and tool registration are unchanged.

## What's here

- `server.js` — entrypoint. Boots Express, the Observer Compat static mount, admin security,
  the plugin host, and a handful of runtime-status endpoints.
- `lib/` — the 9 KEEP_CORE modules from the classification pass: the plugin manager
  (`plugin-system.js`), plugin discovery/bootstrap (`plugin-loader.js`), admin auth
  (`admin-security.js`), HTTP request→hook dispatch (`http-hooks.js`), deployment profiles
  (`profile-manager.js`), and low-level plugin data/fs primitives.
- `observer-compat/` — the Observer Compat contract, copied verbatim (byte-identical) from
  `nova-observer/observer-compat`. Do not edit without updating all compatible orchestrators.
- `plugins/` — where `*-plugin.js` files are auto-discovered from. Ships **empty** by design
  (Architectural Rule: Genesis boots with zero optional plugins).
- `profiles/` — deployment profiles (see "Profiles are first-class" below).
- `public/` — a minimal status page (`/`) that lists runtime status and installed plugins.

## Running against an external plugin catalog

`plugins/` ships empty by design, but a real deployment points `GENESIS_PLUGIN_DIR` at wherever
its plugins actually live — e.g. a separate `genesis-plugins` checkout, a much larger catalog developed
separately from this repo. Two things to know before doing that:

1. **Import trust.** By default, plugins discovered outside this repo's own `plugins/`
   directory must be on a hash allowlist (`runtime-data/plugin-trust.json`) — a real security
   feature, not a bug, meant for genuinely third-party code. For your own trusted plugin
   directory, set `GENESIS_EXTERNAL_PLUGIN_IMPORT_MODE=permissive` to skip that check.
2. **Shared dependencies.** Node resolves bare imports from the plugin catalog, not from this
   runtime's `node_modules`. The maintained `genesis-plugins` catalog therefore has its
   own package manifest and dependencies. Legacy Nova utility imports use the exported
   `genesis-runtime/compat/*` subpaths rather than fragile parent-directory shims.

Example:
```
PORT=3300 GENESIS_PLUGIN_DIR="/path/to/genesis-plugins" GENESIS_EXTERNAL_PLUGIN_IMPORT_MODE=permissive GENESIS_PROFILE=developer node server.js
```

Catalog version 0.2 composes the original flat mail transport wiring into the richer
`mail/mail-plugin.js`. It remains the sole discoverable `mail` provider while retaining the
original agent registry, secrets, IMAP polling, SMTP sending, capabilities, tools, and routes.

## Profiles are first-class

Profiles aren't sample config — they're the unit you install, activate, and fork. Each one is a
`profiles/<id>.json` file plus (once installed) the actual plugin source it enables, copied
locally into `plugins/_catalog/` where you're expected to edit it. See "CLI" below for the
`genesis` command that drives this.

Eight profiles ship in `profiles/`, all validated against the 46-plugin `genesis-plugins` catalog (boots clean, 0 load errors):

| Profile | `genesis create <id>` | Enables |
|---|---|---|
| Default | `default` | nothing — baseline used as the merge base for every other profile |
| Minimal | `minimal` | `secrets`, `model-provider` only — verify the runtime boots before adding anything |
| Home | `home` | agent-runtime, memory, mail, calendar, voice/avatar, presence, home automation (Home Assistant/Matter/MQTT), skills, philosophy/personality — no dev or business tooling |
| Developer | `developer` | agent-runtime, sandbox, workspace, code-review, deploy, github, qa, security-audit, vscode bridge, sprint/design tooling |
| Startup | `startup` | agent-runtime, finance, projects, sprint, mail/calendar, github, social-media-manager, governance, information-agent — running-the-business tooling, not writing-the-code tooling |
| Ghostwriter | `ghostwriter` | personality/personality-clone, philosophy, projects (writing fragments), retrieval, social-media-manager — persona and content work |
| Watchtower | `watchtower` | security, security-audit, governance, qa, code-review, deploy, developer-tools, browser, information-agent — security/CI/external-monitoring watch |
| Full Catalog | `full` | everything — for integration testing, not a real deployment (broad tool/capability surface) |

Each profile's `disabledPlugins` list is the full-catalog complement of its `enabledPlugins`
(profiles enable-by-default otherwise — an empty `enabledPlugins` list does *not* mean "nothing
on," see `lib/profile-manager.js`'s `resolveProfilePluginState`). Disabling a plugin via profile
stops its routes from mounting and hides it from the enabled-plugin list, but its `init()` still
runs and its capabilities stay registered (that's `plugin-system.js` behavior, not
profile-specific) — a fully inert "disabled" plugin isn't something the current plugin host
guarantees.

## CLI

`bin/genesis.js` (run as `node bin/genesis.js`, `npm run genesis`, or `genesis` once linked/
installed) turns "pick a profile" into an actual install step instead of hand-editing
`GENESIS_PLUGIN_DIR`:

```
genesis list                          # available profiles, with the active one marked
genesis create <profile>              # copy that profile's plugins from the catalog, then activate it
genesis install profile <profile>     # same thing — alias, matches "install" as a verb
genesis use <profile>                 # activate a profile without touching plugins/ (they're already installed)
genesis new <profile> [--from <id>]   # scaffold profiles/<profile>.json from an existing profile, to customize
genesis catalog [--catalog <path>]    # inspect what a catalog resolves to, without installing anything
```

### Where plugins come from

Each plugin lives in its own git repo — `create` / `install profile` shallow-clone one per plugin
straight into `plugins/_catalog/<id>/` (a real checkout, not a copy, so a future `git pull` there
keeps working). That's the default and intended transport; a local catalog directory is also
fully supported, as an explicit fallback for plugins that aren't published yet, or that never
will be (private/local-only plugins).

Per plugin, the source is resolved in this order:

1. `profile.pluginSources["<id>"]` — a per-profile override/pin, checked first
2. `profiles/plugin-sources.json["<id>"]` — a shared registry reused across every profile
3. `--catalog <path>` (or `GENESIS_PLUGIN_CATALOG` / `GENESIS_PLUGIN_DIR`) — a local dev catalog
   directory, used only for plugins with no registered source above

A registry or per-profile entry is either a bare git URL (optionally `"<url>#<ref>"`), or an
explicit object:

```json
{
  "mail": "https://github.com/org/genesis-plugin-mail.git#main",
  "internal-tool": { "type": "local", "path": "/path/to/genesis-plugins/internal-tool" }
}
```

Pass `--source git` or `--source local` to force one strategy for every plugin in the install
(e.g. to confirm nothing silently falls back to a local catalog).

Local-catalog installs are copied — not symlinked — into `plugins/_catalog/`, following each
plugin's actual local import graph (so two plugins sharing a directory, like
`iot-matter`/`iot-mqtt`, don't drag each other in) plus its `public/`/`vendor/` asset folders when
it owns them outright. Installs over ~25MB from a local catalog (e.g. `multilingual-voice`'s
bundled whisper/ffmpeg binaries) require `--yes` to proceed, since that's easy to trigger by
accident via a profile that just lists the plugin id.

Either way, a re-run leaves files/checkouts that already exist alone, so hand-edits under
`plugins/_catalog/` survive; pass `--force` to force a fresh clone/copy. Bare npm imports a
plugin needs are reported, not auto-installed — add them to `package.json` yourself.

Once a profile is active (`create`/`install profile`/`use` all persist the choice to
`runtime-data/profile-selection.json`), it stays active across restarts without needing
`GENESIS_PROFILE` set — that env var still works and takes priority, useful for one-off runs
against a profile you haven't switched to.

## Identity notes

This is a from-scratch entrypoint, not a copy of `genesis-core/server.js` — it only wires the
modules classified KEEP_CORE/KEEP_COMPAT. Along the way, two Nova-specific assumptions baked
into otherwise-generic core code were found and fixed here (not yet back-ported to
`genesis-core`):

- `plugin-system.js` restricted tool `scopes` to the literal values `"intake"`/`"worker"`
  (Nova's agent architecture). Genesis core has no such concept — scopes are now an opaque,
  plugin-defined label.
- The "Nova tab" UI descriptor category was renamed to "primary tab" throughout.
- `OBSERVER_*` env vars were renamed to `GENESIS_*`; `[observer]` log lines to `[genesis]`.
- Admin security defaults to protecting **all** unsafe-method `/api/*` requests (with a small
  public-path exemption list) rather than an opt-in per-path allowlist — see the comment in
  `lib/admin-security.js`. An opt-in list is the wrong default for a plugin host, since a
  plugin author adding a mutating route has no way to know they need to register it as
  "protected" too.

## Try it

```
npm install
npm start   # listens on PORT (default 3300)
```

With zero plugins, `GET /api/plugins/list` returns an empty plugin/capability/tool set and
`GET /api/runtime/status` reports zero plugin load errors — the zero-plugin boot success
criterion from the extraction directive.

## Plugins (all of them, as of this extraction)

Boots with 11 plugins, 0 load errors, 67 capabilities, 93 routes:

| Plugin | From (genesis-core) | Depends on |
|---|---|---|
| `secrets-plugin.js` | `observer-secrets-service.js` | — |
| `model-provider-plugin.js` | `observer-brain-config.js`, `ollama-runtime-service.js`, `lib/brain-*.js` | secrets (optional) |
| `homeassistant-plugin.js` | `observer-iot-domain.js`, `observer-iot-routes.js` | — |
| `memory-plugin.js` | `memory-trust-domain.js` (prompt-memory half; trust half already lives in `observer-compat/server/trust.js`) | — |
| `retrieval-plugin.js` | `retrieval-domain.js`, `observer-document-domain.js` | secrets, model-provider (optional) |
| `sandbox-plugin.js` (+`sandbox-output-compression.js` helper) | `observer-sandbox-service.js`, `sandbox-io-service.js`, `sandbox-state-store.js`, `output-semantic-compression.js`, `shell-hook-compression.js`, `observer-output-semantic-utils.js` | — |
| `skills-marketplace-plugin.js` | `skill-library.js`, `observer-agent-skills-service.js`, `observer-agent-skill-routes.js` | model-provider (optional) |
| `voice-avatar-plugin.js` | `voice-domain.js`, `observer-avatar-scene-domain.js` | — |
| `workspace-plugin.js` | `sandbox-workspace-service.js`, `observer-workspace-file-utils.js`, `observer-workspace-tracking.js`, `workspace-transaction-service.js` | sandbox (optional) |
| `mail-plugin.js` | `observer-periodic-jobs.js` (mail-watch portion) | secrets |
| `agent-runtime-plugin.js` | task queue / execution runner / intake / cron cluster (~44 files, ~19k lines — see below) | model-provider, sandbox, workspace, memory (all optional) |

All were built following the pattern proven by `homeassistant-plugin.js`: manifest-declared
permissions, `api.data` for persistence instead of a shared config file, `api.provideCapability`
for cross-plugin calls, hooks for extension points. Cross-plugin dependencies are called via
`api.getCapability(...)` at call time and fail with a clear error (not a crash) if the
providing plugin isn't installed.

**`agent-runtime-plugin.js` is a deliberate simplification, not a mechanical port.** Its source
cluster is Nova's largest and most product-specific: the tool-calling execution loop, task
queue/lifecycle/storage, intake/triage, and — explicitly **not ported**, left for a dedicated
follow-up — opportunity scanning, escalation-review retry heuristics, helper-scout/maintenance
jobs, the "recreation" reflective job, Nova's native chat-response builders (calendar/finance/
inbox summaries), and tool-loop-repair-helpers' sandbox-specific JSON-repair heuristics. What's
here is a genuinely working task queue + tool-calling loop + intake split + cron, at a fraction
of the original's size, capturing the *shape* of the mechanism rather than Nova's full feature
set. See the file's header comment for the full list.

**Also explicitly excluded from this extraction** (not mechanically portable — see
`genesis-core/docs/GENESIS-EXTRACTION-CLASSIFICATION.md`): the ~4,300-line regression test
suite (`regression-suites.js` + friends) is Nova's product test *content*, not infrastructure —
nothing to extract. The ~17k-line admin dashboard (`public/*.js`) is explicitly out of scope per
the mission ("minimal admin UI... written fresh", not carved from Nova's DOM-specific code);
`genesis-runtime/public/index.html` is that fresh (much smaller) start.

**A real cross-plugin bug found and fixed post-integration:** `model-provider-plugin.js`'s
`brain:generate`/`brain:generate-json` capabilities were built expecting `{prompt}`, but
`agent-runtime-plugin.js` and `skills-marketplace-plugin.js` (built independently, in parallel)
both called them with `{messages: [...]}`. Fixed by making the capability accept either shape
rather than picking a side — verified via a full task create→dispatch→execute round trip.
