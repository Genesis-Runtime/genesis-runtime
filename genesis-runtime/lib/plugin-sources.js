import path from "node:path";

/**
 * Where a profile's plugins actually come from. Git is the default/intended transport — each
 * plugin lives in its own repo. A "local" source (a path into a dev catalog directory, handled
 * by plugin-catalog.js) stays supported as an explicit opt-in for plugins that aren't published
 * yet, or for local-only/private plugins that will never get a repo.
 *
 * Sources are looked up in two places, profile first:
 *   - profile.pluginSources[id]   — per-profile override/pin (e.g. a specific branch or fork)
 *   - profiles/plugin-sources.json[id] — shared default registry, reused across profiles
 *
 * A source entry is either a bare git URL string (optionally "<url>#<ref>"), or an object:
 *   { "type": "git", "url": "https://github.com/org/genesis-plugin-mail.git", "ref": "main" }
 *   { "type": "local", "path": "/path/to/genesis-plugins/mail" }
 */

export async function loadPluginSourceRegistry({ fs, rootDir, pathModule = path }) {
  const registryPath = pathModule.join(rootDir, "profiles", "plugin-sources.json");
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSourceEntry(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const [url, ref = ""] = raw.split("#");
    return { type: "git", url: url.trim(), ref: ref.trim(), path: "" };
  }
  if (typeof raw !== "object") return null;
  const type = String(raw.type || (raw.path ? "local" : "git")).trim().toLowerCase();
  return {
    type,
    url: String(raw.url || "").trim(),
    ref: String(raw.ref || "").trim(),
    path: String(raw.path || "").trim()
  };
}

export function resolvePluginSource({ id, profile, registry }) {
  return normalizeSourceEntry(profile?.pluginSources?.[id]) || normalizeSourceEntry(registry?.[id]);
}
