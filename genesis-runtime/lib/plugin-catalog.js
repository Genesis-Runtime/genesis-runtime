import path from "node:path";
import { builtinModules } from "node:module";

// A handful of catalog plugins live in a directory whose name doesn't match the id their
// factory actually registers under (a leftover of their Nova-era folder name). Extend this
// table if the catalog grows another one rather than guessing harder from the filename.
const ID_ALIASES = {
  "nova-android-network-bridge": "android-network-bridge"
};

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "vendor"]);
const RESOLVABLE_EXTENSIONS = [".js", ".mjs", ".cjs", ".json"];
// Matches both "node:fs" and legacy unprefixed specifiers like "fs" or "fs/promises".
const NODE_BUILTINS = new Set(builtinModules);
function isNodeBuiltinSpecifier(specifier = "") {
  const bare = specifier.replace(/^node:/, "").split("/")[0];
  return NODE_BUILTINS.has(bare);
}

function slugify(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pluginIdFromFileName(fileName = "") {
  const base = String(fileName || "").replace(/-plugin\.(?:m?js|cjs)$/i, "");
  const slug = slugify(base);
  return ID_ALIASES[slug] || slug;
}

async function walkForPluginFiles({ dir, fs, pathModule, out }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry?.name || "").trim();
    if (!name) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      await walkForPluginFiles({ dir: pathModule.join(dir, name), fs, pathModule, out });
      continue;
    }
    if (entry.isFile() && /-plugin\.(?:m?js|cjs)$/i.test(name)) {
      out.push(pathModule.join(dir, name));
    }
  }
}

/**
 * Indexes a plugin catalog directory by id, using the same filename-stem convention
 * plugin-loader.js's trust policy already relies on (basename minus "-plugin.js", slugified).
 * On an id collision (e.g. a flat legacy copy alongside a richer folder-based rewrite) the
 * deeper path wins, matching the catalog README's own guidance to prefer the folder version.
 */
export async function buildCatalogIndex({ catalogRoot, fs, pathModule = path }) {
  const root = pathModule.resolve(String(catalogRoot || "").trim());
  const files = [];
  await walkForPluginFiles({ dir: root, fs, pathModule, out: files });

  const index = new Map();
  const duplicates = [];
  for (const modulePath of files) {
    const id = pluginIdFromFileName(pathModule.basename(modulePath));
    if (!id) continue;
    const depth = pathModule.relative(root, modulePath).split(pathModule.sep).length;
    const candidate = { id, modulePath, dir: pathModule.dirname(modulePath), depth };
    const existing = index.get(id);
    if (!existing) {
      index.set(id, candidate);
      continue;
    }
    const [kept, shadowed] = existing.depth >= candidate.depth ? [existing, candidate] : [candidate, existing];
    index.set(id, kept);
    duplicates.push({ id, kept: kept.modulePath, shadowed: shadowed.modulePath });
  }
  return { root, index, duplicates };
}

function extractRelativeSpecifiers(sourceText = "") {
  const specifiers = new Set();
  const pattern = /\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(sourceText))) {
    const specifier = match[1] || match[2] || match[3];
    if (specifier) specifiers.add(specifier);
  }
  return specifiers;
}

async function resolveModuleOnDisk(candidatePath, fs) {
  for (const attempt of [candidatePath, ...RESOLVABLE_EXTENSIONS.map((ext) => candidatePath + ext)]) {
    try {
      const stat = await fs.stat(attempt);
      if (stat.isFile()) return attempt;
    } catch {
      // try next candidate
    }
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    try {
      const indexPath = path.join(candidatePath, `index${ext}`);
      const stat = await fs.stat(indexPath);
      if (stat.isFile()) return indexPath;
    } catch {
      // try next candidate
    }
  }
  return "";
}

async function listDirectoryRecursive({ dir, fs, pathModule, out }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry?.name || "").trim();
    if (!name) continue;
    const full = pathModule.join(dir, name);
    if (entry.isDirectory()) {
      await listDirectoryRecursive({ dir: full, fs, pathModule, out });
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/**
 * Walks the local (".") import/require graph starting from a plugin's entry module, so
 * installing one plugin doesn't drag in unrelated sibling plugins that happen to share a
 * directory (e.g. iot/transports/ holds both iot-matter and iot-mqtt). Bare package imports
 * are left alone (they're npm dependencies, not catalog files); anything that can't be found
 * on disk is reported back instead of silently dropped.
 *
 * If the entry module lives in a directory no other catalog plugin also lives in, that
 * directory's public/ and vendor/ subfolders (if present) are copied wholesale too, since
 * runtime assets in there (UI bundles, model binaries) are typically referenced by path at
 * runtime rather than imported.
 */
export async function resolveInstallSet({ id, catalogIndex, fs, pathModule = path }) {
  const entry = catalogIndex.index.get(id);
  if (!entry) {
    return { ok: false, reason: "not-in-catalog" };
  }

  const files = new Set();
  const externalDeps = new Set();
  const unresolved = [];
  const queue = [entry.modulePath];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    files.add(current);

    let text = "";
    try {
      text = await fs.readFile(current, "utf8");
    } catch {
      continue;
    }
    for (const specifier of extractRelativeSpecifiers(text)) {
      if (isNodeBuiltinSpecifier(specifier)) continue;
      if (!specifier.startsWith(".")) {
        externalDeps.add(specifier);
        continue;
      }
      const resolved = await resolveModuleOnDisk(pathModule.resolve(pathModule.dirname(current), specifier), fs);
      if (!resolved) {
        unresolved.push({ from: current, specifier });
        continue;
      }
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  const ownedByOtherPlugin = [...catalogIndex.index.values()].some(
    (other) => other.id !== id && other.dir === entry.dir
  );
  const assetFiles = new Set();
  if (!ownedByOtherPlugin && entry.dir !== catalogIndex.root) {
    for (const assetDirName of ["public", "vendor"]) {
      const collected = [];
      await listDirectoryRecursive({ dir: pathModule.join(entry.dir, assetDirName), fs, pathModule, out: collected });
      for (const file of collected) assetFiles.add(file);
    }
  }

  return { ok: true, id, entry, files, assetFiles, externalDeps, unresolved };
}

export async function measureInstallSet({ files, assetFiles, fs }) {
  let totalBytes = 0;
  for (const file of [...files, ...assetFiles]) {
    try {
      const stat = await fs.stat(file);
      totalBytes += stat.size;
    } catch {
      // file disappeared between resolution and measurement; ignore for sizing purposes
    }
  }
  return totalBytes;
}

/**
 * Copies files preserving their path relative to the catalog root's *parent* directory, not
 * the catalog root itself. Some catalog plugins reach one level above the catalog for shared
 * utility files; preserving that extra level of structure under destRoot keeps their relative
 * imports resolvable after the copy without rewriting any import specifiers.
 *
 * Existing destination files are left untouched by default (skipped, not overwritten) so a
 * re-run of `genesis create` after a plugin has been hand-edited locally doesn't clobber that
 * work. Pass overwrite:true to force a fresh copy.
 */
export async function copyInstallSet({ files, assetFiles, catalogRoot, destRoot, fs, pathModule = path, overwrite = false }) {
  const catalogParent = pathModule.dirname(pathModule.resolve(catalogRoot));
  const copied = [];
  const skipped = [];
  for (const file of [...files, ...assetFiles]) {
    const relPath = pathModule.relative(catalogParent, file);
    const dest = pathModule.join(destRoot, relPath);
    if (!overwrite) {
      try {
        await fs.stat(dest);
        skipped.push(dest);
        continue;
      } catch {
        // doesn't exist yet, fall through to copy
      }
    }
    await fs.mkdir(pathModule.dirname(dest), { recursive: true });
    await fs.copyFile(file, dest);
    copied.push(dest);
  }
  return { copied, skipped };
}

export function resolveCatalogRoot({ env = process.env, cliCatalog = "" } = {}) {
  return String(
    cliCatalog ||
      env?.GENESIS_PLUGIN_CATALOG ||
      env?.GENESIS_PLUGIN_DIR ||
      ""
  ).trim();
}
