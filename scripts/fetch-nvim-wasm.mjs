import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "vendor", "nvim-wasm");
const BASE = "https://raw.githubusercontent.com/MuNeNICK/nvim-wasm/master/examples/demo-asyncify";

// Pinned digests of upstream prebuilt assets (no license upstream — see README).
// Refresh with: node scripts/fetch-nvim-wasm.mjs --print-hashes
const ASSETS = [
  { name: "nvim-asyncify.wasm", sha256: "0c002380cfe2510ee07948353a017015fb0b369faa86dc7251a192fa0b132012" },
  { name: "nvim-runtime.tar.gz", sha256: "3a4e21bd812b0e1b3f9e623427dfee5a2e379e9511b9cc8d3dc35ed2387a77af" },
];

const printHashes = process.argv.includes("--print-hashes");
await mkdir(outDir, { recursive: true });

for (const asset of ASSETS) {
  const dest = path.join(outDir, asset.name);
  let buf;
  if (existsSync(dest)) {
    buf = await readFile(dest);
  } else {
    const res = await fetch(`${BASE}/${asset.name}`);
    if (!res.ok) throw new Error(`fetch ${asset.name}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  const digest = createHash("sha256").update(buf).digest("hex");
  if (printHashes) {
    console.log(`${asset.name}: ${digest}`);
  } else if (digest !== asset.sha256) {
    throw new Error(`sha256 mismatch for ${asset.name}: got ${digest}`);
  }
  if (!existsSync(dest)) await writeFile(dest, buf);
  console.log(`ok ${asset.name} (${buf.length} bytes)`);
}
