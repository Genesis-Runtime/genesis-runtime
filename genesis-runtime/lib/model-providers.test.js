// Core API 1.6.0 model provider types: the contract a plugin such as Meterless registers,
// and the boundaries Genesis keeps around it (permissions, ids, secrets).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createGenesisPluginManager } from "./plugin-system.js";
import { createNoopPluginManager } from "./plugin-loader.js";

function manifest(permissions = {}) {
  return {
    schemaVersion: 1,
    permissions: { routes: false, uiPanels: false, data: false, capabilities: [], hooks: [], runtimeContext: [], tools: [], ...permissions },
    compatibility: { coreApiMin: "1.6.0", coreApiMax: "" },
    dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
    security: { isolation: "inprocess" }
  };
}

const echoProvider = (pluginId = "echo-plugin", { permitted = true, onApi } = {}) => ({
  id: pluginId,
  name: "Echo",
  version: "1.0.0",
  manifest: manifest({ modelProviders: permitted ? ["echo"] : [] }),
  init(api) {
    onApi?.(api);
    api.registerModelProvider({
      id: "echo",
      label: "Echo",
      defaults: { baseUrl: "http://echo", model: "echo-1" },
      fields: [{ id: "baseUrl", type: "url" }, { id: "bad id!" }, { id: "model", type: "select", optionsFrom: "probe" }],
      secrets: ["echo_key"],
      actions: [{ id: "ping", label: "Ping" }, { id: "unhandled" }]
    }, {
      normalizeConfig: (config) => {
        if (config.model === "nope") throw new TypeError("unknown model");
        return { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
      },
      probe: async (config, ctx) => ({ status: (await ctx.secrets.has("echo_key")) ? "online" : "unauthorized", models: ["echo-1", { id: "echo-2", description: "bigger" }] }),
      generate: async (config, request, ctx) => ({ text: `${config.model}:${request.messages.at(-1).content}:${await ctx.secrets.get("echo_key")}`, finishReason: "stop" }),
      actions: {
        ping: async (input) => ({ pong: input.value ?? null }),
        steal: async (_input, ctx) => ctx.secrets.get("other_key")
      }
    });
  }
});

async function withManager(plugins, body, { secrets = new Map(), app = null, profile = {}, validateAdminRequest = null } = {}) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-model-providers-"));
  const manager = createGenesisPluginManager({
    app, fs, path, runtimeRoot, profile, validateAdminRequest,
    hostCapabilities: {
      "secrets:get": async ({ handle }) => secrets.get(handle) ?? null,
      "secrets:set": async ({ handle, value }) => { secrets.set(handle, value); }
    }
  });
  for (const plugin of plugins) manager.use(() => plugin);
  try {
    await manager.initialize();
    await body(manager, secrets);
  } finally {
    await manager.shutdown();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}

test("a registered provider type is described for model editors and generates", async () => {
  await withManager([echoProvider()], async (manager, secrets) => {
    const [provider] = manager.listModelProviders();
    assert.equal(provider.id, "echo");
    assert.equal(provider.pluginName, "Echo");
    assert.deepEqual(provider.fields.map((field) => field.id), ["baseUrl", "model"], "malformed fields are dropped");
    assert.deepEqual(provider.actions.map((action) => action.id), ["ping"], "actions without a handler are dropped");
    assert.equal(provider.probe, true);
    assert.equal(manager.listPlugins()[0].modelProviders[0].id, "echo");

    assert.deepEqual(await manager.normalizeModelProviderConfig("echo", { baseUrl: "http://other/" }), { baseUrl: "http://other", model: "echo-1", provider: "echo" });
    assert.equal((await manager.probeModelProvider("echo", {})).status, "unauthorized");
    assert.equal((await manager.probeModelProvider("echo", { model: "nope" })).detail, "unknown model", "a probe never throws");

    assert.deepEqual(await manager.setModelProviderSecret("echo", "echo_key", "k1"), { handle: "echo_key", stored: true });
    assert.equal(secrets.get("echo_key"), "k1");
    const probe = await manager.probeModelProvider("echo", {});
    assert.equal(probe.status, "online");
    assert.deepEqual(probe.models, [{ id: "echo-1" }, { id: "echo-2", description: "bigger" }]);

    const completion = await manager.generateWithModelProvider("echo", {}, { prompt: "hi" });
    assert.deepEqual(completion, { text: "echo-1:hi:k1", finishReason: "stop" });
    assert.deepEqual(await manager.runModelProviderAction("echo", "ping", { value: 3 }), { pong: 3 });
    await assert.rejects(manager.generateWithModelProvider("missing", {}, {}), /Unknown model provider/);
  });
});

test("secrets are limited to declared handles and fall back to the environment", async () => {
  await withManager([echoProvider()], async (manager) => {
    await assert.rejects(manager.setModelProviderSecret("echo", "other_key", "x"), /did not declare secret other_key/);
    await assert.rejects(manager.setModelProviderSecret("echo", "echo_key", "  "), /value is required/);
    process.env.echo_key = "from-env";
    try {
      assert.equal((await manager.generateWithModelProvider("echo", {}, { prompt: "a" })).text, "echo-1:a:from-env");
    } finally {
      delete process.env.echo_key;
    }
  });
});

test("registration needs the modelProviders permission, ids are global, and use needs modelProviderUse", async () => {
  await withManager([echoProvider("denied", { permitted: false })], async (manager) => {
    assert.equal(manager.listModelProviders().length, 0);
    assert.ok(manager.listPlugins()[0].failures.some((failure) => failure.stage === "manifest:model-provider-denied"));
  });
  await withManager([echoProvider("first"), echoProvider("second")], async (manager) => {
    assert.equal(manager.listModelProviders()[0].pluginId, "first");
    assert.ok(manager.listPlugins().find((plugin) => plugin.id === "second").failures.some((failure) => failure.stage === "model-provider-duplicate"));
  });
  let api = null;
  await withManager([echoProvider("user", { onApi: (value) => { api = value; } })], async (manager) => {
    await assert.rejects(api.generateWithModelProvider("echo", {}, { prompt: "x" }), /not permitted/);
    assert.equal(api.listModelProviders().length, 1, "listing is open; using is not");
    assert.ok(manager.listPlugins()[0].failures.some((failure) => failure.stage === "manifest:model-provider-use-denied"));
  });
  await withManager([echoProvider("disabled")], async (manager) => {
    assert.equal(manager.listModelProviders().length, 0, "a disabled plugin's provider is not offered");
  }, { profile: { disabledPlugins: ["disabled"] } });
});

test("the routes are admin-only and never echo a secret", async () => {
  const app = express();
  app.use(express.json());
  await withManager([echoProvider()], async (manager, secrets) => {
    await manager.registerRoutes();
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (url, body, admin = true) => fetch(`${base}${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(admin ? { "x-admin": "yes" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    try {
      assert.equal((await call("/api/model-providers", undefined, false)).status, 403);
      assert.equal((await (await call("/api/model-providers")).json()).providers[0].id, "echo");
      const saved = await (await call("/api/model-providers/echo/secrets/echo_key", { value: "super-secret" })).text();
      assert.equal(saved.includes("super-secret"), false);
      assert.equal(secrets.get("echo_key"), "super-secret");
      assert.equal((await (await call("/api/model-providers/echo/probe", { config: {} })).json()).status, "online");
      assert.equal((await call("/api/model-providers/echo/secrets/other_key", { value: "x" })).status, 400);
      const generated = await (await call("/api/model-providers/echo/generate", { config: {}, request: { messages: [{ role: "user", content: "yo" }] } })).json();
      assert.equal(generated.completion.text, "echo-1:yo:super-secret");
      assert.equal((await call("/api/model-providers/echo/actions/steal", {})).status, 400, "only declared actions run");
    } finally {
      server.close();
    }
  }, { app, validateAdminRequest: (req) => req.headers["x-admin"] === "yes" });

  const noop = createNoopPluginManager();
  assert.deepEqual(noop.listModelProviders(), []);
  await assert.rejects(noop.generateWithModelProvider("echo"), /Unknown model provider/);
});
