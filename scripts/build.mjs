import { build } from "esbuild";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist", "chromium");

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

// Test-only activation hook (src/content/overlay.ts) must never ship in a
// production build — it's page-triggerable since any page controls its own
// DOM. `__NVIM_TEST_HOOKS__` is a compile-time flag: esbuild's `define`
// replaces it with a literal, and the minifier dead-code-eliminates the
// listener entirely when it's `false`. Only the smoke script (which sets
// NVIM_TEST_HOOKS=1) opts in.
const testHooksEnabled = process.env.NVIM_TEST_HOOKS === "1";
const define = { __NVIM_TEST_HOOKS__: testHooksEnabled ? "true" : "false" };

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [
    { in: path.join(root, "src", "background.ts"), out: "background" },
    { in: path.join(root, "src", "engine-frame", "engine-frame.ts"), out: "engine-frame" },
    { in: path.join(root, "src", "engine", "worker.ts"), out: "engine-worker" },
  ],
  outdir: outDir,
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: false,
  minify: true,
  define,
});

// Content script: bundled as a classic IIFE (content scripts cannot be ESM).
await build({
  entryPoints: [{ in: path.join(root, "src", "content", "overlay.ts"), out: "content" }],
  outdir: outDir,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  minify: true,
  define,
});

await cp(path.join(root, "src", "scratch", "scratch.html"), path.join(outDir, "scratch.html"));
await cp(
  path.join(root, "src", "engine-frame", "engine-frame.html"),
  path.join(outDir, "engine-frame.html"),
);

// Toolbar / extension icons (referenced by manifest icons + action.default_icon).
const iconDir = path.join(outDir, "icons");
await mkdir(iconDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await cp(path.join(root, "icons", `icon-${size}.png`), path.join(iconDir, `icon-${size}.png`));
}

// Copy the Neovim engine assets alongside the worker bundle. The engine
// (asyncified wasm + runtime tarball) is built and published by the separate
// nvim-wasi repo and fetched here as a SHA-pinned release artifact into
// vendor/nvim-wasi/ by `npm run fetch-assets` (scripts/fetch-engine.mjs). This
// is the sole engine source — there is no in-repo build.
//
// The build stamps dist/chromium/engine-info.json with the source ("nvim-wasi"),
// the pinned release tag, and each file's bytes + sha256 so downstream tooling
// (release.sh) can confirm which engine landed.
const engineAssets = ["nvim-asyncify.wasm", "nvim-runtime.tar.gz"];
const engineDir = path.join(root, "vendor", "nvim-wasi");
const lock = JSON.parse(await readFile(path.join(root, "engine.lock.json"), "utf8"));

const engineInfo = { source: "nvim-wasi", tag: lock.tag, files: [] };
for (const asset of engineAssets) {
  const src = path.join(engineDir, asset);
  try {
    await access(src);
  } catch {
    throw new Error(
      `Missing engine asset ${path.relative(root, src)}. Run \`npm run fetch-assets\` first.`,
    );
  }
  const dest = path.join(outDir, asset);
  await cp(src, dest);
  const bytes = (await stat(dest)).size;
  const sha256 = createHash("sha256").update(await readFile(dest)).digest("hex");
  engineInfo.files.push({ name: asset, bytes, sha256 });
}
await writeFile(path.join(outDir, "engine-info.json"), JSON.stringify(engineInfo, null, 2) + "\n");
const totalBytes = engineInfo.files.reduce((sum, f) => sum + f.bytes, 0);
console.log(
  `bundled nvim-wasi ${lock.tag} engine (${engineInfo.files.map((f) => `${f.name} ${f.bytes}B`).join(", ")}, total ${totalBytes}B)`,
);

// Stamp the package.json version into the shipped manifest; the source
// manifest carries a 0.0.0 placeholder so version has one source of truth.
const manifest = JSON.parse(await readFile(path.join(root, "src", "manifest.json"), "utf8"));
manifest.version = pkg.version;
await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`built dist/chromium (version ${manifest.version})`);
