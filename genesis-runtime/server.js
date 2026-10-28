import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadActiveProfile, getActiveProfile, defaultPreferencePath } from "./lib/profile-manager.js";
import { createAdminSecurity } from "./lib/admin-security.js";
import { createHttpHooks } from "./lib/http-hooks.js";
import { initializePluginManager } from "./lib/plugin-loader.js";

const CORE_VERSION = "1.8.0";
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRuntimeRoot = path.join(rootDir, "runtime-data");
const port = Number(process.env.PORT || 3300);

const sseClients = new Set();

function broadcast(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return;
  }
  console.log(text);
  const payload = `data: ${JSON.stringify({ message: text, at: Date.now() })}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Host app config (1.7): plugins read it with api.getAppConfig(). A JSON file named by
// GENESIS_CONFIG_FILE, or runtime-data/app-config.json when present. It holds settings, never
// secrets: credentials belong in the secrets store or in files the config points to.
async function loadAppConfig() {
  const configPath = String(process.env.GENESIS_CONFIG_FILE || "").trim() || path.join(pluginRuntimeRoot, "app-config.json");
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT" && !process.env.GENESIS_CONFIG_FILE) {
      return {};
    }
    throw new Error(`could not read app config ${configPath}: ${error.message}`);
  }
}

async function main() {
  await fs.mkdir(pluginRuntimeRoot, { recursive: true });
  const appConfig = Object.freeze(await loadAppConfig());
  await fs.mkdir(path.join(rootDir, "plugins"), { recursive: true });

  const profile = await loadActiveProfile({
    fs,
    rootDir,
    preferencePath: defaultPreferencePath(rootDir),
    logger: console
  });

  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/events/logs", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.flushHeaders?.();
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  let pluginManagerRef = null;
  const adminSecurity = createAdminSecurity({ port, isPublicRoute: (routePath) => pluginManagerRef?.isPublicRoute?.(routePath) === true });
  adminSecurity.registerAdminSecurityMiddleware(app);

  const { pluginManager, pluginLoadErrors } = await initializePluginManager({
    app,
    broadcast,
    fs,
    getAppConfig: () => appConfig,
    pathModule: path,
    profile,
    pluginRuntimeRoot,
    rootDir,
    runtimeContext: {},
    validateAdminRequest: adminSecurity.validateAdminRequest
  });

  pluginManagerRef = pluginManager;
  const httpHooks = createHttpHooks({ getPluginManager: () => pluginManager });
  app.use(httpHooks.requestTrackingMiddleware);

  await pluginManager.registerRoutes();

  // Static files come after plugin routes (1.8), so a plugin that serves an app at "/" wins;
  // without one, "/" is still Genesis's status page. Observer Compat is the shared
  // compatibility contract other orchestrators (Nova, Omega, ...) rely on, at a stable path so
  // browser-side plugin tabs can depend on it.
  app.use("/observer-compat", express.static(path.join(rootDir, "observer-compat")));
  app.use(express.static(path.join(rootDir, "public")));

  const startedAt = Date.now();
  app.get("/api/runtime/status", (req, res) => {
    res.json({
      ok: true,
      coreVersion: CORE_VERSION,
      nodeVersion: process.version,
      uptimeMs: Date.now() - startedAt,
      profile: { id: getActiveProfile().id, name: getActiveProfile().name },
      pluginLoadErrors
    });
  });

  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/compat", (req, res) => {
    res.json({
      ok: true,
      contract: "nova-observer/observer-compat",
      mountPath: "/observer-compat"
    });
  });

  await pluginManager.startLifecycle?.();

  const server = app.listen(port, () => {
    console.log(`[genesis] listening on http://127.0.0.1:${port} (profile: ${profile.id})`);
    if (pluginLoadErrors.length) {
      console.warn(`[genesis] ${pluginLoadErrors.length} plugin load error(s):`, pluginLoadErrors);
    }
  });

  const shutdown = (signal) => {
    console.log(`[genesis] received ${signal}, shutting down.`);
    for (const client of sseClients) {
      client.end();
    }
    server.close(async () => {
      await pluginManager.shutdown("genesis-server-shutdown");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[genesis] fatal startup error:", error);
  process.exit(1);
});
