import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  filterToolsByProfile,
  isPluginHiddenByProfile,
  resolveProfilePluginState
} from "./profile-manager.js";
import { createPluginDataStore } from "./plugin-data-store.js";
import {
  listPluginUiEntries,
  normalizeUiPrimaryTabDescriptor,
  normalizeUiPanelDescriptor,
  normalizeUiSecretsTabDescriptor,
  normalizeUiSystemTabDescriptor,
  normalizeUiTabDescriptor
} from "./plugin-ui-descriptors.js";
import {
  CORE_PLUGIN_API_VERSION,
  DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
  canProcessAutoRestart,
  compareSemver,
  inferPluginPackageIdFromName,
  normalizePluginId,
  normalizePriority,
  sanitizePluginUploadName,
  sortByPriorityThenOrder,
  uniquePluginList
} from "./plugin-system-helpers.js";
import {
  hasManifestPermission,
  normalizeManifestPermissions,
  normalizePluginManifest
} from "../observer-compat/server/plugin-manifest.js";
import { normalizeResponsePanel, pluginViewId, resolveHomeView } from "./ui-settings.js";
import {
  CONTEXT_AUDIENCES,
  DEFAULT_CONTEXT_MAX_CHARS,
  assembleContext,
  describeContextProvider,
  matchDeclarativeScope,
  normalizeContextProviderDescriptor,
  normalizeContribution
} from "./context-providers.js";
import {
  describeModelProvider,
  normalizeCompletion,
  normalizeModelProviderDescriptor,
  normalizeProbe
} from "./model-providers.js";

const execFileAsync = promisify(execFile);
const MAX_TRACKED_PLUGIN_FAILURES = 500;

export function createGenesisPluginManager(context = {}) {
  const {
    app = null,
    broadcast = () => {},
    getAppConfig = () => ({}),
    runtimeRoot = "",
    fs = null,
    path = null,
    profile = null,
    runtimeContext = {},
    hostCapabilities = {},
    validateAdminRequest = null,
    // The view a host UI opens on when nothing else chooses one (see ui-settings.js).
    defaultHomeView = ""
  } = context;

  const pluginFactories = [];
  const activePlugins = [];
  // Core's own routes: no plugin may exempt them from admin protection.
  const RESERVED_ROUTE_PREFIXES = ["/api/plugins", "/api/admin-token", "/api/runtime", "/api/context", "/api/model-providers", "/api/ui", "/api/security", "/api/health", "/api/compat"];
  const routeCovers = (prefix, routePath) => routePath === prefix || routePath.startsWith(`${prefix}/`);
  const capabilities = new Map();
  const hooks = new Map();
  const tools = new Map();
  const toolHandlers = new Map();
  const uiPanels = new Map();
  const uiTabs = new Map();
  const uiPrimaryTabs = new Map();
  const uiSecretsTabs = new Map();
  const uiSystemTabs = new Map();
  const homeViewClaims = new Map();
  const contextProviders = new Map();
  const modelProviders = new Map();
  const regressionSuites = new Map();
  const internalRegressionRunners = new Map();
  const pluginRoutes = new Map();
  const failedPlugins = [];
  const pluginStateById = new Map();
  const knownPluginIds = new Set();
  const pluginRuntimeStatsById = new Map();
  const hookRuntimeStatsByName = new Map();
  let registrationSequence = 0;
  const pluginStatePath = runtimeRoot && path && typeof path.join === "function"
    ? path.join(runtimeRoot, "plugin-state.json")
    : "";
  const pluginDataRoot = runtimeRoot && path && typeof path.join === "function"
    ? path.join(runtimeRoot, "data")
    : "";
  const pluginAuditPath = runtimeRoot && path && typeof path.join === "function"
    ? path.join(runtimeRoot, "plugin-audit.log")
    : "";
  const pluginTrustPolicyPath = runtimeRoot && path && typeof path.join === "function"
    ? path.join(runtimeRoot, "plugin-trust.json")
    : "";
  let pluginTrustPolicy = {
    mode: "permissive",
    allowlist: {}
  };
  let sharedRuntimeContext = runtimeContext && typeof runtimeContext === "object"
    ? { ...runtimeContext }
    : {};
  let activeProfile = profile && typeof profile === "object" ? profile : null;

  function registerHostCapabilities(entries = {}) {
    for (const [capabilityName, handler] of Object.entries(entries && typeof entries === "object" ? entries : {})) {
      const normalizedName = String(capabilityName || "").trim();
      if (!normalizedName || typeof handler !== "function") {
        continue;
      }
      const existing = capabilities.get(normalizedName) || [];
      existing.push({
        pluginId: "host",
        capability: normalizedName,
        handler,
        host: true,
        priority: 1,
        order: registrationSequence++
      });
      capabilities.set(normalizedName, existing);
    }
  }

  async function appendPluginAudit(event = {}) {
    if (!pluginAuditPath || !fs || typeof fs.appendFile !== "function" || !path) {
      return;
    }
    const payload = {
      at: Date.now(),
      ...event
    };
    try {
      await fs.mkdir(path.dirname(pluginAuditPath), { recursive: true });
      await fs.appendFile(pluginAuditPath, `${JSON.stringify(payload)}\n`, "utf8");
    } catch (err) {
      console.error("[genesis] plugin audit write failed:", err?.message || err);
    }
  }

  async function loadPluginTrustPolicy() {
    if (!pluginTrustPolicyPath || !fs || typeof fs.readFile !== "function") {
      return;
    }
    try {
      const raw = await fs.readFile(pluginTrustPolicyPath, "utf8");
      const parsed = JSON.parse(String(raw || "{}"));
      const mode = String(parsed?.mode || "permissive").trim().toLowerCase();
      const allowlist = parsed?.allowlist && typeof parsed.allowlist === "object"
        ? parsed.allowlist
        : {};
      pluginTrustPolicy = {
        mode: mode === "allowlist" ? "allowlist" : "permissive",
        allowlist
      };
    } catch {
      // Ignore trust policy read errors and stay permissive.
    }
  }

  async function savePluginTrustPolicy(nextPolicy = {}) {
    if (!pluginTrustPolicyPath || !fs || typeof fs.writeFile !== "function" || !path) {
      return pluginTrustPolicy;
    }
    const mode = String(nextPolicy?.mode || pluginTrustPolicy.mode || "permissive").trim().toLowerCase() === "allowlist"
      ? "allowlist"
      : "permissive";
    const allowlist = nextPolicy?.allowlist && typeof nextPolicy.allowlist === "object"
      ? nextPolicy.allowlist
      : pluginTrustPolicy.allowlist;
    pluginTrustPolicy = {
      mode,
      allowlist
    };
    try {
      await fs.mkdir(path.dirname(pluginTrustPolicyPath), { recursive: true });
      await fs.writeFile(pluginTrustPolicyPath, `${JSON.stringify(pluginTrustPolicy, null, 2)}\n`, "utf8");
    } catch (error) {
      recordPluginFailure("core", "savePluginTrustPolicy", error);
    }
    return pluginTrustPolicy;
  }

  function isPluginEnabled(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return false;
    }
    const explicit = pluginStateById.get(normalizedPluginId);
    return resolveProfilePluginState(activeProfile || {}, normalizedPluginId, explicit).enabled === true;
  }

  function pluginEnabledSource(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return "invalid";
    }
    return resolveProfilePluginState(activeProfile || {}, normalizedPluginId, pluginStateById.get(normalizedPluginId)).source;
  }

  function isPluginVisible(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    return Boolean(normalizedPluginId && !isPluginHiddenByProfile(activeProfile || {}, normalizedPluginId));
  }

  function setPluginEnabled(pluginId = "", enabled = true) {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return false;
    }
    pluginStateById.set(normalizedPluginId, enabled === true);
    knownPluginIds.add(normalizedPluginId);
    return true;
  }

  async function invokePluginLifecycleCallback(pluginId = "", callbackName = "", payload = {}) {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return;
    }
    const plugin = activePlugins.find((entry) => normalizePluginId(entry?.id || "") === normalizedPluginId);
    if (!plugin) {
      return;
    }
    const callback = plugin && typeof plugin[callbackName] === "function" ? plugin[callbackName] : null;
    if (!callback) {
      return;
    }
    try {
      await callback(payload);
    } catch (error) {
      recordPluginFailure(normalizedPluginId, `lifecycle:${callbackName}`, error);
    }
  }

  async function setPluginEnabledWithLifecycle(pluginId = "", enabled = true, source = "api") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return false;
    }
    const nextEnabled = enabled === true;
    const previousEnabled = isPluginEnabled(normalizedPluginId);
    if (previousEnabled === nextEnabled) {
      return previousEnabled;
    }
    const payload = {
      pluginId: normalizedPluginId,
      previousEnabled,
      enabled: nextEnabled,
      source: String(source || "api").trim() || "api",
      at: Date.now()
    };
    if (!nextEnabled) {
      await invokePluginLifecycleCallback(normalizedPluginId, "onDisable", payload);
    }
    setPluginEnabled(normalizedPluginId, nextEnabled);
    await savePluginState();
    if (nextEnabled) {
      await invokePluginLifecycleCallback(normalizedPluginId, "onEnable", payload);
    }
    await appendPluginAudit({
      kind: "plugin_toggled",
      pluginId: normalizedPluginId,
      previousEnabled,
      enabled: nextEnabled,
      source: payload.source
    });
    await runHook("plugin:lifecycle:changed", payload);
    await runHook(nextEnabled ? "plugin:lifecycle:enabled" : "plugin:lifecycle:disabled", payload);
    return nextEnabled;
  }

  function buildPluginStatePayload() {
    return {
      knownPluginIds: [...knownPluginIds].sort((left, right) => left.localeCompare(right)),
      disabledPluginIds: [...pluginStateById.entries()]
        .filter(([, enabled]) => enabled === false)
        .map(([pluginId]) => pluginId)
        .sort((left, right) => left.localeCompare(right))
    };
  }

  async function loadPluginState() {
    if (!pluginStatePath || !fs || typeof fs.readFile !== "function") {
      return;
    }
    try {
      const raw = await fs.readFile(pluginStatePath, "utf8");
      const parsed = JSON.parse(String(raw || "{}"));
      const savedKnownPluginIds = Array.isArray(parsed?.knownPluginIds) ? parsed.knownPluginIds : [];
      for (const pluginId of savedKnownPluginIds) {
        const normalizedPluginId = normalizePluginId(pluginId);
        if (!normalizedPluginId) {
          continue;
        }
        knownPluginIds.add(normalizedPluginId);
      }
      const disabledPluginIds = Array.isArray(parsed?.disabledPluginIds) ? parsed.disabledPluginIds : [];
      for (const pluginId of disabledPluginIds) {
        const normalizedPluginId = normalizePluginId(pluginId);
        if (!normalizedPluginId) {
          continue;
        }
        knownPluginIds.add(normalizedPluginId);
        pluginStateById.set(normalizedPluginId, false);
      }
    } catch {
      // Missing or malformed plugin state should never block startup.
    }
  }

  async function savePluginState() {
    if (!pluginStatePath || !fs || typeof fs.writeFile !== "function") {
      return;
    }
    try {
      if (typeof fs.mkdir === "function" && path && typeof path.dirname === "function") {
        await fs.mkdir(path.dirname(pluginStatePath), { recursive: true });
      }
      await fs.writeFile(pluginStatePath, `${JSON.stringify(buildPluginStatePayload(), null, 2)}\n`, "utf8");
    } catch (error) {
      recordPluginFailure("core", "savePluginState", error);
    }
  }

  function pluginModulesRootPath() {
    if (!runtimeRoot || !path || typeof path.join !== "function") {
      return "";
    }
    return path.join(runtimeRoot, "modules");
  }

  function pluginInstallStagingRootPath() {
    if (!runtimeRoot || !path || typeof path.join !== "function") {
      return "";
    }
    return path.join(runtimeRoot, "install-staging");
  }

  async function removePathIfExists(targetPath = "") {
    if (!targetPath || !fs || typeof fs.rm !== "function") {
      return;
    }
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
  }

  async function listFilesRecursive(rootPath = "") {
    if (!rootPath || !fs || typeof fs.readdir !== "function" || !path) {
      return [];
    }
    const results = [];
    async function walk(currentPath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const absolutePath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
          continue;
        }
        if (entry.isFile()) {
          results.push(absolutePath);
        }
      }
    }
    await walk(rootPath);
    return results;
  }

  async function extractZipArchive(zipPath = "", destinationPath = "") {
    const platform = process.platform;
    if (platform === "win32") {
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        zipPath,
        "-DestinationPath",
        destinationPath,
        "-Force"
      ]);
      return;
    }
    try {
      await execFileAsync("unzip", ["-oq", zipPath, "-d", destinationPath]);
      return;
    } catch {
      await execFileAsync("tar", ["-xf", zipPath, "-C", destinationPath]);
    }
  }

  function scheduleProcessRestart(reason = "plugin_upload_restart") {
    if (!canProcessAutoRestart()) {
      throw new Error("automatic restart requires Genesis to run under PM2 or another restart supervisor");
    }
    setTimeout(() => {
      try {
        process.kill(process.pid, "SIGTERM");
      } catch (error) {
        console.error(`[genesis] failed to trigger restart for ${reason}:`, error && error.stack ? error.stack : String(error));
      }
    }, 250);
  }

  async function installUploadedPluginPackage(attachment = {}, options = {}) {
    if (!fs || !path || typeof fs.writeFile !== "function") {
      throw new Error("plugin installer filesystem support is unavailable");
    }
    const autoRestart = options?.autoRestart === true;
    const originalName = sanitizePluginUploadName(String(attachment?.name || "").trim(), "plugin-package");
    const contentBase64 = String(attachment?.contentBase64 || "").trim();
    if (!originalName || !contentBase64) {
      throw new Error("plugin attachment name and contentBase64 are required");
    }
    const lowerName = originalName.toLowerCase();
    const isZip = lowerName.endsWith(".zip");
    const isModuleFile = /\.(?:m?js|cjs)$/i.test(lowerName);
    if (!isZip && !isModuleFile) {
      throw new Error("plugin package must be a .js, .mjs, .cjs, or .zip file");
    }

    const modulesRoot = pluginModulesRootPath();
    const stagingRoot = pluginInstallStagingRootPath();
    if (!modulesRoot || !stagingRoot) {
      throw new Error("plugin runtime paths are unavailable");
    }
    await fs.mkdir(modulesRoot, { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });

    const installToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempRoot = path.join(stagingRoot, `plugin-install-${installToken}`);
    const packagePath = path.join(tempRoot, originalName);
    const extractRoot = path.join(tempRoot, "extracted");
    await fs.mkdir(tempRoot, { recursive: true });
    try {
      await fs.writeFile(packagePath, Buffer.from(contentBase64, "base64"));

      let pluginId = "";
      let sourceRoot = "";
      let entrypointName = "";

      if (isZip) {
        await fs.mkdir(extractRoot, { recursive: true });
        await extractZipArchive(packagePath, extractRoot);
        const extractedFiles = await listFilesRecursive(extractRoot);
        const pluginEntryFiles = extractedFiles.filter((filePath) => /-plugin\.(?:m?js|cjs)$/i.test(String(filePath || "")));
        if (pluginEntryFiles.length !== 1) {
          throw new Error(pluginEntryFiles.length
            ? "plugin zip must contain exactly one *-plugin.js entrypoint"
            : "plugin zip did not contain a *-plugin.js entrypoint");
        }
        const entrypointPath = pluginEntryFiles[0];
        entrypointName = String(path.basename(entrypointPath) || "").trim();
        pluginId = inferPluginPackageIdFromName(entrypointName);
        if (!pluginId) {
          throw new Error("could not infer plugin id from zip entrypoint");
        }
        sourceRoot = path.dirname(entrypointPath);
      } else {
        entrypointName = originalName;
        pluginId = inferPluginPackageIdFromName(originalName);
        if (!pluginId) {
          throw new Error("could not infer plugin id from module filename");
        }
        sourceRoot = tempRoot;
      }

      const installedIds = new Set(
        activePlugins
          .map((plugin) => ({
            id: normalizePluginId(plugin?.id || ""),
            modulePath: String(plugin?.modulePath || "").trim()
          }))
          .filter((plugin) => plugin.id)
          .filter((plugin) => !plugin.modulePath || !plugin.modulePath.startsWith(modulesRoot))
          .map((plugin) => plugin.id)
      );
      if (installedIds.has(pluginId)) {
        throw new Error(`plugin id ${pluginId} conflicts with an existing built-in or repo plugin`);
      }

      const targetRoot = path.join(modulesRoot, pluginId);
      await removePathIfExists(targetRoot);
      await fs.mkdir(targetRoot, { recursive: true });

      if (isZip) {
        await fs.cp(sourceRoot, targetRoot, { recursive: true, force: true });
      } else {
        await fs.copyFile(path.join(sourceRoot, entrypointName), path.join(targetRoot, entrypointName));
      }

      pluginStateById.set(pluginId, false);
      knownPluginIds.add(pluginId);
      await savePluginState();
      await appendPluginAudit({
        kind: "plugin_uploaded",
        pluginId,
        source: "ui-upload",
        packageName: originalName,
        installedPath: targetRoot
      }).catch(() => {});

      return {
        pluginId,
        packageName: originalName,
        entrypointName,
        installPath: targetRoot,
        enabled: false,
        restartRequired: true,
        autoRestartRequested: autoRestart,
        autoRestartSupported: canProcessAutoRestart(),
        autoRestartScheduled: false,
        message: autoRestart
          ? `Installed ${pluginId}. Automatic restart will be requested after this response, then enable it manually from the Plugins tab.`
          : `Installed ${pluginId}. Restart Genesis, then enable it manually from the Plugins panel.`
      };
    } finally {
      await removePathIfExists(tempRoot);
    }
  }

  function wrapPluginRouteHandler(pluginId = "", handler = null) {
    if (typeof handler !== "function") {
      return handler;
    }
    return async function pluginGatedRouteHandler(...args) {
      const req = args[0];
      const res = args[1];
      const startedAt = Date.now();
      const method = String(req?.method || "GET").trim().toUpperCase();
      const routePath = String(req?.path || req?.originalUrl || "").trim();
      await appendPluginAudit({
        kind: "plugin_route_started",
        pluginId,
        method,
        path: routePath
      });
      if (isPluginEnabled(pluginId)) {
        const result = await handler(...args);
        await appendPluginAudit({
          kind: "plugin_route_completed",
          pluginId,
          method,
          path: routePath,
          durationMs: Date.now() - startedAt,
          statusCode: Number(res?.statusCode || 0)
        });
        return result;
      }
      if (res && typeof res.status === "function" && typeof res.json === "function") {
        const response = res.status(503).json({
          ok: false,
          error: `plugin ${normalizePluginId(pluginId)} is disabled`
        });
        await appendPluginAudit({
          kind: "plugin_route_blocked_disabled",
          pluginId,
          method,
          path: routePath
        });
        return response;
      }
      return undefined;
    };
  }

  function wrapPluginRouteArgs(pluginId = "", args = []) {
    return args.map((arg) => {
      if (Array.isArray(arg)) {
        return arg.map((entry) => wrapPluginRouteHandler(pluginId, entry));
      }
      return wrapPluginRouteHandler(pluginId, arg);
    });
  }

  const {
    normalizePluginDataKey,
    resolvePluginDataPath,
    readPluginDataJson,
    writePluginDataJson,
    updatePluginDataJson
  } = createPluginDataStore({ pluginDataRoot, fs, path });

  function filterRuntimeContextForManifest(manifest = {}) {
    const rules = Array.isArray(manifest?.permissions?.runtimeContext)
      ? manifest.permissions.runtimeContext
      : [];
    if (!rules.length) {
      return {};
    }
    if (rules.includes("*")) {
      return { ...sharedRuntimeContext };
    }
    const allowed = {};
    for (const key of rules) {
      const normalized = String(key || "").trim();
      if (!normalized) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(sharedRuntimeContext, normalized)) {
        allowed[normalized] = sharedRuntimeContext[normalized];
      }
    }
    return allowed;
  }

  function pluginTrustedByPolicy(pluginMeta = {}) {
    if (pluginTrustPolicy.mode !== "allowlist") {
      return true;
    }
    const pluginId = normalizePluginId(pluginMeta?.id || "");
    const hash = String(pluginMeta?.moduleHash || "").trim().toLowerCase();
    const rule = pluginTrustPolicy.allowlist?.[pluginId];
    if (!rule) {
      return false;
    }
    if (Array.isArray(rule?.hashes)) {
      const hashes = rule.hashes.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
      return hashes.includes(hash);
    }
    if (typeof rule === "string") {
      return String(rule).trim().toLowerCase() === hash;
    }
    return false;
  }

  function getPluginHookTimeoutMs() {
    const fromEnv = Number(process.env.GENESIS_PLUGIN_HOOK_TIMEOUT_MS || DEFAULT_PLUGIN_HOOK_TIMEOUT_MS);
    if (!Number.isFinite(fromEnv)) {
      return DEFAULT_PLUGIN_HOOK_TIMEOUT_MS;
    }
    return Math.max(0, Math.min(120000, Math.round(fromEnv)));
  }

  async function withTimeout(promise, timeoutMs = 0, label = "plugin-hook") {
    if (!(timeoutMs > 0)) {
      return await promise;
    }
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  function updateRuntimeStats({
    pluginId = "",
    hookName = "",
    durationMs = 0,
    ok = true,
    error = ""
  } = {}) {
    const normalizedPluginId = normalizePluginId(pluginId);
    const normalizedHookName = String(hookName || "").trim();
    const elapsed = Math.max(0, Number(durationMs || 0));
    if (normalizedPluginId) {
      const current = pluginRuntimeStatsById.get(normalizedPluginId) || {
        hooksRun: 0,
        hooksFailed: 0,
        lastHookAt: 0,
        lastHookName: "",
        lastDurationMs: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
        lastError: ""
      };
      const nextRunCount = Number(current.hooksRun || 0) + 1;
      const nextAverage = nextRunCount <= 1
        ? elapsed
        : ((Number(current.averageDurationMs || 0) * Number(current.hooksRun || 0)) + elapsed) / nextRunCount;
      pluginRuntimeStatsById.set(normalizedPluginId, {
        hooksRun: nextRunCount,
        hooksFailed: Number(current.hooksFailed || 0) + (ok ? 0 : 1),
        lastHookAt: Date.now(),
        lastHookName: normalizedHookName,
        lastDurationMs: elapsed,
        averageDurationMs: Number(nextAverage.toFixed(2)),
        maxDurationMs: Math.max(Number(current.maxDurationMs || 0), elapsed),
        lastError: ok ? "" : String(error || "").trim()
      });
    }
    if (normalizedHookName) {
      const current = hookRuntimeStatsByName.get(normalizedHookName) || {
        calls: 0,
        failed: 0,
        lastAt: 0,
        lastDurationMs: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
        lastPluginId: "",
        lastError: ""
      };
      const nextCallCount = Number(current.calls || 0) + 1;
      const nextAverage = nextCallCount <= 1
        ? elapsed
        : ((Number(current.averageDurationMs || 0) * Number(current.calls || 0)) + elapsed) / nextCallCount;
      hookRuntimeStatsByName.set(normalizedHookName, {
        calls: nextCallCount,
        failed: Number(current.failed || 0) + (ok ? 0 : 1),
        lastAt: Date.now(),
        lastDurationMs: elapsed,
        averageDurationMs: Number(nextAverage.toFixed(2)),
        maxDurationMs: Math.max(Number(current.maxDurationMs || 0), elapsed),
        lastPluginId: normalizedPluginId,
        lastError: ok ? "" : String(error || "").trim()
      });
    }
  }

  function getPluginRuntimeStats(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return null;
    }
    return pluginRuntimeStatsById.get(normalizedPluginId) || null;
  }

  function isManifestCompatibleWithCore(manifest = {}) {
    const minVersion = String(manifest?.compatibility?.coreApiMin || "").trim();
    const maxVersion = String(manifest?.compatibility?.coreApiMax || "").trim();
    if (minVersion && compareSemver(CORE_PLUGIN_API_VERSION, minVersion) < 0) {
      return {
        ok: false,
        reason: `requires coreApiMin ${minVersion}, current ${CORE_PLUGIN_API_VERSION}`
      };
    }
    if (maxVersion && compareSemver(CORE_PLUGIN_API_VERSION, maxVersion) > 0) {
      return {
        ok: false,
        reason: `supports coreApiMax ${maxVersion}, current ${CORE_PLUGIN_API_VERSION}`
      };
    }
    return { ok: true, reason: "" };
  }

  function addPluginRoute(pluginId = "", method = "GET", routePath = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return;
    }
    const normalizedPath = String(routePath || "").trim();
    if (!normalizedPath) {
      return;
    }
    const normalizedMethod = String(method || "GET").trim().toUpperCase() || "GET";
    const existing = pluginRoutes.get(normalizedPluginId) || [];
    if (existing.some((entry) => entry.method === normalizedMethod && entry.path === normalizedPath)) {
      return;
    }
    existing.push({
      method: normalizedMethod,
      path: normalizedPath
    });
    pluginRoutes.set(normalizedPluginId, existing);
  }

  function buildPluginRouteAwareApp(pluginId = "") {
    if (!app) {
      return null;
    }
    const wrapped = Object.create(app);
    const methods = ["get", "post", "put", "patch", "delete", "head", "options", "all"];
    for (const method of methods) {
      if (typeof app[method] !== "function") {
        continue;
      }
      wrapped[method] = (...args) => {
        const routePath = args[0];
        if (typeof routePath === "string") {
          addPluginRoute(pluginId, method, routePath);
        }
        return app[method](...wrapPluginRouteArgs(pluginId, args));
      };
    }
    if (typeof app.use === "function") {
      wrapped.use = (...args) => {
        if (typeof args[0] === "string") {
          addPluginRoute(pluginId, "use", args[0]);
        }
        return app.use(...wrapPluginRouteArgs(pluginId, args));
      };
    }
    return wrapped;
  }

  function listPluginCapabilities(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return [];
    }
    const names = [];
    for (const [capabilityName, providers] of capabilities.entries()) {
      if ((providers || []).some((entry) => entry.pluginId === normalizedPluginId)) {
        names.push(capabilityName);
      }
    }
    return names.sort((left, right) => left.localeCompare(right));
  }

  function listPluginHooks(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return [];
    }
    const names = [];
    for (const [hookName, providers] of hooks.entries()) {
      if ((providers || []).some((entry) => entry.pluginId === normalizedPluginId)) {
        names.push(hookName);
      }
    }
    return names.sort((left, right) => left.localeCompare(right));
  }

  function listPluginRoutes(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return [];
    }
    const routes = pluginRoutes.get(normalizedPluginId) || [];
    return routes
      .slice()
      .sort((left, right) => {
        if (left.path === right.path) {
          return left.method.localeCompare(right.method);
        }
        return left.path.localeCompare(right.path);
      });
  }

  function recordPluginFailure(pluginId = "", stage = "", error = null) {
    const normalizedPluginId = normalizePluginId(pluginId) || "unknown";
    const normalizedStage = String(stage || "unknown").trim() || "unknown";
    const message = String(error?.message || error || "unknown error").trim() || "unknown error";
    const failure = {
      pluginId: normalizedPluginId,
      stage: normalizedStage,
      message,
      at: Date.now()
    };
    failedPlugins.push(failure);
    if (failedPlugins.length > MAX_TRACKED_PLUGIN_FAILURES) {
      failedPlugins.splice(0, failedPlugins.length - MAX_TRACKED_PLUGIN_FAILURES);
    }
    try {
      broadcast(`[genesis] plugin ${normalizedPluginId} ${normalizedStage} failed: ${message}`);
    } catch {
      // Ignore broadcast issues so plugin failures never block runtime.
    }
    appendPluginAudit({
      kind: "plugin_failure",
      pluginId: normalizedPluginId,
      stage: normalizedStage,
      message
    }).catch(() => {});
    return failure;
  }

  function listPluginFailures(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return failedPlugins.slice();
    }
    return failedPlugins.filter((entry) => entry.pluginId === normalizedPluginId);
  }

  function listPluginUiPanels(pluginId = "") {
    return listPluginUiEntries(uiPanels, pluginId);
  }

  function listPluginUiPrimaryTabs(pluginId = "") {
    return listPluginUiEntries(uiPrimaryTabs, pluginId);
  }

  function listPluginUiTabs(pluginId = "") {
    return listPluginUiEntries(uiTabs, pluginId);
  }

  function listPluginUiSecretsTabs(pluginId = "") {
    return listPluginUiEntries(uiSecretsTabs, pluginId);
  }

  function listPluginUiSystemTabs(pluginId = "") {
    return listPluginUiEntries(uiSystemTabs, pluginId);
  }

  function normalizeRegressionSuiteDescriptor(pluginId = "", suite = {}) {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId || !suite || typeof suite !== "object") {
      return null;
    }
    const suiteId = String(suite.id || "").trim();
    if (!suiteId) {
      return null;
    }
    const cases = Array.isArray(suite.cases)
      ? suite.cases.filter((entry) => entry && typeof entry === "object")
      : [];
    return {
      ...suite,
      id: suiteId,
      pluginId: normalizedPluginId,
      label: String(suite.label || suiteId).trim() || suiteId,
      description: String(suite.description || "").trim(),
      requiresIdleWorkerLane: suite.requiresIdleWorkerLane === true,
      cases
    };
  }

  function resolvePluginRegressionSuites(pluginId = "", context = {}) {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return [];
    }
    const registrations = regressionSuites.get(normalizedPluginId) || [];
    const suites = [];
    const seenSuiteIds = new Set();
    for (const registration of registrations) {
      try {
        const resolved = typeof registration?.resolve === "function"
          ? registration.resolve(context)
          : null;
        const suiteEntries = Array.isArray(resolved) ? resolved : [resolved];
        for (const suiteEntry of suiteEntries) {
          const normalizedSuite = normalizeRegressionSuiteDescriptor(normalizedPluginId, suiteEntry);
          if (!normalizedSuite || seenSuiteIds.has(normalizedSuite.id)) {
            continue;
          }
          seenSuiteIds.add(normalizedSuite.id);
          suites.push(normalizedSuite);
        }
      } catch (error) {
        recordPluginFailure(normalizedPluginId, "regression:suite", error);
      }
    }
    return suites;
  }

  function listPluginRegressionSuites(pluginId = "", context = {}) {
    return resolvePluginRegressionSuites(pluginId, context);
  }

  function listPluginInternalRegressionModes(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return [];
    }
    const modes = [];
    for (const [mode, handlers] of internalRegressionRunners.entries()) {
      if ((handlers || []).some((entry) => entry.pluginId === normalizedPluginId)) {
        modes.push(mode);
      }
    }
    return modes.sort((left, right) => left.localeCompare(right));
  }

  function buildPluginDescriptor(plugin = {}) {
    const capabilitiesForPlugin = listPluginCapabilities(plugin.id);
    const hooksForPlugin = listPluginHooks(plugin.id);
    const toolsForPlugin = filterToolsByProfile(listPluginTools(plugin.id), activeProfile || {});
    const routesForPlugin = listPluginRoutes(plugin.id);
    const uiPanelsForPlugin = listPluginUiPanels(plugin.id);
    const uiPrimaryTabsForPlugin = listPluginUiPrimaryTabs(plugin.id);
    const uiTabsForPlugin = listPluginUiTabs(plugin.id);
    const uiSecretsTabsForPlugin = listPluginUiSecretsTabs(plugin.id);
    const uiSystemTabsForPlugin = listPluginUiSystemTabs(plugin.id);
    const regressionSuitesForPlugin = listPluginRegressionSuites(plugin.id);
    const internalRegressionModesForPlugin = listPluginInternalRegressionModes(plugin.id);
    const failuresForPlugin = listPluginFailures(plugin.id);
    return {
      id: plugin.id,
      enabled: isPluginEnabled(plugin.id),
      enabledSource: pluginEnabledSource(plugin.id),
      hiddenByProfile: !isPluginVisible(plugin.id),
      coreApiVersion: CORE_PLUGIN_API_VERSION,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      manifest: plugin.manifest || null,
      modulePath: String(plugin.modulePath || "").trim(),
      moduleHash: String(plugin.moduleHash || "").trim(),
      capabilities: capabilitiesForPlugin,
      capabilityCount: capabilitiesForPlugin.length,
      hooks: hooksForPlugin,
      hookCount: hooksForPlugin.length,
      tools: toolsForPlugin,
      toolCount: toolsForPlugin.length,
      routes: routesForPlugin,
      routeCount: routesForPlugin.length,
      uiPanels: uiPanelsForPlugin,
      uiPanelCount: uiPanelsForPlugin.length,
      uiPrimaryTabs: uiPrimaryTabsForPlugin,
      uiPrimaryTabCount: uiPrimaryTabsForPlugin.length,
      uiTabs: uiTabsForPlugin,
      uiTabCount: uiTabsForPlugin.length,
      uiSecretsTabs: uiSecretsTabsForPlugin,
      uiSecretsTabCount: uiSecretsTabsForPlugin.length,
      uiSystemTabs: uiSystemTabsForPlugin,
      uiSystemTabCount: uiSystemTabsForPlugin.length,
      homeViewClaim: homeViewClaims.get(plugin.id)?.view || null,
      contextProviders: (contextProviders.get(plugin.id) || []).map(describeContextProvider),
      modelProviders: [...modelProviders.values()].filter((provider) => provider.pluginId === plugin.id).map(describeModelProvider),
      regressionSuiteCount: regressionSuitesForPlugin.length,
      internalRegressionModes: internalRegressionModesForPlugin,
      internalRegressionModeCount: internalRegressionModesForPlugin.length,
      failures: failuresForPlugin,
      failureCount: failuresForPlugin.length,
      runtime: getPluginRuntimeStats(plugin.id) || {
        hooksRun: 0,
        hooksFailed: 0,
        lastHookAt: 0,
        lastHookName: "",
        lastDurationMs: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
        lastError: ""
      }
    };
  }

  function getCapability(name = "") {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      return null;
    }
    const providers = sortByPriorityThenOrder(capabilities.get(normalizedName) || []);
    if (!providers.length) {
      return null;
    }
    const enabledProvider = providers.find((entry) => entry.host === true || isPluginEnabled(entry.pluginId));
    return enabledProvider ? enabledProvider.handler : null;
  }

  function listCapabilityProviders(name = "") {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      return [];
    }
    return sortByPriorityThenOrder(capabilities.get(normalizedName) || []).map((entry) => ({
      pluginId: entry.pluginId,
      capability: entry.capability,
      priority: Number(entry.priority || 100),
      enabled: entry.host === true || isPluginEnabled(entry.pluginId),
      host: entry.host === true
    }));
  }

  function normalizePluginToolDescriptor(pluginId = "", pluginName = "", descriptor = {}) {
    const name = String(descriptor?.name || "").trim();
    if (!name) {
      return null;
    }
    // Genesis core has no built-in notion of what a "scope" means — it's an opaque
    // label a plugin defines and a tool-invoking plugin can filter on. Applications
    // are free to establish their own scope vocabulary (e.g. "intake"/"worker").
    const providedScopes = Array.isArray(descriptor?.scopes)
      ? descriptor.scopes
      : [descriptor?.scope];
    const scopes = [...new Set(
      providedScopes
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter(Boolean)
    )];
    if (!scopes.length) {
      scopes.push("default");
    }
    const normalizedRisk = String(descriptor?.risk || "").trim().toLowerCase();
    return {
      name,
      description: String(descriptor?.description || "").trim(),
      scopes,
      parameters: descriptor?.parameters && typeof descriptor.parameters === "object" ? descriptor.parameters : {},
      risk: ["normal", "medium", "high", "approval"].includes(normalizedRisk) ? normalizedRisk : "normal",
      defaultApproved: descriptor?.defaultApproved !== false,
      source: "plugin",
      pluginId,
      pluginName: String(pluginName || pluginId).trim() || pluginId,
      order: registrationSequence++
    };
  }

  function listPluginTools(pluginId = "") {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (normalizedPluginId) {
      return filterToolsByProfile((tools.get(normalizedPluginId) || [])
        .slice()
        .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
        .map(({ order, ...tool }) => ({ ...tool })), activeProfile || {});
    }
    return activePlugins
      .filter((plugin) => isPluginEnabled(plugin.id))
      .filter((plugin) => isPluginVisible(plugin.id))
      .flatMap((plugin) => listPluginTools(plugin.id));
  }

  // Guards for a tool call: every "tool:before-execute" handler sees the call and may return
  // { deny: true, reason } or replacement { args }. Unlike ordinary hooks this fails closed:
  // a guard that throws or times out denies the call, because a broken guard must never
  // silently allow what it was installed to stop.
  async function runToolGuards(call = {}) {
    const handlers = sortByPriorityThenOrder(hooks.get("tool:before-execute") || []);
    let current = call;
    for (const handler of handlers) {
      if (!isPluginEnabled(handler.pluginId)) {
        continue;
      }
      const startedAt = Date.now();
      try {
        const verdict = await withTimeout(
          Promise.resolve().then(() => handler.handler({ ...current, args: { ...current.args } })),
          getPluginHookTimeoutMs(),
          `hook tool:before-execute for plugin ${handler.pluginId}`
        );
        updateRuntimeStats({ pluginId: handler.pluginId, hookName: "tool:before-execute", durationMs: Date.now() - startedAt, ok: true });
        if (verdict?.deny === true) {
          return { ...current, denied: true, deniedBy: handler.pluginId, reason: String(verdict.reason || "denied by policy").trim() };
        }
        if (verdict?.args && typeof verdict.args === "object" && !Array.isArray(verdict.args)) {
          current = { ...current, args: verdict.args };
        }
      } catch (error) {
        const errorText = String(error?.message || error || "unknown guard error");
        updateRuntimeStats({ pluginId: handler.pluginId, hookName: "tool:before-execute", durationMs: Date.now() - startedAt, ok: false, error: errorText });
        recordPluginFailure(handler.pluginId, "hook:tool:before-execute", errorText);
        return { ...current, denied: true, deniedBy: handler.pluginId, reason: `tool guard failed: ${errorText}` };
      }
    }
    return { ...current, denied: false };
  }

  async function executeTool(name = "", args = {}, context = {}) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      throw new TypeError("tool name is required");
    }
    const descriptor = listPluginTools().find((entry) => entry.name === normalizedName);
    if (!descriptor) {
      return { handled: false, name: normalizedName, result: null };
    }
    const callId = randomUUID();
    const guarded = await runToolGuards({
      callId,
      name: normalizedName,
      pluginId: descriptor.pluginId,
      risk: descriptor.risk,
      args: args && typeof args === "object" && !Array.isArray(args) ? args : {},
      context: context && typeof context === "object" ? context : {}
    });
    if (guarded.denied) {
      return { handled: true, denied: true, name: normalizedName, pluginId: descriptor.pluginId, deniedBy: guarded.deniedBy, error: guarded.reason, result: null };
    }
    const callArgs = guarded.args;
    // Observers (cognition, tracing) see the call start; the same callId arrives with the result.
    await runHook("tool:execute-started", { callId, name: normalizedName, pluginId: descriptor.pluginId, args: callArgs, context });
    let outcome;
    try {
      const handlerEntry = toolHandlers.get(`${descriptor.pluginId}:${normalizedName}`);
      if (handlerEntry && isPluginEnabled(handlerEntry.pluginId)) {
        const result = await handlerEntry.handler(callArgs, context);
        outcome = { handled: true, name: normalizedName, pluginId: handlerEntry.pluginId, result: result ?? null };
      } else {
        const hookResult = await runHook("intake:tool-call", {
          ...context,
          handled: false,
          name: normalizedName,
          args: callArgs,
          result: null
        });
        outcome = hookResult?.handled === true
          ? { handled: true, name: normalizedName, pluginId: String(hookResult.pluginId || descriptor.pluginId), result: hookResult.result ?? null }
          : { handled: false, name: normalizedName, pluginId: descriptor.pluginId, result: null };
      }
    } catch (error) {
      // Observers (audit, redaction) see failures too; the error still reaches the caller.
      await runHook("tool:after-execute", { callId, name: normalizedName, pluginId: descriptor.pluginId, args: callArgs, context, result: null, error: String(error?.message || error) });
      throw error;
    }
    if (outcome.handled) {
      // Observers may replace the result, for example to redact secrets before a model sees it.
      const after = await runHook("tool:after-execute", { callId, name: normalizedName, pluginId: outcome.pluginId, args: callArgs, context, result: outcome.result, error: "" });
      if (after && Object.prototype.hasOwnProperty.call(after, "result")) {
        outcome.result = after.result ?? null;
      }
    }
    return { ...outcome, callId };
  }

  function isPluginServing(pluginId = "") {
    return isPluginEnabled(pluginId) && isPluginVisible(pluginId);
  }

  function pluginNameFor(pluginId = "") {
    return activePlugins.find((plugin) => plugin.id === pluginId)?.name || pluginId;
  }

  // What a host UI needs at startup: its title, hidden tabs, and the resolved home view.
  function getUiSettings() {
    const primaryTabs = activePlugins.filter((plugin) => isPluginServing(plugin.id))
      .flatMap((plugin) => listPluginUiPrimaryTabs(plugin.id).map((tab) => ({ ...tab, pluginName: plugin.name })));
    const claims = [...homeViewClaims.values()].filter((claim) => isPluginServing(claim.pluginId));
    const resolved = resolveHomeView({ profile: activeProfile, claims, primaryTabs, defaultHomeView });
    return {
      title: String(activeProfile?.ui?.title || "Genesis").trim() || "Genesis",
      hiddenTabs: Array.isArray(activeProfile?.ui?.hiddenTabs) ? activeProfile.ui.hiddenTabs.slice() : [],
      homeView: resolved.homeView,
      homeViewSource: resolved.source,
      ...(resolved.claimedBy ? { homeViewClaimedBy: resolved.claimedBy } : {}),
      homeTab: resolved.homeTab,
      unavailableHomeViews: resolved.unavailable,
      responsePanel: normalizeResponsePanel(activeProfile?.ui?.responsePanel)
    };
  }

  function servingContextProviders(audience = "") {
    return sortByPriorityThenOrder(
      [...contextProviders.values()].flat()
        .filter((provider) => isPluginServing(provider.pluginId))
        .filter((provider) => !audience || provider.audiences.includes(audience))
    );
  }

  function listContextProviders({ audience = "" } = {}) {
    const disabled = new Set(Array.isArray(activeProfile?.context?.disabledProviders) ? activeProfile.context.disabledProviders : []);
    return servingContextProviders(audience).map((provider) => ({
      ...describeContextProvider(provider),
      pluginName: pluginNameFor(provider.pluginId),
      enabled: !disabled.has(provider.key)
    }));
  }

  // Collects the notes the message is in scope for, from every serving provider, in priority
  // order. A provider that fails or times out contributes nothing and never fails the call.
  async function collectContext(request = {}) {
    const message = String(request?.message ?? "").trim();
    const audience = CONTEXT_AUDIENCES.includes(request?.audience) ? request.audience : "chat";
    const empty = { audience, sections: [], text: "", chars: 0, skipped: [], failures: [] };
    if (!message) {
      return empty;
    }
    const only = Array.isArray(request.providers) && request.providers.length ? new Set(request.providers.map(String)) : null;
    const exclude = new Set([
      ...(Array.isArray(request.exclude) ? request.exclude.map(String) : []),
      ...(Array.isArray(activeProfile?.context?.disabledProviders) ? activeProfile.context.disabledProviders.map(String) : [])
    ]);
    const requestedTimeout = Number(request.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, 120000)
      : getPluginHookTimeoutMs();
    const requestedBudget = Number(request.maxChars);
    const maxChars = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.round(requestedBudget) : DEFAULT_CONTEXT_MAX_CHARS;
    const metadata = request.metadata && typeof request.metadata === "object" ? { ...request.metadata } : {};
    const skipped = [];
    const failures = [];

    const providers = servingContextProviders(audience);
    const outcomes = await Promise.all(providers.map(async (provider) => {
      if (only && !only.has(provider.key)) {
        return { skip: "not requested" };
      }
      if (exclude.has(provider.key)) {
        return { skip: "disabled" };
      }
      const declarative = matchDeclarativeScope(provider, message);
      if (declarative && !declarative.matched) {
        return { skip: "out of scope" };
      }
      const scope = { keywords: declarative?.keywords || [], patterns: declarative?.patterns || [], custom: null };
      const providerRequest = { message, audience, scope, metadata };
      try {
        if (provider.match.custom) {
          const custom = await withTimeout(
            Promise.resolve().then(() => provider.match.custom(providerRequest)),
            timeoutMs,
            `context scope ${provider.key}`
          );
          if (!custom) {
            return { skip: "out of scope" };
          }
          scope.custom = typeof custom === "object" ? custom : true;
        }
        const value = await withTimeout(
          Promise.resolve().then(() => provider.handler(providerRequest)),
          timeoutMs,
          `context provider ${provider.key}`
        );
        const contribution = normalizeContribution(provider, value);
        if (!contribution) {
          return { skip: "nothing in scope" };
        }
        return {
          section: {
            key: provider.key,
            pluginId: provider.pluginId,
            pluginName: pluginNameFor(provider.pluginId),
            providerId: provider.id,
            title: provider.title,
            scope,
            ...contribution
          }
        };
      } catch (error) {
        const text = String(error?.message || error || "unknown context provider error");
        recordPluginFailure(provider.pluginId, `context:${provider.id}`, text);
        return { failure: text };
      }
    }));

    const sections = [];
    outcomes.forEach((outcome, index) => {
      const key = providers[index].key;
      if (outcome.section) sections.push(outcome.section);
      else if (outcome.failure) failures.push({ key, error: outcome.failure });
      else skipped.push({ key, reason: outcome.skip });
    });
    const assembled = assembleContext(sections, maxChars);
    return {
      audience,
      sections: assembled.sections,
      text: assembled.text,
      chars: assembled.chars,
      skipped: [...skipped, ...assembled.omitted],
      failures
    };
  }

  function listModelProviders() {
    return [...modelProviders.values()]
      .filter((provider) => isPluginServing(provider.pluginId))
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((provider) => ({ ...describeModelProvider(provider), pluginName: pluginNameFor(provider.pluginId) }));
  }

  function requireModelProvider(providerId = "") {
    const provider = modelProviders.get(normalizePluginId(providerId));
    if (!provider || !isPluginServing(provider.pluginId)) {
      throw new TypeError(`Unknown model provider: ${String(providerId || "")}`);
    }
    return provider;
  }

  // What a provider's handlers receive. Secrets are limited to the handles it declared and
  // come from the installed secrets:* capabilities, falling back to an environment variable
  // of the same name (as hosts already allow for API keys).
  function modelProviderContext(provider, extra = {}) {
    const declared = new Set(provider.secrets.map((secret) => secret.handle));
    const allowed = (handle) => {
      const name = String(handle || "");
      if (!declared.has(name)) {
        throw new TypeError(`model provider ${provider.id} did not declare secret ${name}`);
      }
      return name;
    };
    const get = async (handle) => {
      const name = allowed(handle);
      const read = getCapability("secrets:get");
      const stored = read ? await read({ handle: name }) : null;
      return String(stored ?? "").trim() || String(process.env[name] ?? "").trim() || null;
    };
    return {
      pluginId: provider.pluginId,
      providerId: provider.id,
      secrets: {
        get,
        has: async (handle) => Boolean(await get(handle)),
        set: async (handle, value) => {
          const name = allowed(handle);
          const write = getCapability("secrets:set");
          if (!write) {
            throw new TypeError("No secret store is installed (secrets:set)");
          }
          await write({ handle: name, value: String(value ?? "") });
          return { handle: name, stored: true };
        }
      },
      ...extra
    };
  }

  async function normalizeModelProviderConfig(providerId = "", config = {}) {
    const provider = requireModelProvider(providerId);
    const merged = { ...structuredClone(provider.defaults), ...(config && typeof config === "object" ? config : {}), provider: provider.id };
    if (!provider.handlers.normalizeConfig) {
      return merged;
    }
    const normalized = await provider.handlers.normalizeConfig(merged, modelProviderContext(provider));
    return { ...(normalized && typeof normalized === "object" ? normalized : merged), provider: provider.id };
  }

  async function probeModelProvider(providerId = "", config = {}, options = {}) {
    const provider = requireModelProvider(providerId);
    if (!provider.handlers.probe) {
      return { status: "offline", models: [], detail: `${provider.label} cannot be probed` };
    }
    try {
      const normalized = await normalizeModelProviderConfig(provider.id, config);
      const result = await withTimeout(
        Promise.resolve().then(() => provider.handlers.probe(normalized, modelProviderContext(provider))),
        Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : getPluginHookTimeoutMs(),
        `model provider ${provider.id} probe`
      );
      return normalizeProbe(result);
    } catch (error) {
      return { status: "offline", models: [], detail: String(error?.message || error) };
    }
  }

  async function runModelProviderAction(providerId = "", actionId = "", input = {}) {
    const provider = requireModelProvider(providerId);
    const action = provider.handlers.actions[String(actionId || "")];
    if (!action) {
      throw new TypeError(`model provider ${provider.id} has no action ${String(actionId || "")}`);
    }
    return withTimeout(
      Promise.resolve().then(() => action(input && typeof input === "object" ? input : {}, modelProviderContext(provider))),
      getPluginHookTimeoutMs(),
      `model provider ${provider.id} action ${actionId}`
    );
  }

  async function setModelProviderSecret(providerId = "", handle = "", value = "") {
    const provider = requireModelProvider(providerId);
    if (!String(value ?? "").trim()) {
      throw new TypeError("A secret value is required");
    }
    return modelProviderContext(provider).secrets.set(handle, value);
  }

  // The call itself. The provider honours request.timeoutMs and request.signal; Genesis adds
  // no timeout of its own, since some runtimes take minutes to load a model.
  async function generateWithModelProvider(providerId = "", config = {}, request = {}) {
    const provider = requireModelProvider(providerId);
    const normalized = await normalizeModelProviderConfig(provider.id, config);
    const input = request && typeof request === "object" ? request : {};
    const messages = Array.isArray(input.messages) && input.messages.length
      ? input.messages
      : [{ role: "user", content: String(input.prompt ?? "") }];
    const result = await provider.handlers.generate(normalized, { ...input, messages }, modelProviderContext(provider, input.signal ? { signal: input.signal } : {}));
    return normalizeCompletion(result);
  }

  async function runHook(name = "", payload = undefined) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      return payload;
    }
    const handlers = sortByPriorityThenOrder(hooks.get(normalizedName) || []);
    const timeoutMs = getPluginHookTimeoutMs();
    let currentPayload = payload;
    for (const handler of handlers) {
      if (!isPluginEnabled(handler.pluginId)) {
        continue;
      }
      const startedAt = Date.now();
      try {
        const beforePayload = currentPayload;
        const nextPayload = await withTimeout(
          Promise.resolve().then(() => handler.handler(currentPayload)),
          timeoutMs,
          `hook ${normalizedName} for plugin ${handler.pluginId}`
        );
        if (nextPayload !== undefined) {
          currentPayload = nextPayload;
        }
        const materialHook = /^(worker:prompt:build|permissions:decision|worker:tool-call:completed|queue:task-dispatch-started|queue:task-processed|transaction:|provider-history:)/.test(normalizedName);
        const taskId = String(currentPayload?.taskId || beforePayload?.taskId || currentPayload?.task?.id || beforePayload?.task?.id || "").trim();
        if (
          materialHook
          && taskId
          && sharedRuntimeContext?.taskFlightRecorder
          && typeof sharedRuntimeContext.taskFlightRecorder.appendHookTrace === "function"
        ) {
          const changed = nextPayload !== undefined && nextPayload !== beforePayload;
          void sharedRuntimeContext.taskFlightRecorder.appendHookTrace(taskId, {
            hook: normalizedName,
            pluginId: handler.pluginId,
            effect: changed ? "hook returned replacement payload" : "hook observed payload",
            payloadPreview: JSON.stringify(currentPayload || {}).slice(0, 4000)
          }).catch(() => {});
        }
        updateRuntimeStats({
          pluginId: handler.pluginId,
          hookName: normalizedName,
          durationMs: Date.now() - startedAt,
          ok: true
        });
      } catch (error) {
        const errorText = String(error?.message || error || "unknown hook error");
        updateRuntimeStats({
          pluginId: handler.pluginId,
          hookName: normalizedName,
          durationMs: Date.now() - startedAt,
          ok: false,
          error: errorText
        });
        recordPluginFailure(handler.pluginId, `hook:${normalizedName}`, errorText);
      }
    }
    return currentPayload;
  }

  function buildPluginApi(pluginMeta = {}) {
    const pluginId = normalizePluginId(pluginMeta.id || pluginMeta.name);
    const pluginName = String(pluginMeta.name || pluginId).trim() || pluginId;
    const pluginManifest = normalizePluginManifest(pluginMeta.manifest || {});
    const canRegisterRoutes = pluginManifest.permissions.routes === true;
    const canRegisterUiPanels = pluginManifest.permissions.uiPanels === true;
    const canUseDataStore = pluginManifest.permissions.data === true;
    return {
      pluginId,
      pluginName,
      coreApiVersion: CORE_PLUGIN_API_VERSION,
      getCoreApiVersion: () => CORE_PLUGIN_API_VERSION,
      manifest: pluginManifest,
      broadcast,
      getAppConfig,
      getRuntimeContext: () => filterRuntimeContextForManifest(pluginManifest),
      setRuntimeContext: (nextContext = {}) => {
        if (!hasManifestPermission(pluginManifest.permissions.runtimeContext, "*")) {
          return;
        }
        if (!nextContext || typeof nextContext !== "object") {
          return;
        }
        sharedRuntimeContext = {
          ...sharedRuntimeContext,
          ...nextContext
        };
      },
      provideCapability: (capabilityName = "", handler = null, options = {}) => {
        const normalizedName = String(capabilityName || "").trim();
        if (!normalizedName || typeof handler !== "function" || !hasManifestPermission(pluginManifest.permissions.capabilities, normalizedName)) {
          if (normalizedName && typeof handler === "function") {
            recordPluginFailure(pluginId, "manifest:capability-denied", `capability ${normalizedName} is not permitted`);
          }
          return;
        }
        const existing = capabilities.get(normalizedName) || [];
        existing.push({
          pluginId,
          capability: normalizedName,
          handler,
          priority: normalizePriority(options?.priority),
          order: registrationSequence++
        });
        capabilities.set(normalizedName, existing);
      },
      addHook: (hookName = "", handler = null, options = {}) => {
        const normalizedName = String(hookName || "").trim();
        if (!normalizedName || typeof handler !== "function" || !hasManifestPermission(pluginManifest.permissions.hooks, normalizedName)) {
          if (normalizedName && typeof handler === "function") {
            recordPluginFailure(pluginId, "manifest:hook-denied", `hook ${normalizedName} is not permitted`);
          }
          return;
        }
        const existing = hooks.get(normalizedName) || [];
        existing.push({
          pluginId,
          hook: normalizedName,
          handler,
          priority: normalizePriority(options?.priority),
          order: registrationSequence++
        });
        hooks.set(normalizedName, existing);
      },
      registerTool: (descriptor = {}, handler = null) => {
        const normalizedDescriptor = normalizePluginToolDescriptor(pluginId, pluginName, descriptor);
        if (!normalizedDescriptor) {
          return null;
        }
        if (!hasManifestPermission(pluginManifest.permissions.tools, normalizedDescriptor.name)) {
          recordPluginFailure(pluginId, "manifest:tool-denied", `tool ${normalizedDescriptor.name} is not permitted`);
          return null;
        }
        const existing = tools.get(pluginId) || [];
        const duplicateIndex = existing.findIndex((entry) => entry.name === normalizedDescriptor.name);
        const nextTools = duplicateIndex >= 0
          ? existing.map((entry, index) => (index === duplicateIndex ? normalizedDescriptor : entry))
          : [...existing, normalizedDescriptor];
        tools.set(pluginId, nextTools);
        const handlerKey = `${pluginId}:${normalizedDescriptor.name}`;
        if (typeof handler === "function") {
          toolHandlers.set(handlerKey, { pluginId, handler });
        } else {
          toolHandlers.delete(handlerKey);
        }
        return { ...normalizedDescriptor };
      },
      registerUiPanel: (panel = {}) => {
        if (!canRegisterUiPanels) {
          recordPluginFailure(pluginId, "manifest:ui-denied", "UI panel registration is not permitted");
          return null;
        }
        const normalizedPanel = normalizeUiPanelDescriptor(pluginId, panel);
        if (!normalizedPanel) {
          return null;
        }
        const existing = uiPanels.get(pluginId) || [];
        const duplicate = existing.find((entry) => entry.id === normalizedPanel.id);
        const nextPanels = duplicate
          ? existing.map((entry) => (entry.id === normalizedPanel.id ? normalizedPanel : entry))
          : [...existing, normalizedPanel];
        uiPanels.set(pluginId, nextPanels);
        return normalizedPanel;
      },
      registerUiTab: (tab = {}) => {
        if (!canRegisterUiPanels) {
          recordPluginFailure(pluginId, "manifest:ui-tab-denied", "UI tab registration is not permitted");
          return null;
        }
        const normalizedTab = normalizeUiTabDescriptor(pluginId, tab);
        if (!normalizedTab) {
          return null;
        }
        const existing = uiTabs.get(pluginId) || [];
        const duplicate = existing.find((entry) => entry.id === normalizedTab.id);
        const nextTabs = duplicate
          ? existing.map((entry) => (entry.id === normalizedTab.id ? normalizedTab : entry))
          : [...existing, normalizedTab];
        uiTabs.set(pluginId, nextTabs);
        return normalizedTab;
      },
      registerUiPrimaryTab: (tab = {}) => {
        if (!canRegisterUiPanels) {
          recordPluginFailure(pluginId, "manifest:ui-primary-tab-denied", "Primary tab registration is not permitted");
          return null;
        }
        const normalizedTab = normalizeUiPrimaryTabDescriptor(pluginId, tab);
        if (!normalizedTab) {
          return null;
        }
        const existing = uiPrimaryTabs.get(pluginId) || [];
        const duplicate = existing.find((entry) => entry.id === normalizedTab.id);
        const nextTabs = duplicate
          ? existing.map((entry) => (entry.id === normalizedTab.id ? normalizedTab : entry))
          : [...existing, normalizedTab];
        uiPrimaryTabs.set(pluginId, nextTabs);
        // A tab registered with `home: true` asks to be the host's home view. It needs the
        // manifest's homeView permission, and an explicit env or profile choice still wins.
        if (tab.home === true) {
          if (pluginManifest.permissions.homeView === true) {
            homeViewClaims.set(pluginId, {
              pluginId,
              view: pluginViewId(normalizedTab),
              priority: normalizePriority(tab.homePriority),
              order: registrationSequence++
            });
          } else {
            recordPluginFailure(pluginId, "manifest:home-view-denied", `tab ${normalizedTab.id} asked to be the home view without the homeView permission`);
          }
        } else if (homeViewClaims.get(pluginId)?.view === pluginViewId(normalizedTab)) {
          homeViewClaims.delete(pluginId);
        }
        return normalizedTab;
      },
      registerContextProvider: (descriptor = {}, provide = null) => {
        const normalized = normalizeContextProviderDescriptor(pluginId, descriptor);
        if (!normalized || typeof provide !== "function") {
          return null;
        }
        if (!hasManifestPermission(pluginManifest.permissions.contextProviders, normalized.id)) {
          recordPluginFailure(pluginId, "manifest:context-provider-denied", `context provider ${normalized.id} is not permitted`);
          return null;
        }
        const entry = { ...normalized, handler: provide, order: registrationSequence++ };
        const existing = (contextProviders.get(pluginId) || []).filter((provider) => provider.id !== normalized.id);
        contextProviders.set(pluginId, [...existing, entry]);
        return describeContextProvider(entry);
      },
      // Tool use (1.7): a plugin that drives a model, such as an agent runtime, lists the tools
      // other plugins registered and calls them through core, so tool guards and observers apply.
      listTools: () => {
        if (pluginManifest.permissions.toolUse !== true) {
          recordPluginFailure(pluginId, "manifest:tool-use-denied", "using other plugins' tools is not permitted");
          return [];
        }
        return filterToolsByProfile(listPluginTools(), activeProfile || {});
      },
      executeTool: (name = "", args = {}, context = {}) => {
        if (pluginManifest.permissions.toolUse !== true) {
          recordPluginFailure(pluginId, "manifest:tool-use-denied", "using other plugins' tools is not permitted");
          return Promise.reject(new TypeError("using other plugins' tools is not permitted"));
        }
        return executeTool(name, args, { ...(context && typeof context === "object" ? context : {}), callerPluginId: pluginId });
      },
      collectContext: async (request = {}) => {
        if (pluginManifest.permissions.contextCollect !== true) {
          recordPluginFailure(pluginId, "manifest:context-collect-denied", "collecting context is not permitted");
          return { audience: "chat", sections: [], text: "", chars: 0, skipped: [], failures: [] };
        }
        return collectContext(request);
      },
      getUiSettings: () => getUiSettings(),
      // A model provider type, e.g. { id: "meterless", fields, defaults, secrets, actions } with
      // { generate, normalizeConfig?, probe?, actions? }. Ids are global: hosts store them as a
      // processor's provider, so a second plugin cannot take an id already registered.
      registerModelProvider: (descriptor = {}, handlers = {}) => {
        const normalized = normalizeModelProviderDescriptor(pluginId, descriptor, handlers);
        if (!normalized) {
          return null;
        }
        if (!hasManifestPermission(pluginManifest.permissions.modelProviders, normalized.id)) {
          recordPluginFailure(pluginId, "manifest:model-provider-denied", `model provider ${normalized.id} is not permitted`);
          return null;
        }
        const existing = modelProviders.get(normalized.id);
        if (existing && existing.pluginId !== pluginId) {
          recordPluginFailure(pluginId, "model-provider-duplicate", `model provider ${normalized.id} is already registered by ${existing.pluginId}`);
          return null;
        }
        modelProviders.set(normalized.id, normalized);
        return describeModelProvider(normalized);
      },
      listModelProviders: () => listModelProviders(),
      probeModelProvider: (providerId = "", config = {}, options = {}) => {
        if (pluginManifest.permissions.modelProviderUse !== true) {
          recordPluginFailure(pluginId, "manifest:model-provider-use-denied", "using model providers is not permitted");
          return Promise.resolve({ status: "offline", models: [], detail: "not permitted" });
        }
        return probeModelProvider(providerId, config, options);
      },
      generateWithModelProvider: (providerId = "", config = {}, request = {}) => {
        if (pluginManifest.permissions.modelProviderUse !== true) {
          recordPluginFailure(pluginId, "manifest:model-provider-use-denied", "using model providers is not permitted");
          return Promise.reject(new TypeError("using model providers is not permitted"));
        }
        return generateWithModelProvider(providerId, config, request);
      },
      registerUiSecretsTab: (tab = {}) => {
        if (!canRegisterUiPanels) {
          recordPluginFailure(pluginId, "manifest:ui-secrets-tab-denied", "Secrets tab registration is not permitted");
          return null;
        }
        const normalizedTab = normalizeUiSecretsTabDescriptor(pluginId, tab);
        if (!normalizedTab) {
          return null;
        }
        const existing = uiSecretsTabs.get(pluginId) || [];
        const duplicate = existing.find((entry) => entry.id === normalizedTab.id);
        const nextTabs = duplicate
          ? existing.map((entry) => (entry.id === normalizedTab.id ? normalizedTab : entry))
          : [...existing, normalizedTab];
        uiSecretsTabs.set(pluginId, nextTabs);
        return normalizedTab;
      },
      registerUiSystemTab: (tab = {}) => {
        if (!canRegisterUiPanels) {
          recordPluginFailure(pluginId, "manifest:ui-system-tab-denied", "System tab registration is not permitted");
          return null;
        }
        const normalizedTab = normalizeUiSystemTabDescriptor(pluginId, tab);
        if (!normalizedTab) {
          return null;
        }
        const existing = uiSystemTabs.get(pluginId) || [];
        const duplicate = existing.find((entry) => entry.id === normalizedTab.id);
        const nextTabs = duplicate
          ? existing.map((entry) => (entry.id === normalizedTab.id ? normalizedTab : entry))
          : [...existing, normalizedTab];
        uiSystemTabs.set(pluginId, nextTabs);
        return normalizedTab;
      },
      registerRegressionSuite: (suiteOrFactory = null) => {
        if (!(suiteOrFactory && (typeof suiteOrFactory === "function" || typeof suiteOrFactory === "object"))) {
          return null;
        }
        const existing = regressionSuites.get(pluginId) || [];
        const registration = {
          pluginId,
          order: registrationSequence++,
          resolve: typeof suiteOrFactory === "function"
            ? suiteOrFactory
            : () => suiteOrFactory
        };
        regressionSuites.set(pluginId, [...existing, registration]);
        return registration;
      },
      registerInternalRegressionRunner: (mode = "", handler = null, options = {}) => {
        const normalizedMode = String(mode || "").trim();
        if (!normalizedMode || typeof handler !== "function") {
          return null;
        }
        const existing = internalRegressionRunners.get(normalizedMode) || [];
        const registration = {
          pluginId,
          mode: normalizedMode,
          handler,
          priority: normalizePriority(options?.priority),
          order: registrationSequence++
        };
        internalRegressionRunners.set(normalizedMode, [...existing, registration]);
        return registration;
      },
      getCapability,
      listCapabilityProviders,
      runHook
      ,
      isEnabled: () => isPluginEnabled(pluginId),
      setEnabled: async (enabled = true) => {
        return await setPluginEnabledWithLifecycle(pluginId, enabled === true, "plugin-api");
      },
      data: !canUseDataStore ? null : {
        path: (key = "", options = {}) => {
          const extension = options?.extension ? String(options.extension) : ".json";
          return resolvePluginDataPath(pluginId, key, extension);
        },
        readJson: async (key = "", fallback = null) => {
          const value = await readPluginDataJson(pluginId, key, fallback);
          await appendPluginAudit({
            kind: "plugin_data_read",
            pluginId,
            key: normalizePluginDataKey(key)
          });
          return value;
        },
        writeJson: async (key = "", value = null) => {
          const saved = await writePluginDataJson(pluginId, key, value);
          await appendPluginAudit({
            kind: "plugin_data_write",
            pluginId,
            key: normalizePluginDataKey(key)
          });
          return saved;
        },
        updateJson: async (key = "", updater = null, fallback = null) => {
          const saved = await updatePluginDataJson(pluginId, key, updater, fallback);
          await appendPluginAudit({
            kind: "plugin_data_update",
            pluginId,
            key: normalizePluginDataKey(key)
          });
          return saved;
        }
      }
      ,
      canRegisterRoutes: () => canRegisterRoutes
    };
  }

  function use(pluginFactory = null) {
    if (!pluginFactory) {
      return;
    }
    pluginFactories.push(pluginFactory);
  }

  function setRuntimeContext(nextContext = {}) {
    if (!nextContext || typeof nextContext !== "object") {
      return;
    }
    sharedRuntimeContext = {
      ...sharedRuntimeContext,
      ...nextContext
    };
  }

  function setActiveProfile(nextProfile = {}) {
    activeProfile = nextProfile && typeof nextProfile === "object" ? nextProfile : null;
  }

  async function initialize() {
    await loadPluginTrustPolicy();
    await loadPluginState();
    registerHostCapabilities(hostCapabilities);
    const factories = uniquePluginList(pluginFactories);
    let pluginStateChanged = false;
    const factoryResults = await Promise.allSettled(
      factories.map(async (candidate, index) => {
        const plugin = typeof candidate === "function"
          ? await candidate()
          : candidate;
        return {
          candidateIndex: index,
          plugin
        };
      })
    );
    const discoveredPlugins = [];
    for (const result of factoryResults) {
      if (result.status !== "fulfilled") {
        recordPluginFailure("unknown", "factory", result.reason);
        continue;
      }
      const plugin = result.value?.plugin;
      if (!plugin || typeof plugin !== "object") {
        continue;
      }
      discoveredPlugins.push({
        candidateIndex: Number(result.value?.candidateIndex || 0),
        plugin
      });
    }
    discoveredPlugins.sort((left, right) => {
      const leftManifest = normalizePluginManifest(left?.plugin?.manifest || {});
      const rightManifest = normalizePluginManifest(right?.plugin?.manifest || {});
      const priorityDelta = Number(leftManifest.startupPriority || 100) - Number(rightManifest.startupPriority || 100);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      if (Number(left.candidateIndex || 0) !== Number(right.candidateIndex || 0)) {
        return Number(left.candidateIndex || 0) - Number(right.candidateIndex || 0);
      }
      return String(left?.plugin?.id || left?.plugin?.name || "").localeCompare(String(right?.plugin?.id || right?.plugin?.name || ""));
    });
    for (const entry of discoveredPlugins) {
      const plugin = entry.plugin;
      const pluginId = normalizePluginId(plugin.id || plugin.name);
      if (!pluginId) {
        continue;
      }
      const pluginMeta = {
        id: pluginId,
        name: String(plugin.name || pluginId).trim() || pluginId,
        version: String(plugin.version || "0.0.0").trim() || "0.0.0",
        description: String(plugin.description || "").trim(),
        manifest: normalizePluginManifest(plugin.manifest || {}),
        modulePath: String(plugin.__modulePath || "").trim(),
        moduleHash: String(plugin.__moduleHash || "").trim().toLowerCase()
      };
      if (!plugin.manifest || typeof plugin.manifest !== "object") {
        recordPluginFailure(pluginMeta.id, "manifest", "plugin manifest is required");
        continue;
      }
      const compatibilityCheck = isManifestCompatibleWithCore(pluginMeta.manifest);
      if (!compatibilityCheck.ok) {
        recordPluginFailure(pluginMeta.id, "manifest:compatibility", compatibilityCheck.reason);
        continue;
      }
      if (pluginMeta.manifest.security.isolation === "process") {
        recordPluginFailure(pluginMeta.id, "manifest:isolation", "process isolation mode is declared but not available yet");
        continue;
      }
      if (!pluginTrustedByPolicy(pluginMeta)) {
        recordPluginFailure(pluginMeta.id, "trust", "plugin is not trusted by allowlist policy");
        continue;
      }
      if (!knownPluginIds.has(pluginId)) {
        knownPluginIds.add(pluginId);
        pluginStateChanged = true;
      }
      if (!pluginStateById.has(pluginId)) {
        pluginStateById.set(pluginId, true);
        pluginStateChanged = true;
      }
      const pluginApi = buildPluginApi(pluginMeta);
      if (typeof plugin.init === "function") {
        try {
          await plugin.init(pluginApi);
        } catch (error) {
          recordPluginFailure(pluginMeta.id, "init", error);
          continue;
        }
      }
      for (const route of pluginMeta.manifest.permissions.publicRoutes || []) {
        if (RESERVED_ROUTE_PREFIXES.some((reserved) => routeCovers(reserved, route) || routeCovers(route, reserved))) {
          recordPluginFailure(pluginMeta.id, "manifest:public-route-denied", `${route} overlaps a core route and stays protected`);
        }
      }
      activePlugins.push({
        ...pluginMeta,
        registerRoutes: typeof plugin.registerRoutes === "function" ? plugin.registerRoutes : null,
        onEnable: typeof plugin.onEnable === "function" ? plugin.onEnable : null,
        onDisable: typeof plugin.onDisable === "function" ? plugin.onDisable : null
      });
      appendPluginAudit({
        kind: "plugin_loaded",
        pluginId: pluginMeta.id,
        modulePath: pluginMeta.modulePath,
        moduleHash: pluginMeta.moduleHash,
        enabled: isPluginEnabled(pluginMeta.id)
      }).catch(() => {});
    }
    const activePluginIds = new Set(activePlugins.map((plugin) => normalizePluginId(plugin.id)).filter(Boolean));
    for (const knownPluginId of [...knownPluginIds]) {
      if (activePluginIds.has(knownPluginId)) {
        continue;
      }
      if (pluginStateById.get(knownPluginId) !== false) {
        pluginStateById.set(knownPluginId, false);
        pluginStateChanged = true;
        await appendPluginAudit({
          kind: "plugin_auto_disabled_missing",
          pluginId: knownPluginId,
          source: "startup-missing"
        }).catch(() => {});
      }
    }
    if (pluginStateChanged) {
      await savePluginState();
    }
    for (const plugin of activePlugins) {
      const requiredCapabilities = Array.isArray(plugin?.manifest?.dependencies?.requiredCapabilities)
        ? plugin.manifest.dependencies.requiredCapabilities
        : [];
      if (!requiredCapabilities.length) {
        continue;
      }
      const missing = requiredCapabilities.filter((capabilityName) => typeof getCapability(capabilityName) !== "function");
      if (!missing.length) {
        continue;
      }
      await setPluginEnabledWithLifecycle(plugin.id, false, "dependency-check");
      recordPluginFailure(plugin.id, "dependencies", `missing required capabilities: ${missing.join(", ")}`);
    }
    await Promise.all(
      activePlugins
        .filter((plugin) => isPluginEnabled(plugin.id))
        .map((plugin) =>
          invokePluginLifecycleCallback(plugin.id, "onEnable", {
            pluginId: plugin.id,
            previousEnabled: false,
            enabled: true,
            source: "startup",
            at: Date.now()
          })
        )
    );
    try {
      await runHook("plugins:initialized", {
        at: Date.now(),
        plugins: activePlugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version
        }))
      });
    } catch (error) {
      recordPluginFailure("core", "plugins:initialized", error);
    }
    if (pluginTrustPolicy.mode !== "allowlist") {
      console.warn(
        "[genesis] plugin trust mode is PERMISSIVE — all plugins load without hash verification. " +
        "POST /api/plugins/trust/lock to generate an allowlist from currently loaded plugins."
      );
    }
  }

  async function registerRoutes() {
    if (!app) {
      return;
    }
    function ensureAdmin(req = {}, res = {}) {
      if (typeof validateAdminRequest !== "function") {
        return true;
      }
      const valid = validateAdminRequest(req);
      if (valid) {
        return true;
      }
      if (typeof res.status === "function" && typeof res.json === "function") {
        res.status(403).json({ ok: false, error: "Admin token required" });
      }
      return false;
    }
    // Public: a host UI reads it before it has an admin token, and it holds nothing secret.
    app.get("/api/ui/settings", (req, res) => {
      res.json({ ok: true, ...getUiSettings() });
    });
    app.get("/api/context/providers", (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      res.json({ ok: true, providers: listContextProviders({ audience: String(req.query?.audience || "") }) });
    });
    app.post("/api/context/collect", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      try {
        res.json({ ok: true, ...(await collectContext(req.body || {})) });
      } catch (error) {
        res.status(500).json({ ok: false, error: String(error?.message || error) });
      }
    });
    const providerRoute = (handler) => async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      try {
        res.json({ ok: true, ...(await handler(req)) });
      } catch (error) {
        res.status(error instanceof TypeError ? 400 : 500).json({ ok: false, error: String(error?.message || error) });
      }
    };
    app.get("/api/model-providers", providerRoute(async () => ({ providers: listModelProviders() })));
    app.post("/api/model-providers/:providerId/normalize", providerRoute(async (req) => ({
      config: await normalizeModelProviderConfig(req.params.providerId, req.body?.config)
    })));
    app.post("/api/model-providers/:providerId/probe", providerRoute(async (req) =>
      probeModelProvider(req.params.providerId, req.body?.config)));
    app.post("/api/model-providers/:providerId/actions/:actionId", providerRoute(async (req) => ({
      result: await runModelProviderAction(req.params.providerId, req.params.actionId, req.body || {})
    })));
    // Stores a declared secret; the value is never echoed back.
    app.post("/api/model-providers/:providerId/secrets/:handle", providerRoute(async (req) =>
      setModelProviderSecret(req.params.providerId, req.params.handle, req.body?.value)));
    app.post("/api/model-providers/:providerId/generate", providerRoute(async (req) => ({
      completion: await generateWithModelProvider(req.params.providerId, req.body?.config, req.body?.request)
    })));
    app.get("/api/plugins/list", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      res.json({
        ok: true,
        coreApiVersion: CORE_PLUGIN_API_VERSION,
        plugins: activePlugins.filter((plugin) => isPluginVisible(plugin.id)).map((plugin) => buildPluginDescriptor(plugin)),
        capabilities: [...capabilities.keys()].sort((left, right) => left.localeCompare(right)),
        capabilityProviders: Object.fromEntries(
          [...capabilities.entries()].map(([name, providers]) => [
            name,
            sortByPriorityThenOrder(providers).map((entry) => ({
              pluginId: entry.pluginId,
              capability: entry.capability,
              priority: Number(entry.priority || 100),
              enabled: isPluginEnabled(entry.pluginId)
            }))
          ])
        ),
        hooks: [...hooks.keys()].sort((left, right) => left.localeCompare(right)),
        hookProviders: Object.fromEntries(
          [...hooks.entries()].map(([name, providers]) => [
            name,
            sortByPriorityThenOrder(providers).map((entry) => ({
              pluginId: entry.pluginId,
              hook: entry.hook,
              priority: Number(entry.priority || 100),
              enabled: isPluginEnabled(entry.pluginId)
            }))
          ])
        ),
        hookRuntimeStats: Object.fromEntries(
          [...hookRuntimeStatsByName.entries()].map(([name, stats]) => [name, stats])
        ),
        tools: activePlugins.filter((plugin) => isPluginVisible(plugin.id)).flatMap((plugin) =>
          listPluginTools(plugin.id).map((tool) => ({
            ...tool,
            enabled: isPluginEnabled(plugin.id)
          }))
        ),
        pluginState: buildPluginStatePayload(),
        trust: {
          mode: pluginTrustPolicy.mode
        },
        failures: failedPlugins.slice(),
        uiPanels: activePlugins.filter((plugin) => isPluginVisible(plugin.id)).flatMap((plugin) =>
          listPluginUiPanels(plugin.id).map((panel) => ({
            ...panel,
            pluginName: plugin.name
          }))
        ),
        uiPrimaryTabs: activePlugins.filter((plugin) => isPluginVisible(plugin.id)).flatMap((plugin) =>
          listPluginUiPrimaryTabs(plugin.id).map((tab) => ({
            ...tab,
            pluginName: plugin.name,
            enabled: isPluginEnabled(plugin.id)
          }))
        ),
        uiSecretsTabs: activePlugins.filter((plugin) => isPluginVisible(plugin.id)).flatMap((plugin) =>
          listPluginUiSecretsTabs(plugin.id).map((tab) => ({
            ...tab,
            pluginName: plugin.name,
            enabled: isPluginEnabled(plugin.id)
          }))
        ),
        uiSystemTabs: activePlugins.filter((plugin) => isPluginVisible(plugin.id)).flatMap((plugin) =>
          listPluginUiSystemTabs(plugin.id).map((tab) => ({
            ...tab,
            pluginName: plugin.name,
            enabled: isPluginEnabled(plugin.id)
          }))
        ),
        uiTabs: activePlugins.filter((plugin) => isPluginVisible(plugin.id)).flatMap((plugin) =>
          listPluginUiTabs(plugin.id).map((tab) => ({
            ...tab,
            pluginName: plugin.name,
            enabled: isPluginEnabled(plugin.id)
          }))
        ),
        runtimeRoot
      });
    });

    app.get("/api/plugins/state", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      res.json({
        ok: true,
        coreApiVersion: CORE_PLUGIN_API_VERSION,
        pluginState: buildPluginStatePayload(),
        plugins: activePlugins.map((plugin) => ({
          id: plugin.id,
          enabled: isPluginEnabled(plugin.id),
          enabledSource: pluginEnabledSource(plugin.id)
        }))
      });
    });

    app.post("/api/plugins/:pluginId/toggle", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      const pluginId = normalizePluginId(req.params?.pluginId || "");
      if (!pluginId) {
        return res.status(400).json({ ok: false, error: "pluginId is required" });
      }
      const plugin = activePlugins.find((entry) => entry.id === pluginId);
      if (!plugin) {
        return res.status(404).json({ ok: false, error: "plugin not found" });
      }
      const enabled = req.body?.enabled !== false;
      await setPluginEnabledWithLifecycle(pluginId, enabled, "admin-api");
      res.json({
        ok: true,
        plugin: buildPluginDescriptor(plugin),
        pluginState: buildPluginStatePayload()
      });
    });

    app.get("/api/plugins/trust", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      res.json({
        ok: true,
        trust: pluginTrustPolicy,
        plugins: activePlugins.map((plugin) => ({
          id: plugin.id,
          moduleHash: String(plugin.moduleHash || "").trim(),
          modulePath: String(plugin.modulePath || "").trim()
        }))
      });
    });

    app.post("/api/plugins/trust", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      const payload = req.body && typeof req.body === "object" ? req.body : {};
      const saved = await savePluginTrustPolicy(payload);
      await appendPluginAudit({
        kind: "plugin_trust_policy_updated",
        mode: saved.mode
      });
      res.json({
        ok: true,
        trust: saved
      });
    });

    app.post("/api/plugins/trust/lock", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      const allowlist = {};
      for (const plugin of activePlugins) {
        const hash = String(plugin.moduleHash || "").trim().toLowerCase();
        if (!plugin.id || !hash) {
          continue;
        }
        allowlist[plugin.id] = { hashes: [hash] };
      }
      const saved = await savePluginTrustPolicy({ mode: "allowlist", allowlist });
      await appendPluginAudit({
        kind: "plugin_trust_policy_locked",
        mode: saved.mode,
        pluginCount: Object.keys(allowlist).length
      });
      res.json({
        ok: true,
        trust: saved,
        lockedPluginCount: Object.keys(allowlist).length
      });
    });

    app.post("/api/plugins/install", async (req, res) => {
      if (!ensureAdmin(req, res)) {
        return;
      }
      try {
        const attachment = req.body?.attachment && typeof req.body.attachment === "object"
          ? req.body.attachment
          : null;
        const autoRestart = req.body?.autoRestart === true;
        if (!attachment) {
          return res.status(400).json({ ok: false, error: "attachment is required" });
        }
        const result = await installUploadedPluginPackage(attachment, { autoRestart });
        const responsePayload = {
          ok: true,
          result: autoRestart
            ? {
              ...result,
              autoRestartScheduled: result.autoRestartSupported === true
            }
            : result
        };
        if (autoRestart && result.autoRestartSupported !== true) {
          responsePayload.warning = "Plugin installed, but automatic restart is unavailable because Genesis does not appear to be running under a restart supervisor.";
        }
        if (autoRestart && result.autoRestartSupported === true) {
          let restartRequested = false;
          const requestRestart = () => {
            if (restartRequested) {
              return;
            }
            restartRequested = true;
            scheduleProcessRestart("plugin_upload_install");
          };
          res.once("finish", requestRestart);
          res.once("close", requestRestart);
        }
        res.json(responsePayload);
      } catch (error) {
        res.status(400).json({ ok: false, error: String(error?.message || error || "failed to install plugin package") });
      }
    });

    await Promise.allSettled(
      activePlugins
        .filter((plugin) => plugin.registerRoutes && isPluginEnabled(plugin.id))
        .map(async (plugin) => {
          const pluginApi = buildPluginApi(plugin);
          if (pluginApi.canRegisterRoutes && pluginApi.canRegisterRoutes() !== true) {
            recordPluginFailure(plugin.id, "manifest:routes-denied", "route registration is not permitted");
            return;
          }
          const routeAwareApp = buildPluginRouteAwareApp(plugin.id) || app;
          try {
            await plugin.registerRoutes({
              app: routeAwareApp,
              fs,
              path,
              runtimeRoot,
              plugin: {
                id: plugin.id,
                name: plugin.name,
                version: plugin.version
              },
              api: pluginApi
            });
          } catch (error) {
            recordPluginFailure(plugin.id, "registerRoutes", error);
          }
        })
    );
  }

  function listPlugins() {
    return activePlugins.filter((plugin) => isPluginVisible(plugin.id)).map((plugin) => buildPluginDescriptor(plugin));
  }

  // Routes enabled plugins declared as authenticating their own callers (permissions.publicRoutes).
  function listPublicRoutes() {
    return activePlugins
      .filter((plugin) => isPluginServing(plugin.id))
      .flatMap((plugin) => (plugin.manifest?.permissions?.publicRoutes || [])
        .filter((route) => !RESERVED_ROUTE_PREFIXES.some((reserved) => routeCovers(reserved, route) || routeCovers(route, reserved)))
        .map((route) => ({ pluginId: plugin.id, route })));
  }

  function isPublicRoute(routePath = "") {
    const normalized = String(routePath || "").split("?")[0];
    return listPublicRoutes().some(({ route }) => routeCovers(route, normalized));
  }

  function listRegressionSuites(context = {}) {
    const suites = [];
    const seenSuiteIds = new Set();
    for (const plugin of activePlugins) {
      if (!isPluginEnabled(plugin.id)) {
        continue;
      }
      for (const suite of resolvePluginRegressionSuites(plugin.id, context)) {
        if (seenSuiteIds.has(suite.id)) {
          continue;
        }
        seenSuiteIds.add(suite.id);
        suites.push(suite);
      }
    }
    return suites;
  }

  async function runInternalRegressionCase(testCase = {}, context = {}) {
    const mode = String(testCase?.mode || "").trim();
    if (!mode) {
      return null;
    }
    const handlers = sortByPriorityThenOrder(internalRegressionRunners.get(mode) || []);
    for (const handler of handlers) {
      if (!isPluginEnabled(handler.pluginId)) {
        continue;
      }
      try {
        const result = await handler.handler(testCase, context);
        if (result && typeof result === "object") {
          return result;
        }
      } catch (error) {
        recordPluginFailure(handler.pluginId, `regression:internal:${mode}`, error);
      }
    }
    return null;
  }

  // Lifecycle hooks (1.7): runtime:startup once, then runtime:tick:1m / runtime:tick:5m on
  // timers that never overlap a tick still running and never keep the process alive.
  const lifecycleTimers = [];
  let lifecycleStarted = false;
  async function startLifecycle({ tickIntervals = { "runtime:tick:1m": 60_000, "runtime:tick:5m": 300_000 } } = {}) {
    if (lifecycleStarted) {
      return;
    }
    lifecycleStarted = true;
    await runHook("runtime:startup", { at: Date.now(), coreVersion: CORE_PLUGIN_API_VERSION });
    for (const [hookName, interval] of Object.entries(tickIntervals || {})) {
      let running = false;
      const timer = setInterval(() => {
        if (running) {
          return;
        }
        running = true;
        runHook(hookName, { at: Date.now(), interval }).catch(() => {}).finally(() => { running = false; });
      }, Math.max(1000, Number(interval) || 60_000));
      timer.unref?.();
      lifecycleTimers.push(timer);
    }
  }

  async function shutdown(reason = "host-shutdown") {
    while (lifecycleTimers.length) {
      clearInterval(lifecycleTimers.pop());
    }
    if (lifecycleStarted) {
      lifecycleStarted = false;
      await runHook("runtime:shutdown", { at: Date.now(), reason: String(reason || "host-shutdown") });
    }
    for (const plugin of [...activePlugins].reverse()) {
      await invokePluginLifecycleCallback(plugin.id, "onDisable", {
        pluginId: plugin.id,
        previousEnabled: isPluginEnabled(plugin.id),
        enabled: false,
        source: String(reason || "host-shutdown"),
        at: Date.now()
      });
    }
  }

  return {
    coreApiVersion: CORE_PLUGIN_API_VERSION,
    getCapability,
    executeTool,
    collectContext,
    listContextProviders,
    getUiSettings,
    listModelProviders,
    normalizeModelProviderConfig,
    probeModelProvider,
    runModelProviderAction,
    setModelProviderSecret,
    generateWithModelProvider,
    getCapabilityProviders: listCapabilityProviders,
    getHookRuntimeStats: () => Object.fromEntries([...hookRuntimeStatsByName.entries()].map(([name, stats]) => [name, stats])),
    initialize,
    isPublicRoute,
    listPublicRoutes,
    startLifecycle,
    listCapabilityProviders,
    listTools: () => filterToolsByProfile(listPluginTools(), activeProfile || {}),
    listRegressionSuites,
    listPlugins,
    registerRoutes,
    runInternalRegressionCase,
    runHook,
    setActiveProfile,
    setRuntimeContext,
    shutdown,
    use
  };
}
