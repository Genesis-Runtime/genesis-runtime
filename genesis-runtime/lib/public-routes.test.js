import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createAdminSecurity } from "./admin-security.js";
import { createGenesisPluginManager } from "./plugin-system.js";

const chatPlugin = (publicRoutes) => ({
  id: "chat", name: "Chat", version: "1.0.0",
  manifest: {
    schemaVersion: 1,
    permissions: { routes: true, uiPanels: false, data: false, capabilities: [], hooks: [], runtimeContext: [], tools: [], publicRoutes },
    compatibility: { coreApiMin: "1.8.0", coreApiMax: "" },
    dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
    security: { isolation: "inprocess" }
  },
  init() {},
  registerRoutes({ app }) {
    app.get("/", (_req, res) => res.send("chat app"));
    app.post("/api/chat", (_req, res) => res.json({ ok: true }));
    app.post("/api/chatroom", (_req, res) => res.json({ ok: true }));
    app.post("/api/plugins/install", (_req, res) => res.json({ ok: true }));
  }
});

async function withHost(publicRoutes, run) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-public-"));
  const app = express();
  let manager = null;
  const security = createAdminSecurity({ port: 0, adminUiToken: "t", protectReads: true, isPublicRoute: (p) => manager?.isPublicRoute(p) === true });
  security.registerAdminSecurityMiddleware(app);
  manager = createGenesisPluginManager({ fs, path, runtimeRoot, profile: {}, app });
  manager.use(() => chatPlugin(publicRoutes));
  await manager.initialize();
  await manager.registerRoutes();
  app.get("/", (_req, res) => res.send("genesis page"));
  const server = app.listen(0);
  try {
    await run(`http://127.0.0.1:${server.address().port}`, manager);
  } finally {
    server.close();
    await manager.shutdown();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}

test("a plugin's declared public routes skip the admin check; its other /api routes do not", async () => {
  await withHost(["/api/chat"], async (base, manager) => {
    assert.equal((await fetch(`${base}/api/chat`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${base}/api/chatroom`, { method: "POST" })).status, 403, "prefix matches whole path segments only");
    assert.deepEqual(manager.listPublicRoutes(), [{ pluginId: "chat", route: "/api/chat" }]);
  });
});

test("core routes cannot be made public", async () => {
  await withHost(["/api/plugins", "/api"], async (base, manager) => {
    assert.equal((await fetch(`${base}/api/plugins/install`, { method: "POST" })).status, 403);
    assert.deepEqual(manager.listPublicRoutes(), []);
    assert.ok(manager.listPlugins()[0].failureCount >= 2);
  });
});

test("a plugin's / is served before a later static page", async () => {
  await withHost([], async (base) => {
    assert.equal(await (await fetch(`${base}/`)).text(), "chat app");
  });
});
