import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGenesisPluginManager } from "./plugin-system.js";

test("embedded hosts provide capabilities and shut plugins down cleanly", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-host-test-"));
  let disabled = false;
  const manager = createGenesisPluginManager({
    fs,
    path,
    runtimeRoot,
    profile: {},
    hostCapabilities: { "host:value": () => 42 }
  });
  manager.use(() => ({
    id: "host-consumer",
    name: "Host Consumer",
    version: "1.0.0",
    manifest: {
      schemaVersion: 1,
      permissions: {
        routes: false,
        uiPanels: false,
        data: false,
        capabilities: ["consumer:value"],
        hooks: [],
        runtimeContext: [],
        tools: []
      },
      compatibility: { coreApiMin: "1.4.0", coreApiMax: "" },
      dependencies: { requiredCapabilities: ["host:value"], optionalCapabilities: [] },
      security: { isolation: "inprocess" }
    },
    init(api) {
      const hostValue = api.getCapability("host:value");
      api.provideCapability("consumer:value", () => hostValue());
    },
    onDisable() {
      disabled = true;
    }
  }));

  try {
    await manager.initialize();
    assert.equal(manager.getCapability("consumer:value")(), 42);
    const provider = manager.listCapabilityProviders("host:value")[0];
    assert.equal(provider.pluginId, "host");
    assert.equal(provider.enabled, true);
    assert.equal(provider.host, true);
    assert.equal(manager.listPlugins()[0].failureCount, 0);
    await manager.shutdown();
    assert.equal(disabled, true);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("registered tool handlers execute directly and legacy tools retain hook dispatch", async () => {
  const manager = createGenesisPluginManager({ profile: {} });
  manager.use(() => ({
    id: "tool-provider",
    name: "Tool Provider",
    version: "1.0.0",
    manifest: {
      schemaVersion: 1,
      permissions: {
        routes: false,
        uiPanels: false,
        data: false,
        capabilities: [],
        hooks: ["intake:tool-call"],
        runtimeContext: [],
        tools: ["direct_tool", "legacy_tool"]
      },
      compatibility: { coreApiMin: "1.4.0", coreApiMax: "" },
      dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
      security: { isolation: "inprocess" }
    },
    init(api) {
      api.registerTool({ name: "direct_tool" }, async (args) => ({ value: args.value }));
      api.registerTool({ name: "legacy_tool" });
      api.addHook("intake:tool-call", async (payload) => payload.name === "legacy_tool"
        ? { ...payload, handled: true, result: { legacy: payload.args.value } }
        : payload);
    }
  }));

  await manager.initialize();
  assert.deepEqual(await manager.executeTool("direct_tool", { value: 7 }), {
    handled: true, name: "direct_tool", pluginId: "tool-provider", result: { value: 7 }
  });
  assert.deepEqual(await manager.executeTool("legacy_tool", { value: 9 }), {
    handled: true, name: "legacy_tool", pluginId: "tool-provider", result: { legacy: 9 }
  });
  assert.equal((await manager.executeTool("missing_tool")).handled, false);
});

test("a plugin's declared topics are normalised and reported with its manifest", async () => {
  const manager = createGenesisPluginManager({ profile: {} });
  manager.use(() => ({
    id: "topical",
    name: "Topical",
    version: "1.0.0",
    manifest: {
      schemaVersion: 1,
      permissions: { routes: false, uiPanels: false, data: false, capabilities: [], hooks: [], runtimeContext: [], tools: [] },
      compatibility: { coreApiMin: "1.5.0", coreApiMax: "" },
      dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
      security: { isolation: "inprocess" },
      topics: { keywords: [" LinkedIn ", "Reddit", "LinkedIn", ""], examples: ["Draft  a post\nfor LinkedIn"] }
    },
    init() {}
  }));
  await manager.initialize();
  const [plugin] = manager.listPlugins();
  assert.equal(plugin.coreApiVersion, "1.5.0");
  assert.deepEqual(plugin.manifest.topics, { keywords: ["LinkedIn", "Reddit"], examples: ["Draft a post for LinkedIn"] });
  await manager.shutdown();
});
