import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Deliberately narrow: this string is handed to `git clone` as an argv element (never through a
// shell, so no injection risk there), but a completely unvalidated value could still make git
// treat something as a local path or an `ext::`/`--upload-pack=` transport trick. Requiring a
// recognizable git transport scheme up front is cheap insurance.
const VALID_GIT_URL = /^(https:\/\/|git@[^:]+:|git:\/\/|ssh:\/\/)/i;

/**
 * Shallow-clones a plugin's own repo straight into plugins/_catalog/<id>/, as a real git
 * checkout (not a copy) — deliberately, so a future `genesis update <profile>` can just `git
 * pull` it. Leaves an existing checkout alone unless force is set, so local edits survive a
 * repeat `genesis create`.
 */
export async function cloneGitPlugin({ id, source, destRoot, fs, pathModule = path, force = false }) {
  const url = String(source?.url || "").trim();
  if (!VALID_GIT_URL.test(url)) {
    return { ok: false, reason: `no usable git URL configured (got "${url || "(empty)"}")` };
  }
  const dest = pathModule.join(destRoot, id);
  const exists = await fs.stat(dest).then(() => true).catch(() => false);
  if (exists) {
    if (!force) {
      return { ok: true, skipped: true, dest };
    }
    await fs.rm(dest, { recursive: true, force: true });
  }
  await fs.mkdir(destRoot, { recursive: true });

  const args = ["clone", "--depth", "1"];
  if (source.ref) args.push("--branch", source.ref);
  args.push(url, dest);
  try {
    await execFileAsync("git", args);
  } catch (error) {
    return { ok: false, reason: `git clone failed: ${String(error?.stderr || error?.message || error).trim()}` };
  }
  return { ok: true, skipped: false, dest };
}
