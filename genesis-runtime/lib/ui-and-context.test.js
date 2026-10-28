// Core API 1.6.0: the host home view, and scoped context providers.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createGenesisPluginManager } from "./plugin-system.js";
import { createNoopPluginManager } from "./plugin-loader.js";
import { profileManagerInternals } from "./profile-manager.js";
import { normalizeHomeView, resolveHomeView } from "./ui-settings.js";
import { matchDeclarativeScope, normalizeContextProviderDescriptor } from "./context-providers.js";

function manifest(permissions = {}) {
  return {
    schemaVersion: 1,
    permissions: { routes: false, uiPanels: true, data: false, capabilities: [], hooks: [], runtimeContext: [], tools: [], ...permissions },
    compatibility: { coreApiMin: "1.6.0", coreApiMax: "" },
    dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
    security: { isolation: "inprocess" }
  };
}

async function withManager(profile, plugins, body, options = {}) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-ui-context-"));
  const manager = createGenesisPluginManager({ fs, path, runtimeRoot, profile, ...options });
  for (const plugin of plugins) manager.use(() => plugin);
  try {
    await manager.initialize();
    await body(manager);
  } finally {
    await manager.shutdown();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}

const ordersPlugin = ({ home = true, homeView = true, contextProviders = ["history"], contextCollect = false, provide, match, onApi } = {}) => ({
  id: "orders",
  name: "Orders",
  version: "1.0.0",
  manifest: manifest({ homeView, contextProviders, contextCollect }),
  init(api) {
    api.registerUiPrimaryTab({ id: "main", title: "Orders", scriptUrl: "/api/plugin-ui/orders/tab.js", home });
    api.registerContextProvider({
      id: "history",
      title: "Order history",
      instruction: "Answer questions about these orders only from these notes.",
      ...(match ? { match } : {})
    }, provide ?? (({ message }) => (message.includes("ORD-1042") ? { notes: ["Order ORD-1042: delivered to the wrong address."], sources: ["ORD-1042"] } : null)));
    onApi?.(api);
  }
});

test("a home view may name a plugin tab, and the profile keeps it intact", () => {
  assert.equal(normalizeHomeView("plugin:Orders:Main"), "plugin:orders:main");
  assert.equal(normalizeHomeView(" World "), "world");
  assert.equal(normalizeHomeView("plugin:only-one-part"), "");
  const profile = profileManagerInternals.normalizeProfile({ id: "orders", ui: { homeView: "plugin:orders:main", defaultTab: "plugin:orders:main" }, context: { disabledProviders: ["a:b", "a:b"] } });
  assert.equal(profile.ui.homeView, "plugin:orders:main");
  assert.equal(profile.ui.defaultTab, "plugin-orders-main", "defaultTab still normalises, which is why homeView exists");
  assert.deepEqual(profile.context.disabledProviders, ["a:b"]);
});

test("home view precedence: env, then profile, then a permitted plugin claim, then defaults", () => {
  const tabs = [{ pluginId: "shop", id: "main" }, { pluginId: "other", id: "home" }];
  const claims = [{ pluginId: "other", view: "plugin:other:home", priority: 100, order: 2 }, { pluginId: "shop", view: "plugin:shop:main", priority: 50, order: 3 }];
  assert.equal(resolveHomeView({ env: {}, claims, primaryTabs: tabs, defaultHomeView: "world" }).homeView, "plugin:shop:main", "lower priority number wins");
  assert.equal(resolveHomeView({ env: {}, profile: { ui: { homeView: "tasks" } }, claims, primaryTabs: tabs }).source, "profile");
  assert.equal(resolveHomeView({ env: { GENESIS_HOME_VIEW: "plugin:other:home" }, profile: { ui: { homeView: "tasks" } }, claims, primaryTabs: tabs }).homeView, "plugin:other:home");
  const missing = resolveHomeView({ env: {}, profile: { ui: { homeView: "plugin:gone:main", defaultTab: "plugins" } }, primaryTabs: tabs, defaultHomeView: "world" });
  assert.equal(missing.homeView, "plugins");
  assert.equal(missing.unavailable[0].view, "plugin:gone:main");
  assert.deepEqual(resolveHomeView({ env: {}, defaultHomeView: "world" }), { homeView: "world", source: "host-default", homeTab: null, unavailable: [] });
});

test("a plugin claims the home view only with the homeView permission and while enabled", async () => {
  await withManager({ ui: { defaultTab: "plugins" } }, [ordersPlugin()], async (manager) => {
    const settings = manager.getUiSettings();
    assert.equal(settings.homeView, "plugin:orders:main");
    assert.equal(settings.homeViewSource, "plugin");
    assert.equal(settings.homeViewClaimedBy, "orders");
    assert.equal(settings.homeTab.title, "Orders");
    assert.equal(manager.listPlugins()[0].homeViewClaim, "plugin:orders:main");
  });
  await withManager({ ui: { defaultTab: "plugins" } }, [ordersPlugin({ homeView: false })], async (manager) => {
    assert.equal(manager.getUiSettings().homeView, "plugins");
    assert.ok(manager.listPlugins()[0].failures.some((failure) => failure.stage === "manifest:home-view-denied"));
  });
  await withManager({ disabledPlugins: ["orders"], ui: {} }, [ordersPlugin()], async (manager) => {
    assert.equal(manager.getUiSettings().homeView, "", "a disabled plugin's claim does not count");
  });
  await withManager({ ui: { homeView: "world" } }, [ordersPlugin()], async (manager) => {
    assert.equal(manager.getUiSettings().homeView, "world", "an explicit profile choice beats the claim");
  });
});

test("context is collected only from providers the message is in scope for", async () => {
  const quiet = {
    id: "calendar", name: "Calendar", version: "1.0.0", manifest: manifest({ contextProviders: true }),
    init(api) {
      api.registerContextProvider({ id: "events", title: "Calendar", match: { keywords: ["meeting", "calendar"] }, priority: 200 }, () => "Standup at 9am.");
    }
  };
  await withManager({}, [ordersPlugin(), quiet], async (manager) => {
    const named = await manager.collectContext({ message: "Where is ORD-1042?" });
    assert.deepEqual(named.sections.map((section) => section.key), ["orders:history"]);
    assert.match(named.text, /## Order history \(from Orders\)\nAnswer questions about these orders only from these notes\.\nOrder ORD-1042: delivered to the wrong address\./);
    assert.deepEqual(named.sections[0].sources, [{ id: "ORD-1042" }]);
    assert.deepEqual(named.skipped, [{ key: "calendar:events", reason: "out of scope" }]);

    const both = await manager.collectContext({ message: "Move my meetings for ORD-1042" });
    assert.deepEqual(both.sections.map((section) => section.key), ["orders:history", "calendar:events"], "priority order");
    assert.deepEqual(both.sections[1].scope.keywords, ["meeting"]);

    const neither = await manager.collectContext({ message: "What is the capital of France?" });
    assert.equal(neither.text, "");
    assert.deepEqual(neither.skipped.map((entry) => entry.reason).sort(), ["nothing in scope", "out of scope"]);

    assert.equal((await manager.collectContext({ message: "ORD-1042 meeting", exclude: ["orders:history"] })).sections.length, 1);
    assert.equal((await manager.collectContext({ message: "ORD-1042 meeting", providers: ["calendar:events"] })).sections[0].key, "calendar:events");
    assert.equal((await manager.collectContext({ message: "ORD-1042", audience: "worker" })).sections.length, 0, "providers default to the chat audience");
    assert.equal(manager.listContextProviders().length, 2);
  });
});

test("declarative patterns hand their matches to the provider", async () => {
  const seen = [];
  const plugin = ordersPlugin({
    match: { keywords: ["invoice"], patterns: ["\\b[A-Z]{2,}-\\d+\\b"] },
    provide: ({ scope }) => { seen.push(scope); return `Orders: ${scope.patterns.join(", ")}`; }
  });
  await withManager({}, [plugin], async (manager) => {
    const result = await manager.collectContext({ message: "Compare ORD-1042 with INV-77" });
    assert.match(result.text, /Orders: ORD-1042, INV-77/);
    assert.deepEqual(seen[0], { keywords: [], patterns: ["ORD-1042", "INV-77"], custom: null });
    assert.equal((await manager.collectContext({ message: "order of operations" })).sections.length, 0);
  });
  const normalized = normalizeContextProviderDescriptor("p", { id: "x", match: { keywords: ["Invoice"] } });
  assert.equal(matchDeclarativeScope(normalized, "two invoices are late").matched, true, "keywords match at a word start");
  assert.equal(matchDeclarativeScope(normalized, "reinvoiced").matched, false);
});

test("a failing, slow or unpermitted provider contributes nothing and never fails the call", async () => {
  const broken = {
    id: "broken", name: "Broken", version: "1.0.0", manifest: manifest({ contextProviders: ["throws", "slow"] }),
    init(api) {
      api.registerContextProvider({ id: "throws" }, () => { throw new Error("store down"); });
      api.registerContextProvider({ id: "slow" }, () => new Promise((resolve) => setTimeout(() => resolve("late"), 500)));
      assert.equal(api.registerContextProvider({ id: "undeclared" }, () => "x"), null);
    }
  };
  await withManager({ context: { disabledProviders: ["orders:history"] } }, [ordersPlugin(), broken], async (manager) => {
    const result = await manager.collectContext({ message: "ORD-1042", timeoutMs: 50 });
    assert.equal(result.sections.length, 0);
    assert.deepEqual(result.failures.map((failure) => failure.key).sort(), ["broken:slow", "broken:throws"]);
    assert.match(result.failures.find((failure) => failure.key === "broken:slow").error, /timed out/);
    assert.deepEqual(result.skipped, [{ key: "orders:history", reason: "disabled" }], "switched off by the profile");
    const failures = manager.listPlugins().find((plugin) => plugin.id === "broken").failures.map((failure) => failure.stage);
    assert.ok(failures.includes("manifest:context-provider-denied"));
    assert.ok(failures.includes("context:throws"));
  });
});

test("notes are bounded per provider and in total", async () => {
  const long = {
    id: "long", name: "Long", version: "1.0.0", manifest: manifest({ contextProviders: true }),
    init(api) {
      api.registerContextProvider({ id: "a", maxChars: 20, priority: 1 }, () => ["x".repeat(15), "y".repeat(15)]);
      api.registerContextProvider({ id: "b", priority: 2 }, () => "z".repeat(500));
    }
  };
  await withManager({}, [long], async (manager) => {
    const result = await manager.collectContext({ message: "anything", maxChars: 100 });
    assert.equal(result.sections[0].truncated, true);
    assert.equal(result.sections[0].notes.join("").length, 20);
    assert.deepEqual(result.skipped, [{ key: "long:b", reason: "context budget exhausted" }]);
  });
});

test("a plugin collects context only with the contextCollect permission", async () => {
  let api = null;
  await withManager({}, [ordersPlugin({ contextCollect: false, onApi: (value) => { api = value; } })], async (manager) => {
    assert.equal((await api.collectContext({ message: "ORD-1042" })).sections.length, 0);
    assert.ok(manager.listPlugins()[0].failures.some((failure) => failure.stage === "manifest:context-collect-denied"));
  });
  await withManager({}, [ordersPlugin({ contextCollect: true, onApi: (value) => { api = value; } })], async () => {
    assert.equal((await api.collectContext({ message: "ORD-1042" })).sections.length, 1);
    assert.equal(api.getUiSettings().homeView, "plugin:orders:main");
  });
});

test("hosts read both over HTTP, and a plugin-less host still answers ui settings", async () => {
  const app = express();
  app.use(express.json());
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-ui-http-"));
  const manager = createGenesisPluginManager({ app, fs, path, runtimeRoot, profile: {}, defaultHomeView: "world", validateAdminRequest: (req) => req.headers["x-admin"] === "yes" });
  manager.use(() => ordersPlugin());
  await manager.initialize();
  await manager.registerRoutes();
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const settings = await (await fetch(`${base}/api/ui/settings`)).json();
    assert.equal(settings.homeView, "plugin:orders:main");
    const denied = await fetch(`${base}/api/context/collect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "ORD-1042" }) });
    assert.equal(denied.status, 403);
    const collected = await (await fetch(`${base}/api/context/collect`, { method: "POST", headers: { "content-type": "application/json", "x-admin": "yes" }, body: JSON.stringify({ message: "ORD-1042" }) })).json();
    assert.equal(collected.sections[0].key, "orders:history");
    const providers = await (await fetch(`${base}/api/context/providers`, { headers: { "x-admin": "yes" } })).json();
    assert.equal(providers.providers[0].title, "Order history");
  } finally {
    server.close();
    await manager.shutdown();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }

  const noop = createNoopPluginManager({ profile: { ui: { homeView: "tasks" } }, defaultHomeView: "world" });
  assert.equal(noop.getUiSettings().homeView, "tasks");
  assert.deepEqual((await noop.collectContext({ message: "x" })).sections, []);
});
