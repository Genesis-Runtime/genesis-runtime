import { normalizePluginId, sortByPriorityThenOrder } from "./plugin-system-helpers.js";

/**
 * The interface settings a host's UI reads at startup (core API 1.6.0): above all the home
 * view, the view the interface opens on and returns to. Genesis decides which view that is;
 * drawing it is the host UI's job.
 *
 * A view is either a host view id ("world", "tasks", "plugins") or a plugin primary tab,
 * written "plugin:<pluginId>:<tabId>". Candidates are tried in order and the first usable
 * one wins:
 *   1. GENESIS_HOME_VIEW               - the deployment overrides everything
 *   2. profile.ui.homeView             - the profile's choice
 *   3. plugin claims                   - a primary tab registered with `home: true` by a
 *                                        plugin whose manifest grants `homeView`; lowest
 *                                        homePriority first (as hooks and capabilities),
 *                                        then earliest registration
 *   4. profile.ui.defaultTab           - the older, host-view-only setting
 *   5. the host's defaultHomeView
 * A plugin view is usable only while its tab is registered by an enabled, visible plugin, so
 * a profile naming an uninstalled plugin falls through instead of opening an empty view.
 */

const PLUGIN_VIEW = /^plugin:([^:]+):([^:]+)$/i;

export function normalizeHomeView(value = "") {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const plugin = text.match(PLUGIN_VIEW);
  if (plugin) {
    const pluginId = normalizePluginId(plugin[1]);
    const tabId = normalizePluginId(plugin[2]);
    return pluginId && tabId ? `plugin:${pluginId}:${tabId}` : "";
  }
  if (/^plugin:/i.test(text)) {
    return "";
  }
  return normalizePluginId(text);
}

// How a host shows the model's reply box (profile.ui.responsePanel). The behaviour itself is
// observer-compat/browser/collapsible.js; these are its settings.
export function normalizeResponsePanel(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    collapsible: input.collapsible !== false,
    startCollapsed: input.startCollapsed === true,
    // A new reply opens the box, so it is never missed behind a minimised one.
    expandOnNewReply: input.expandOnNewReply !== false,
    // The viewer's last choice is kept in their browser.
    rememberState: input.rememberState !== false
  };
}

export function parsePluginView(view = "") {
  const match = String(view || "").match(PLUGIN_VIEW);
  return match ? { pluginId: match[1], tabId: match[2] } : null;
}

export function pluginViewId(tab = {}) {
  return `plugin:${tab.pluginId}:${tab.id}`;
}

export function resolveHomeView({
  env = process.env,
  profile = null,
  claims = [],
  primaryTabs = [],
  defaultHomeView = ""
} = {}) {
  const available = new Map(primaryTabs.map((tab) => [pluginViewId(tab), tab]));
  const orderedClaims = sortByPriorityThenOrder(claims);
  const candidates = [
    { source: "env", view: env?.GENESIS_HOME_VIEW },
    { source: "profile", view: profile?.ui?.homeView },
    ...orderedClaims.map((claim) => ({ source: "plugin", view: claim.view, pluginId: claim.pluginId })),
    { source: "profile-default-tab", view: profile?.ui?.defaultTab },
    { source: "host-default", view: defaultHomeView }
  ];
  const unavailable = [];
  for (const candidate of candidates) {
    const view = normalizeHomeView(candidate.view);
    if (!view) {
      continue;
    }
    if (parsePluginView(view) && !available.has(view)) {
      unavailable.push({ source: candidate.source, view, reason: "plugin tab is not registered by an enabled plugin" });
      continue;
    }
    return {
      homeView: view,
      source: candidate.source,
      ...(candidate.pluginId ? { claimedBy: candidate.pluginId } : {}),
      homeTab: available.get(view) || null,
      unavailable
    };
  }
  return { homeView: "", source: "none", homeTab: null, unavailable };
}
