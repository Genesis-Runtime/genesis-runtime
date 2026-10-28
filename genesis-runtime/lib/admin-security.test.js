import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAdminSecurity } from "./admin-security.js";

async function withServer(options, run) {
  const app = express();
  const security = createAdminSecurity({ port: 0, adminUiToken: "admin-test-token", ...options });
  security.registerAdminSecurityMiddleware(app);
  app.get("/api/tasks", (_req, res) => res.json({ ok: true }));
  app.get("/api/ui/settings", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("reads under /api are open by default", async () => {
  await withServer({ protectReads: false }, async (base) => {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
  });
});

test("protectReads requires the admin token for reads, except public read paths", async () => {
  await withServer({ protectReads: true }, async (base) => {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 403);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { "x-admin-token": "wrong" } })).status, 403);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { "x-admin-token": "admin-test-token" } })).status, 200);
    assert.equal((await fetch(`${base}/api/ui/settings`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 404);
  });
});
