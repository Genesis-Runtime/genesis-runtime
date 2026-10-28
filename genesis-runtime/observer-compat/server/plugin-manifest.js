export function normalizePluginId(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function normalizePriority(value = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1000, Math.round(parsed))) : 100;
}

export function normalizePermissionRules(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : value === true
      ? ["*"]
      : [];
}

export function normalizeManifestPermissions(permissions = {}) {
  return {
    routes: permissions.routes === true,
    uiPanels: permissions.uiPanels === true,
    data: permissions.data === true,
    capabilities: normalizePermissionRules(permissions.capabilities),
    hooks: normalizePermissionRules(permissions.hooks),
    runtimeContext: normalizePermissionRules(permissions.runtimeContext),
    tools: normalizePermissionRules(permissions.tools),
    // Core API 1.6.0, additive: off unless declared.
    // homeView: one of the plugin's primary tabs may ask to be the host's home view.
    homeView: permissions.homeView === true,
    // contextProviders: provider ids the plugin may register to supply scoped
    // notes to a host's chat or prompts. contextCollect: it may collect them.
    contextProviders: normalizePermissionRules(permissions.contextProviders),
    contextCollect: permissions.contextCollect === true,
    // modelProviders: model provider type ids the plugin may register (e.g. "meterless").
    // modelProviderUse: it may probe and generate through registered provider types.
    modelProviders: normalizePermissionRules(permissions.modelProviders),
    modelProviderUse: permissions.modelProviderUse === true,
    // toolUse (1.7): it may list and execute tools other plugins registered, through core,
    // so tool:before-execute guards and tool:after-execute observers apply.
    toolUse: permissions.toolUse === true,
    // publicRoutes (1.8): path prefixes of this plugin's routes that authenticate their callers
    // themselves (a signed header, an API key), so core's admin-token check does not apply.
    publicRoutes: (Array.isArray(permissions.publicRoutes) ? permissions.publicRoutes : [])
      .map((route) => String(route || "").trim().replace(/\/+$/, ""))
      .filter((route) => route.startsWith("/") && route.length > 1)
  };
}

export function normalizePluginManifest(manifest = {}) {
  return {
    schemaVersion: Number(manifest?.schemaVersion || 1),
    startupPriority: normalizePriority(manifest?.startupPriority),
    permissions: normalizeManifestPermissions(manifest?.permissions || {}),
    compatibility: {
      coreApiMin: String(manifest?.compatibility?.coreApiMin || "").trim(),
      coreApiMax: String(manifest?.compatibility?.coreApiMax || "").trim()
    },
    dependencies: {
      requiredCapabilities: Array.isArray(manifest?.dependencies?.requiredCapabilities)
        ? manifest.dependencies.requiredCapabilities.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [],
      optionalCapabilities: Array.isArray(manifest?.dependencies?.optionalCapabilities)
        ? manifest.dependencies.optionalCapabilities.map((entry) => String(entry || "").trim()).filter(Boolean)
        : []
    },
    security: {
      isolation: String(manifest?.security?.isolation || "inprocess").trim().toLowerCase() === "process"
        ? "process"
        : "inprocess"
    },
    topics: normalizeManifestTopics(manifest?.topics)
  };
}

// What a plugin is about, declared by the plugin (core API 1.5.0): subjects,
// services and platforms it covers (keywords), and requests it serves
// (examples). A host reads them to decide when to offer the plugin's tools;
// they grant nothing.
export const MAX_TOPIC_KEYWORDS = 24;
export const MAX_TOPIC_EXAMPLES = 12;

export function normalizeManifestTopics(topics = {}) {
  const strings = (value, limit, length) => [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? "").replace(/\s+/g, " ").trim().slice(0, length))
    .filter(Boolean))].slice(0, limit);
  return {
    keywords: strings(topics?.keywords, MAX_TOPIC_KEYWORDS, 60),
    examples: strings(topics?.examples, MAX_TOPIC_EXAMPLES, 200)
  };
}

export function hasManifestPermission(rules = [], name = "") {
  if (!Array.isArray(rules) || !rules.length) {
    return false;
  }
  if (rules.includes("*")) {
    return true;
  }
  const normalizedName = String(name || "").trim();
  return rules.some((rule) => {
    const normalizedRule = String(rule || "").trim();
    if (!normalizedRule) return false;
    if (normalizedRule.endsWith("*")) {
      return normalizedName.startsWith(normalizedRule.slice(0, -1));
    }
    return normalizedRule === normalizedName;
  });
}

export function normalizeUiPanelDescriptor(pluginId = "", panel = {}) {
  if (!panel || typeof panel !== "object") return null;
  const panelId = normalizePluginId(panel.id || panel.name || panel.title);
  if (!panelId) return null;
  return {
    id: panelId,
    pluginId: normalizePluginId(pluginId),
    title: String(panel.title || panel.name || panel.id || panelId).trim() || panelId,
    description: String(panel.description || "").trim(),
    fields: Array.isArray(panel.fields) ? panel.fields : [],
    actions: Array.isArray(panel.actions) ? panel.actions : []
  };
}

export function normalizeUiTabDescriptor(pluginId = "", tab = {}, { includeIcon = true } = {}) {
  if (!tab || typeof tab !== "object") return null;
  const tabId = normalizePluginId(tab.id || tab.name || tab.title || pluginId);
  const scriptUrl = String(tab.scriptUrl || tab.script || "").trim();
  if (!tabId || !scriptUrl || !scriptUrl.startsWith("/")) return null;
  const normalized = {
    id: tabId,
    pluginId: normalizePluginId(pluginId),
    title: String(tab.title || tab.name || tabId).trim() || tabId,
    order: Number.isFinite(Number(tab.order)) ? Number(tab.order) : 100,
    scriptUrl
  };
  if (includeIcon) {
    normalized.icon = String(tab.icon || tab.iconText || tabId.slice(0, 1).toUpperCase()).trim().slice(0, 4) || tabId.slice(0, 1).toUpperCase();
  }
  return normalized;
}
