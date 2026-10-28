import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGenesisPluginManager } from "./plugin-system.js";

const manifest = ({ tools = [], hooks = [], toolUse = false } = {}) => ({
  schemaVersion: 1,
  permissions: { routes: false, uiPanels: false, data: false, capabilities: [], hooks, runtimeContext: [], tools, toolUse },
  compatibility: { coreApiMin: "1.7.0", coreApiMax: "" },
  dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
  security: { isolation: "inprocess" }
});

const echoPlugin = (calls = []) => ({
  id: "echo",
  name: "Echo",
  version: "1.0.0",
  manifest: manifest({ tools: ["echo"] }),
  init(api) {
    api.registerTool({ name: "echo", description: "Echo text.", parameters: { type: "object", properties: { text: { type: "string" } } } },
      (args) => { calls.push(args); return `echo:${args.text}`; });
  }
});

const agentPlugin = ({ toolUse = true, onApi } = {}) => ({
  id: "agent",
  name: "Agent",
  version: "1.0.0",
  manifest: manifest({ toolUse }),
  init(api) { onApi(api); }
});

const guardPlugin = (guard, { after } = {}) => ({
  id: "guard",
  name: "Guard",
  version: "1.0.0",
  manifest: manifest({ hooks: ["tool:before-execute", "tool:after-execute"] }),
  init(api) {
    api.addHook("tool:before-execute", guard);
    if (after) api.addHook("tool:after-execute", after);
  }
});

async function withManager(plugins, run) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-tool-use-"));
  const manager = createGenesisPluginManager({ fs, path, runtimeRoot, profile: {} });
  for (const plugin of plugins) manager.use(() => plugin);
  try {
    await manager.initialize();
    await run(manager);
  } finally {
    await manager.shutdown();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}

test("a plugin with toolUse lists and executes other plugins' tools", async () => {
  const calls = [];
  let api;
  await withManager([echoPlugin(calls), agentPlugin({ onApi: (value) => { api = value; } })], async () => {
    assert.deepEqual(api.listTools().map((tool) => tool.name), ["echo"]);
    const outcome = await api.executeTool("echo", { text: "hi" });
    assert.equal(outcome.handled, true);
    assert.equal(outcome.result, "echo:hi");
    assert.deepEqual(calls, [{ text: "hi" }]);
  });
});

test("tool use needs the toolUse permission", async () => {
  let api;
  await withManager([echoPlugin(), agentPlugin({ toolUse: false, onApi: (value) => { api = value; } })], async (manager) => {
    assert.deepEqual(api.listTools(), []);
    await assert.rejects(() => api.executeTool("echo", { text: "hi" }), /not permitted/);
    assert.ok(manager.listPlugins().find((plugin) => plugin.id === "agent").failureCount > 0);
  });
});

test("a guard can deny a call, and the tool never runs", async () => {
  const calls = [];
  let api;
  const guard = guardPlugin((call) => (call.args.text === "rm" ? { deny: true, reason: "no" } : undefined));
  await withManager([echoPlugin(calls), guard, agentPlugin({ onApi: (value) => { api = value; } })], async () => {
    const denied = await api.executeTool("echo", { text: "rm" });
    assert.equal(denied.denied, true);
    assert.equal(denied.deniedBy, "guard");
    assert.equal(denied.error, "no");
    assert.deepEqual(calls, []);
    assert.equal((await api.executeTool("echo", { text: "ok" })).result, "echo:ok");
  });
});

test("a guard that throws denies the call (fails closed)", async () => {
  const calls = [];
  let api;
  const guard = guardPlugin(() => { throw new Error("guard broke"); });
  await withManager([echoPlugin(calls), guard, agentPlugin({ onApi: (value) => { api = value; } })], async () => {
    const outcome = await api.executeTool("echo", { text: "hi" });
    assert.equal(outcome.denied, true);
    assert.match(outcome.error, /guard broke/);
    assert.deepEqual(calls, []);
  });
});

test("guards may rewrite arguments and observers may replace results", async () => {
  const calls = [];
  let api;
  let seenContext = null;
  const guard = guardPlugin((call) => { seenContext = call.context; return { args: { text: call.args.text.toUpperCase() } }; },
    { after: (payload) => ({ ...payload, result: String(payload.result).replace("SECRET", "[redacted]") }) });
  await withManager([echoPlugin(calls), guard, agentPlugin({ onApi: (value) => { api = value; } })], async () => {
    const outcome = await api.executeTool("echo", { text: "secret" }, { taskId: "t1" });
    assert.deepEqual(calls, [{ text: "SECRET" }]);
    assert.equal(outcome.result, "echo:[redacted]");
    assert.equal(seenContext.taskId, "t1");
    assert.equal(seenContext.callerPluginId, "agent");
  });
});
