# Standard hooks

Genesis has no built-in agent, but plugins still need to follow one: to remember what a task learned, to watch tool calls, to tidy up when the host is idle. The standard hooks are the shared vocabulary for that. Core emits the runtime and tool hooks; the reference `agent-runtime` plugin emits the task hooks. A plugin that subscribes to them works with any host and agent that emits them, and needs no code in the orchestrator.

The catalog is also exported as data: `import { STANDARD_HOOKS } from "genesis-runtime/standard-hooks"`.

A plugin lists every hook it subscribes to in `manifest.permissions.hooks`, then calls `api.addHook(name, handler, { priority })`. Lower priority numbers run first.

## Kinds

- **guard**: fails closed. A handler returns `{ deny: true, reason }` to refuse, `{ args }` to replace arguments, or nothing. A handler that throws or times out denies.
- **transform**: a handler returns the payload, changed or not. A handler that throws is skipped and recorded as a plugin failure.
- **observer**: return the payload unchanged. A handler that throws is skipped and recorded; it never affects the work it observes.

## Runtime (core)

| Hook | Kind | Payload | When |
|---|---|---|---|
| `runtime:startup` | observer | `{ at, coreVersion }` | Once, after every plugin is initialised and routes are registered |
| `runtime:tick:1m` | observer | `{ at, interval }` | Every minute |
| `runtime:tick:5m` | observer | `{ at, interval }` | Every five minutes. Idle-time maintenance belongs here |
| `runtime:shutdown` | observer | `{ at, reason }` | Once, before plugins are disabled |

Hosts start these with `pluginManager.startLifecycle()`; the bundled server does. A tick whose handlers are still running when the next one is due is skipped, not stacked, and tick timers never keep the process alive. Embedded hosts that never call `startLifecycle` get no ticks.

## Tools (core)

Every call through `executeTool`, from a plugin with `toolUse` or from the host, gets a `callId` that appears in all three hooks and in the outcome.

| Hook | Kind | Payload | When |
|---|---|---|---|
| `tool:before-execute` | guard | `{ callId, name, pluginId, risk, args, context }` | Before the tool runs |
| `tool:execute-started` | observer | `{ callId, name, pluginId, args, context }` | After the guards allow it, just before it runs |
| `tool:after-execute` | transform | `{ callId, name, pluginId, args, context, result, error }` | After it returns or throws. A returned `result` replaces what the caller gets |

`context` is whatever the caller passed. The agent runtime passes `{ taskId, task, signal, deadline }` plus `callerPluginId`.

Order observers that read results after transforms that change them: a redactor at priority 900, a recorder at 950.

## Tasks (agent-runtime)

| Hook | Kind | Payload | When |
|---|---|---|---|
| `queue:task-created` | observer | `{ taskId, task }` | A task is saved. Not repeated for a deduplicated submission |
| `queue:task-dispatch-started` | observer | `{ taskId, task }` | The worker picks the task up, before any prompt is built |
| `worker:prompt:build` | transform | `{ taskId, task, systemPrompt, context, contextMessages, tools }` | Once per task, before the first model call. Append `{ content }` entries to `contextMessages`; narrow `tools` |
| `worker:cycle-completed` | observer | `{ taskId, task, iteration, toolCalls: [{ callId?, name, ok }], madeProgress, final }` | After each model turn and the tool calls it made |
| `queue:task-processed` | observer | `{ taskId, task }` | The task reaches `done`, `failed` or `interrupted` |

A task record has `id, status, request, source, author, metadata, plan, actions, result, error, usage`. `result.stoppedEarly` is set when a guard ended tool use and the answer came from a tool-free wrap-up.

## Who uses them

| Plugin | Hooks |
|---|---|
| `server-ops` | `tool:before-execute` (operations policy), `tool:after-execute` (redaction and audit), `worker:prompt:build`, task hooks for the audit log |
| `cognition` | Every task hook, `tool:execute-started`, `tool:after-execute`, `runtime:tick:5m`: a cognitive worker per task, tool predictions and outcomes, and episodes kept as shared memory |
| `memory` | `queue:task-processed` (success and repair lessons), `worker:prompt:build` (related lessons) |
| `agent-notes` | Context provider, audience `worker` (collected before `worker:prompt:build`) |

## Older names

Nova-era plugins also listen for `runtime:tick:cron`, `intake:tool-call`, `plugin:tool-completed` and similar host-specific hooks. Genesis core emits `intake:tool-call` only as the fallback for tools registered without a handler; the others come from Nova's host and are not part of this set.
