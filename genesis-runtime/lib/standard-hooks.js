// The standard hooks: names Genesis core and the reference agent runtime emit, so plugins can
// subscribe to an agent's lifecycle without knowing which plugin drives it. A plugin still lists
// each hook it subscribes to in manifest.permissions.hooks. See docs/hooks.md.
//
// kind:
//   guard     - fails closed; a handler returns { deny, reason } (or replacement args). Throwing denies.
//   transform - a handler returns a replacement payload; a throwing handler is skipped.
//   observer  - a handler's return value is ignored except where noted; a throwing handler is skipped.

export const STANDARD_HOOKS = Object.freeze({
  "runtime:startup": { emitter: "core", kind: "observer", payload: "{ at, coreVersion }", when: "once, after every plugin is initialised and routes are registered" },
  "runtime:tick:1m": { emitter: "core", kind: "observer", payload: "{ at, interval }", when: "every minute; a tick still running is not overlapped" },
  "runtime:tick:5m": { emitter: "core", kind: "observer", payload: "{ at, interval }", when: "every five minutes; idle-time maintenance belongs here" },
  "runtime:shutdown": { emitter: "core", kind: "observer", payload: "{ at, reason }", when: "once, before plugins are disabled" },

  "tool:before-execute": { emitter: "core", kind: "guard", payload: "{ callId, name, pluginId, risk, args, context }", when: "before every executeTool call" },
  "tool:execute-started": { emitter: "core", kind: "observer", payload: "{ callId, name, pluginId, args, context }", when: "after guards allow a call, just before the tool runs" },
  "tool:after-execute": { emitter: "core", kind: "transform", payload: "{ callId, name, pluginId, args, context, result, error }", when: "after the tool returns or throws; a returned result replaces the caller's" },

  "queue:task-created": { emitter: "agent-runtime", kind: "observer", payload: "{ taskId, task }", when: "a task is saved (not on a deduplicated repeat)" },
  "queue:task-dispatch-started": { emitter: "agent-runtime", kind: "observer", payload: "{ taskId, task }", when: "the worker picks a task up, before any prompt is built" },
  "worker:prompt:build": { emitter: "agent-runtime", kind: "transform", payload: "{ taskId, task, systemPrompt, context, contextMessages, tools }", when: "once per task, before the first model call; append to contextMessages, narrow tools" },
  "worker:cycle-completed": { emitter: "agent-runtime", kind: "observer", payload: "{ taskId, task, iteration, toolCalls: [{ callId?, name, ok }], madeProgress, final }", when: "after each model turn and the tool calls it made" },
  "queue:task-processed": { emitter: "agent-runtime", kind: "observer", payload: "{ taskId, task }", when: "a task reaches done, failed or interrupted" }
});

export const STANDARD_HOOK_NAMES = Object.freeze(Object.keys(STANDARD_HOOKS));
