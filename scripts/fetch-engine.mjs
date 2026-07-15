// fetch-engine.mjs — pull the pinned nvim-wasi engine artifacts into
// vendor/nvim-wasi/ and verify them against engine.lock.json.
//
// The engine (asyncified wasm + runtime tarball) is built and published by the
// separate nvim-wasi repo (github unknownbreaker/nvim-wasi) and consumed here
// as a SHA-pinned GitHub release artifact. Both repos are private, so we
// download via the GitHub CLI (`gh release download`), which uses the user's
// existing gh auth. Every file is verified against the sha256 pinned in
// engine.lock.json; a mismatch is fatal (the bad file is deleted).
//
// Idempotent: a file already present with the correct hash is skipped.
//
// Run: npm run fetch-assets   (or: node scripts/fetch-engine.mjs)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "vendor", "nvim-wasi");
const lockPath = path.join(root, "engine.lock.json");

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main() {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const { repo, tag, files } = lock;
  if (!repo || !tag || !Array.isArray(files) || files.length === 0) {
    throw new Error(`engine.lock.json is malformed (need repo, tag, files[])`);
  }

  await mkdir(outDir, { recursive: true });
  console.log(`fetching engine ${repo}@${tag} -> ${path.relative(root, outDir)}/`);

  for (const { name, sha256 } of files) {
    const dest = path.join(outDir, name);

    // Skip if already present and hash-valid (idempotent re-runs).
    if (existsSync(dest)) {
      const have = await sha256File(dest);
      if (have === sha256) {
        console.log(`skip ${name} (already present, sha256 ok)`);
        continue;
      }
      console.log(`re-fetch ${name} (sha256 ${have} != ${sha256})`);
    }

    // Download via gh (spawned as an argv array — never a shell string).
    execFileSync(
      "gh",
      [
        "release",
        "download",
        tag,
        "--repo",
        repo,
        "--pattern",
        name,
        "--output",
        dest,
        "--clobber",
      ],
      { cwd: root, stdio: "inherit" },
    );

    const got = await sha256File(dest);
    if (got !== sha256) {
      await rm(dest, { force: true });
      throw new Error(
        `sha256 mismatch for ${name}: got ${got}, expected ${sha256} ` +
          `(deleted the bad download; check engine.lock.json vs the ${repo}@${tag} release)`,
      );
    }
    console.log(`ok ${name} (sha256 verified)`);
  }

  console.log("engine assets ready");
}

main().catch((e) => {
  console.error("FETCH FAIL:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
