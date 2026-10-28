import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGenesisPluginManager } from "./plugin-system.js";
import { STANDARD_HOOKS } from "./standard-hooks.js";

const manifest = ({ tools = [], hooks = [] } = {}) => ({
  schemaVersion: 1,
  permissions: { routes: false, uiPanels: false, data: false, capabilities: [], hooks, runtimeContext: [], tools },
  compatibility: { coreApiMin: "1.7.0", coreApiMax: "" },
  dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
  security: { isolation: "inprocess" }
});

async function withManager(plugins, run) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-hooks-"));
  const manager = createGenesisPluginManager({ fs, path, runtimeRoot, profile: {} });
  for (const plugin of plugins) manager.use(() => plugin);
  try {
    await manager.initialize();
    await run(manager);
  } finally {
    await manager.shutdown("test-end");
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}

const recorder = (names, seen) => ({
  id: "recorder", name: "Recorder", version: "1.0.0",
  manifest: manifest({ hooks: names }),
  init(api) {
    for (const name of names) api.addHook(name, (payload) => { seen.push({ name, payload }); return payload; });
  }
});

test("every tool call carries one callId through guard, start and result hooks", async () => {
  const seen = [];
  const tool = {
    id: "echo", name: "Echo", version: "1.0.0", manifest: manifest({ tools: ["echo", "boom"] }),
    init(api) {
      api.registerTool({ name: "echo", description: "", parameters: {} }, () => "ok");
      api.registerTool({ name: "boom", description: "", parameters: {} }, () => { throw new Error("boom"); });
    }
  };
  await withManager([tool, recorder(["tool:before-execute", "tool:execute-started", "tool:after-execute"], seen)], async (manager) => {
    const outcome = await manager.executeTool("echo", { a: 1 }, { taskId: "t1" });
    assert.deepEqual(seen.map((entry) => entry.name), ["tool:before-execute", "tool:execute-started", "tool:after-execute"]);
    assert.ok(outcome.callId);
    assert.ok(seen.every((entry) => entry.payload.callId === outcome.callId));
    assert.equal(seen[1].payload.context.taskId, "t1");
    seen.length = 0;
    await assert.rejects(() => manager.executeTool("boom", {}));
    assert.equal(seen.at(-1).payload.error, "boom");
  });
});

test("an observer that throws on tool:execute-started does not stop the call", async () => {
  const breaker = {
    id: "breaker", name: "Breaker", version: "1.0.0", manifest: manifest({ hooks: ["tool:execute-started"], tools: ["echo"] }),
    init(api) {
      api.registerTool({ name: "echo", description: "", parameters: {} }, () => "ok");
      api.addHook("tool:execute-started", () => { throw new Error("observer broke"); });
    }
  };
  await withManager([breaker], async (manager) => {
    assert.equal((await manager.executeTool("echo", {})).result, "ok");
  });
});

test("startLifecycle emits startup once and ticks without overlapping; shutdown is announced", async () => {
  const seen = [];
  let release;
  const slowTick = {
    id: "slow", name: "Slow", version: "1.0.0", manifest: manifest({ hooks: ["runtime:tick:1m"] }),
    init(api) { api.addHook("runtime:tick:1m", () => new Promise((resolve) => { release = resolve; })); }
  };
  await withManager([slowTick, recorder(["runtime:startup", "runtime:tick:1m", "runtime:shutdown"], seen)], async (manager) => {
    await manager.startLifecycle({ tickIntervals: { "runtime:tick:1m": 1000 } });
    await manager.startLifecycle({ tickIntervals: { "runtime:tick:1m": 1000 } });
    assert.equal(seen.filter((entry) => entry.name === "runtime:startup").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    // The slow handler holds the first tick open, so later ticks are skipped, not stacked.
    assert.equal(seen.filter((entry) => entry.name === "runtime:tick:1m").length, 0, "recorder runs after the slow handler");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.filter((entry) => entry.name === "runtime:tick:1m").length, 1);
  });
  assert.equal(seen.at(-1).name, "runtime:shutdown");
  assert.equal(seen.at(-1).payload.reason, "test-end");
});

test("the standard hook catalog names an emitter and kind for each hook", () => {
  for (const [name, entry] of Object.entries(STANDARD_HOOKS)) {
    assert.ok(["core", "agent-runtime"].includes(entry.emitter), name);
    assert.ok(["guard", "transform", "observer"].includes(entry.kind), name);
  }
});
