# Plugin API 1.7: tool use, tool guards, standard hooks and protected reads

Core API 1.7.0 lets a plugin that drives a model call the tools other plugins register, and lets other plugins police those calls. It also adds two deployment settings. Everything is additive: manifests written for 1.6 normalise exactly as before, and the new permission is off unless declared.

## Tool use

Until 1.6, `api.registerTool` was discovery only. Core could execute a tool (`pluginManager.executeTool`), but plugins could not, so an agent runtime had no way to find or call another plugin's tools. A plugin that declares `permissions.toolUse: true` now gets both:

```js
// manifest.permissions.toolUse: true
const tools = api.listTools();                 // enabled, visible plugins' tools, filtered by the profile
const outcome = await api.executeTool("run_shell", { command: "uptime" }, { taskId });
// outcome: { handled, name, pluginId, result }                       ran
//          { handled: true, denied: true, deniedBy, error, result: null }   a guard refused it
//          { handled: false, name, result: null }                          no such tool
```

`listTools()` returns each tool's `name`, `description`, `parameters` (a JSON Schema object, as registered), `risk`, `scopes` and `pluginId`. `executeTool` passes the context through to the tool handler as its second argument, with `callerPluginId` added. A handler's exception reaches the caller.

Without the permission, `listTools()` returns `[]`, `executeTool` rejects, and a plugin failure is recorded.

## Tool guards and observers

Every call through `executeTool`, from a plugin or from the host, now runs two hooks.

**`tool:before-execute`** sees `{ name, pluginId, risk, args, context }` before the tool runs. A handler returns:

- `{ deny: true, reason }` to refuse the call. The tool does not run, and the caller gets `denied: true` with the reason.
- `{ args }` to run the call with replacement arguments.
- nothing, to allow it unchanged.

Unlike every other hook, this one **fails closed**. A guard that throws or times out denies the call, and the failure is recorded against the guard's plugin. A broken guard must never silently allow what it was installed to stop.

**`tool:after-execute`** sees `{ name, pluginId, args, context, result, error }` after the tool runs, including when it throws. It is an ordinary hook. A handler that returns a payload with a `result` replaces the result the caller receives, which is how a plugin redacts secrets before a model sees tool output. Thrown errors are re-thrown to the caller after the observers run.

```js
// manifest.permissions.hooks: ["tool:before-execute", "tool:after-execute"]
api.addHook("tool:before-execute", ({ name, args }) =>
  name === "run_shell" && /\bshutdown\b/.test(args.command) ? { deny: true, reason: "use request_maintenance" } : undefined);
api.addHook("tool:after-execute", (payload) => ({ ...payload, result: redact(payload.result) }));
```

## Standard hooks

Core now emits lifecycle hooks (`runtime:startup`, `runtime:tick:1m`, `runtime:tick:5m`, `runtime:shutdown`, started by `pluginManager.startLifecycle()`), a `tool:execute-started` observer, and a `callId` shared by every hook of one tool call and returned in the outcome. Together with the task hooks the reference `agent-runtime` emits, they form the standard set documented in [hooks.md](hooks.md) and exported as `genesis-runtime/standard-hooks`. `cognition` and `memory` use them to follow agent tasks on their own.

## Deployment settings

| Variable | Default | Effect |
|---|---|---|
| `GENESIS_PROTECT_API_READS` | off | `1` makes `GET`/`HEAD` requests under `/api` require the admin token too, not only writes. `/api/ui/settings` and the existing public paths stay open. Use it when plugin data is private, such as task transcripts. |
| `GENESIS_ADMIN_TOKEN` | random per start | A fixed admin token, so a trusted local service can call admin routes across restarts. Keep it out of images and source. |
| `GENESIS_CONFIG_FILE` | `runtime-data/app-config.json` if present | A JSON file that plugins read with `api.getAppConfig()`. Until 1.7 the bundled server always passed `{}`. It holds settings, never secrets: point to credential files instead. A named file that cannot be read stops startup. |

The first two are also options of `createAdminSecurity` (`protectReads`, `publicReadPaths`, `adminUiToken`).

