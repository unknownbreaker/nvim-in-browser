import { build } from "esbuild";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist", "chromium");
const firefoxDir = path.join(root, "dist", "firefox");

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
    { in: path.join(root, "src", "options", "options.ts"), out: "options" },
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

// Main-world editor bridge (T1): a separate content-script entry injected into
// the page's MAIN world (manifest `"world":"MAIN"`) so it can reach live
// Monaco / CodeMirror instances the isolated overlay can't see. Bundled as an
// IIFE for the same reason content.js is (a content script is never an ESM).
await build({
  entryPoints: [
    { in: path.join(root, "src", "content", "editor-bridge-main.ts"), out: "editor-bridge" },
  ],
  outdir: outDir,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  minify: true,
  define,
});

await cp(path.join(root, "src", "scratch", "scratch.html"), path.join(outDir, "scratch.html"));
await cp(path.join(root, "src", "options", "options.html"), path.join(outDir, "options.html"));
await cp(
  path.join(root, "src", "engine-frame", "engine-frame.html"),
  path.join(outDir, "engine-frame.html"),
);

// StyLua (Lua formatter): copy its prebuilt wasm-bindgen "web" build verbatim.
// The options page lazily dynamic-import()s stylua_lib_web.js and init()s it
// with explicit wasm bytes on first Format (src/options/options-format.ts), so
// the ~3.3MB wasm never touches the options-page startup path. Copying (rather
// than bundling through esbuild) sidesteps wasm-bindgen's
// `new URL('stylua_lib_bg.wasm', import.meta.url)` locator.
const styluaDir = path.join(root, "node_modules", "@johnnymorganz", "stylua");
for (const f of ["stylua_lib_web.js", "stylua_lib_bg.wasm"]) {
  await cp(path.join(styluaDir, f), path.join(outDir, f));
}

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
// Both engine VARIANTS ship: base (nvim-asyncify.wasm + nvim-runtime.tar.gz)
// and the web treesitter superset (…-web.*). The overlay iframe fetches
// whichever variant the user's language-pack setting selects at boot; both are
// part of the same nvim-wasi release tag, so they're stamped together.
const engineAssets = [
  "nvim-asyncify.wasm",
  "nvim-runtime.tar.gz",
  "nvim-asyncify-web.wasm",
  "nvim-runtime-web.tar.gz",
];
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

// --- Firefox (MV3) build variant -----------------------------------------
// The Firefox build ships the IDENTICAL compiled extension (same content.js,
// editor-bridge.js, background.js, engine-frame, options, wasm, runtime, and
// engine-info.json) as dist/chromium — only the manifest differs. Copy the
// whole chromium output into dist/firefox, then overwrite manifest.json with a
// Firefox-transformed variant. (Gecko aliases chrome.* to browser.* for every
// API this code uses, so no runtime code changes are needed.)
await rm(firefoxDir, { recursive: true, force: true });
await cp(outDir, firefoxDir, { recursive: true });

// Manifest transform (Chrome MV3 -> Firefox MV3), verified to lint clean and
// install in Firefox 128+:
//   - background.service_worker  -> background.scripts + type:"module"
//     (Firefox implements MV3 background as an event page, not a worker)
//   - options_page               -> options_ui { page, open_in_tab }
//   - add browser_specific_settings.gecko: extension id + strict_min_version,
//     plus data_collection_permissions (a new AMO requirement — we collect no
//     data, so { required: ["none"] } clears the lint warning)
// Everything else (permissions, icons, action, commands, content_scripts incl.
// world:"MAIN", CSP with wasm-unsafe-eval, web_accessible_resources) is
// identical and Firefox-compatible.
const firefoxManifest = JSON.parse(JSON.stringify(manifest));
delete firefoxManifest.background;
delete firefoxManifest.options_page;
firefoxManifest.background = { scripts: ["background.js"], type: "module" };
firefoxManifest.options_ui = { page: "options.html", open_in_tab: true };
firefoxManifest.browser_specific_settings = {
  gecko: {
    id: "nvim-in-browser@unknownbreaker",
    strict_min_version: "128.0",
    data_collection_permissions: { required: ["none"] },
  },
};
await writeFile(
  path.join(firefoxDir, "manifest.json"),
  JSON.stringify(firefoxManifest, null, 2) + "\n",
);

console.log(`built dist/chromium and dist/firefox (version ${manifest.version})`);
