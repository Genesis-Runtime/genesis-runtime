#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listAvailableProfiles,
  saveProfileSelection,
  readStoredProfileSelection,
  defaultPreferencePath,
  profileManagerInternals
} from "../lib/profile-manager.js";
import {
  buildCatalogIndex,
  resolveInstallSet,
  measureInstallSet,
  copyInstallSet,
  resolveCatalogRoot
} from "../lib/plugin-catalog.js";
import { loadPluginSourceRegistry, resolvePluginSource } from "../lib/plugin-sources.js";
import { cloneGitPlugin } from "../lib/plugin-git-source.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilesDir = path.join(rootDir, "profiles");
const preferencePath = defaultPreferencePath(rootDir);
const SIZE_WARNING_BYTES = 25 * 1024 * 1024;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function listProfileIds() {
  const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
    .map((entry) => entry.name.replace(/\.json$/i, ""))
    .sort();
}

async function readRawProfile(id) {
  const filePath = path.join(profilesDir, `${id}.json`);
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readValidatedProfile(id) {
  return profileManagerInternals.validateProfile(await readRawProfile(id));
}

async function currentActiveId() {
  const envProfile = String(process.env.GENESIS_PROFILE || "").trim().toLowerCase();
  if (envProfile) return envProfile;
  const stored = await readStoredProfileSelection({ fs, preferencePath });
  return stored || "default";
}

function printUsage() {
  console.log(`genesis — Genesis Runtime profile CLI

Usage:
  genesis list                          List available profiles
  genesis create <profile>              Install a profile's plugins from the catalog and activate it
  genesis install profile <profile>     Alias for "create"
  genesis use <profile>                 Activate an already-installed profile (no plugin install)
  genesis new <profile> [--from <id>]   Scaffold a new editable profile JSON (default base: "default")
  genesis catalog [--catalog <path>]    Show what the resolved plugin catalog contains

Options:
  --source <git|local>  Force one fetch strategy for every plugin in the install (default: per-plugin,
                         git if it has a registered source, else local if --catalog is set)
  --catalog <path>       Local catalog root, used for plugins without a registered git source
                         (else GENESIS_PLUGIN_CATALOG or GENESIS_PLUGIN_DIR env)
  --yes                  Proceed with a large local-catalog install (>${formatBytes(SIZE_WARNING_BYTES)}) without confirming
  --force                Re-clone/re-copy files that already exist locally, or overwrite an existing profile (new)
  --from <id>            Base profile to copy when scaffolding with "new" (default: "default")
  --title <text>         UI title for a profile scaffolded with "new"

Plugin sources (git is the default transport; each plugin lives in its own repo):
  profiles/plugin-sources.json   shared registry: { "<id>": "https://github.com/org/genesis-plugin-<id>.git#ref" }
  profile.pluginSources          per-profile override with the same shape, takes priority
  --catalog <path>                a local dev catalog directory, used for any plugin with no registered source
`);
}

async function cmdList() {
  const profiles = await listAvailableProfiles({ fs, rootDir });
  const activeId = await currentActiveId();
  console.log("Available profiles:\n");
  for (const profile of profiles) {
    const marker = profile.id === activeId ? "*" : " ";
    const pluginCount = profile.enabledPlugins?.length || 0;
    console.log(`${marker} ${profile.id.padEnd(16)} ${String(pluginCount).padStart(2)} plugin(s)  ${profile.name}`);
    if (profile.description) {
      console.log(`  ${" ".repeat(16)}             ${profile.description}`);
    }
  }
  console.log(`\nActive: ${activeId}`);
}

async function cmdUse(id) {
  if (!id) {
    console.error("Usage: genesis use <profile>");
    process.exitCode = 1;
    return;
  }
  try {
    await readValidatedProfile(id);
  } catch {
    const known = await listProfileIds();
    console.error(`Profile "${id}" not found in ${profilesDir}. Known profiles: ${known.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  await saveProfileSelection({ fs, preferencePath, profileId: id });
  console.log(`Active profile set to "${id}". Restart the runtime (npm start) to apply it.`);
}

async function cmdNew(id, flags) {
  if (!id) {
    console.error("Usage: genesis new <profile> [--from <baseProfile>] [--title <text>]");
    process.exitCode = 1;
    return;
  }
  const destPath = path.join(profilesDir, `${id}.json`);
  if (!flags.force) {
    const exists = await fs.stat(destPath).then(() => true).catch(() => false);
    if (exists) {
      console.error(`profiles/${id}.json already exists. Pass --force to overwrite.`);
      process.exitCode = 1;
      return;
    }
  }
  const baseId = String(flags.from || "default");
  let base;
  try {
    base = await readRawProfile(baseId);
  } catch {
    console.error(`Base profile "${baseId}" not found in ${profilesDir}.`);
    process.exitCode = 1;
    return;
  }
  const title = String(flags.title || "").trim();
  const next = {
    ...base,
    id,
    name: title || id,
    description: base.description && baseId !== id ? base.description : "",
    ui: {
      ...(base.ui || {}),
      title: title || id
    }
  };
  await fs.writeFile(destPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`Created profiles/${id}.json from "${baseId}".`);
  console.log(`Edit its enabledPlugins/disabledPlugins, then run "genesis create ${id}" to install and activate it.`);
}

async function cmdCatalog(flags) {
  const catalogRoot = resolveCatalogRoot({ env: process.env, cliCatalog: flags.catalog });
  if (!catalogRoot) {
    console.error("No plugin catalog configured. Pass --catalog <path>, or set GENESIS_PLUGIN_CATALOG / GENESIS_PLUGIN_DIR.");
    process.exitCode = 1;
    return;
  }
  const exists = await fs.stat(catalogRoot).then((stat) => stat.isDirectory()).catch(() => false);
  if (!exists) {
    console.error(`Catalog root not found or not a directory: ${catalogRoot}`);
    process.exitCode = 1;
    return;
  }
  const idx = await buildCatalogIndex({ catalogRoot, fs, pathModule: path });
  console.log(`Catalog: ${idx.root}`);
  console.log(`${idx.index.size} plugin(s) found:\n`);
  for (const id of [...idx.index.keys()].sort()) {
    console.log(`  ${id}`);
  }
  if (idx.duplicates.length) {
    console.log("\nDuplicate ids (deeper path kept, other shadowed):");
    for (const dup of idx.duplicates) {
      console.log(`  ${dup.id}: kept ${dup.kept}, shadowed ${dup.shadowed}`);
    }
  }
}

async function cmdInstall(id, flags) {
  if (!id) {
    console.error("Usage: genesis create <profile>");
    process.exitCode = 1;
    return;
  }
  let profile;
  try {
    profile = await readValidatedProfile(id);
  } catch {
    const known = await listProfileIds();
    console.error(`Profile "${id}" not found in ${profilesDir}. Known profiles: ${known.join(", ")}`);
    console.error(`Scaffold a new one with "genesis new ${id}".`);
    process.exitCode = 1;
    return;
  }

  const pluginIds = [...new Set([...(profile.enabledPlugins || []), ...(profile.forceEnabledPlugins || [])])];
  if (!pluginIds.length) {
    console.log(`Profile "${id}" enables no catalog plugins.`);
    await saveProfileSelection({ fs, preferencePath, profileId: id });
    console.log(`\nProfile "${id}" is active. Run "npm start" to boot with it.`);
    return;
  }

  const forcedSource = flags.source ? String(flags.source).trim().toLowerCase() : "";
  if (forcedSource && forcedSource !== "git" && forcedSource !== "local") {
    console.error(`--source must be "git" or "local" (got "${flags.source}")`);
    process.exitCode = 1;
    return;
  }
  const cliCatalogRoot = resolveCatalogRoot({ env: process.env, cliCatalog: flags.catalog });
  const registry = await loadPluginSourceRegistry({ fs, rootDir, pathModule: path });
  const destRoot = path.join(rootDir, "plugins", "_catalog");

  // Plan first, write nothing yet — lets the local-catalog size check below abort cleanly
  // before any git clone or file copy has happened.
  const gitPlugins = [];
  const localPlugins = [];
  const unresolved = [];
  const catalogIndexCache = new Map();

  for (const pluginId of pluginIds) {
    const registered = resolvePluginSource({ id: pluginId, profile, registry });
    const strategy = forcedSource || registered?.type || (cliCatalogRoot ? "local" : "");

    if (strategy === "git") {
      const gitSource = registered?.type === "git" ? registered : null;
      if (!gitSource?.url) {
        unresolved.push({ id: pluginId, reason: "no git source registered (add it to profiles/plugin-sources.json or the profile's pluginSources)" });
        continue;
      }
      gitPlugins.push({ id: pluginId, source: gitSource });
      continue;
    }

    if (strategy === "local") {
      const localRoot = (registered?.type === "local" && registered.path) || cliCatalogRoot;
      if (!localRoot) {
        unresolved.push({ id: pluginId, reason: "no local catalog path (pass --catalog, or register a local source with a path)" });
        continue;
      }
      const rootExists = await fs.stat(localRoot).then((stat) => stat.isDirectory()).catch(() => false);
      if (!rootExists) {
        unresolved.push({ id: pluginId, reason: `local catalog root not found: ${localRoot}` });
        continue;
      }
      if (!catalogIndexCache.has(localRoot)) {
        catalogIndexCache.set(localRoot, await buildCatalogIndex({ catalogRoot: localRoot, fs, pathModule: path }));
      }
      const idx = catalogIndexCache.get(localRoot);
      const set = await resolveInstallSet({ id: pluginId, catalogIndex: idx, fs, pathModule: path });
      if (!set.ok) {
        unresolved.push({ id: pluginId, reason: `not found in local catalog ${localRoot}` });
        continue;
      }
      localPlugins.push({ id: pluginId, set, catalogRoot: idx.root });
      continue;
    }

    unresolved.push({ id: pluginId, reason: "no source configured (add to profiles/plugin-sources.json, profile.pluginSources, or pass --catalog for a local dev catalog)" });
  }

  for (const [localRoot, idx] of catalogIndexCache) {
    for (const dup of idx.duplicates) {
      console.log(`  note: ${dup.id} — preferring ${dup.kept} over ${dup.shadowed} (from ${localRoot})`);
    }
  }

  let localTotalBytes = 0;
  const localSizes = [];
  for (const { id: pluginId, set } of localPlugins) {
    const bytes = await measureInstallSet({ files: set.files, assetFiles: set.assetFiles, fs });
    localSizes.push({ id: pluginId, bytes });
    localTotalBytes += bytes;
  }
  if (localTotalBytes > SIZE_WARNING_BYTES && !flags.yes) {
    console.log(`\nThe local-catalog portion of this install totals ${formatBytes(localTotalBytes)}:`);
    for (const entry of localSizes.sort((a, b) => b.bytes - a.bytes)) {
      console.log(`  ${entry.id.padEnd(24)} ${formatBytes(entry.bytes)}`);
    }
    console.log("\nRe-run with --yes to proceed.");
    process.exitCode = 1;
    return;
  }

  for (const { id: pluginId, source } of gitPlugins) {
    const result = await cloneGitPlugin({ id: pluginId, source, destRoot, fs, pathModule: path, force: Boolean(flags.force) });
    if (!result.ok) {
      console.log(`  ${pluginId}: git clone failed — ${result.reason}`);
      continue;
    }
    console.log(`  ${pluginId}: ${result.skipped ? "already cloned, left as-is" : `cloned from ${source.url}`}`);
  }

  for (const { id: pluginId, set, catalogRoot } of localPlugins) {
    const { copied, skipped } = await copyInstallSet({
      files: set.files,
      assetFiles: set.assetFiles,
      catalogRoot,
      destRoot,
      fs,
      pathModule: path,
      overwrite: Boolean(flags.force)
    });
    const bytes = localSizes.find((entry) => entry.id === pluginId)?.bytes || 0;
    console.log(`  ${pluginId}: ${copied.length} file(s) copied from local catalog, ${skipped.length} already present (${formatBytes(bytes)})`);
    if (set.externalDeps.size) {
      console.log(`    needs npm package(s): ${[...set.externalDeps].join(", ")} (not auto-installed)`);
    }
    if (set.unresolved.length) {
      console.log(`    ! ${set.unresolved.length} unresolved import(s) — plugin may not load until fixed:`);
      for (const entry of set.unresolved) {
        console.log(`      ${path.relative(rootDir, entry.from)} -> ${entry.specifier}`);
      }
    }
  }

  if (unresolved.length) {
    console.log(`\n${unresolved.length} plugin(s) not installed:`);
    for (const entry of unresolved) {
      console.log(`  ${entry.id}: ${entry.reason}`);
    }
  }

  await saveProfileSelection({ fs, preferencePath, profileId: id });
  console.log(`\nProfile "${id}" is active. Run "npm start" to boot with it.`);
  console.log(`Edit profiles/${id}.json or the installed plugins under plugins/_catalog/ to customize, then re-run this command to pick up new ones.`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    case "list":
    case "profiles":
      await cmdList();
      break;
    case "create":
      await cmdInstall(rest[0], flags);
      break;
    case "install":
      if (rest[0] === "profile") {
        await cmdInstall(rest[1], flags);
      } else {
        console.error(`Usage: genesis install profile <profile>`);
        process.exitCode = 1;
      }
      break;
    case "use":
      await cmdUse(rest[0]);
      break;
    case "new":
      await cmdNew(rest[0], flags);
      break;
    case "catalog":
      await cmdCatalog(flags);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[genesis] ${error?.message || error}`);
  process.exitCode = 1;
});
