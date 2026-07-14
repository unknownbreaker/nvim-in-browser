import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist", "chromium");

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [
    { in: path.join(root, "src", "background.ts"), out: "background" },
    { in: path.join(root, "src", "scratch", "scratch.ts"), out: "scratch" },
  ],
  outdir: outDir,
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: false,
  minify: true,
});

await cp(path.join(root, "src", "scratch", "scratch.html"), path.join(outDir, "scratch.html"));

// Stamp the package.json version into the shipped manifest; the source
// manifest carries a 0.0.0 placeholder so version has one source of truth.
const manifest = JSON.parse(await readFile(path.join(root, "src", "manifest.json"), "utf8"));
manifest.version = pkg.version;
await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`built dist/chromium (version ${manifest.version})`);
