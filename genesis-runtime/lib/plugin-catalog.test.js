import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCatalogIndex, resolveInstallSet, copyInstallSet } from "./plugin-catalog.js";

test("local plugin installation includes operation packs and reference kits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "genesis-catalog-assets-"));
  t.after(async () => {
    const safeRoot = path.resolve(os.tmpdir());
    const target = path.resolve(root);
    if (!target.startsWith(`${safeRoot}${path.sep}`)) throw new Error("unsafe test cleanup path");
    await fs.rm(target, { recursive: true, force: true });
  });
  const catalogRoot = path.join(root, "catalog");
  const pluginRoot = path.join(catalogRoot, "operations");
  await fs.mkdir(path.join(pluginRoot, "packs"), { recursive: true });
  await fs.mkdir(path.join(pluginRoot, "reference-kits", "seo"), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, "operations-plugin.js"), "export default () => ({});\n");
  await fs.writeFile(path.join(pluginRoot, "packs", "seo.json"), "{}\n");
  await fs.writeFile(path.join(pluginRoot, "reference-kits", "seo", "SKILL.md"), "# SEO\n");
  const catalogIndex = await buildCatalogIndex({ catalogRoot, fs });
  const set = await resolveInstallSet({ id: "operations", catalogIndex, fs });
  assert.equal(set.ok, true);
  assert.equal(set.assetFiles.size, 2);
  const destRoot = path.join(root, "installed");
  await copyInstallSet({ files: set.files, assetFiles: set.assetFiles, catalogRoot, destRoot, fs });
  assert.equal(await fs.readFile(path.join(destRoot, "catalog", "operations", "packs", "seo.json"), "utf8"), "{}\n");
  assert.equal(await fs.readFile(path.join(destRoot, "catalog", "operations", "reference-kits", "seo", "SKILL.md"), "utf8"), "# SEO\n");
});
