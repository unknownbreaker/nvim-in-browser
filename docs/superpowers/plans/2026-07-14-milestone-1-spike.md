# Milestone 1 Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real Neovim (nvim-wasm Asyncify build) boots inside the MV3 extension and edits a `<textarea>` through an overlay, with idle CPU ≈ 0%.

**Architecture:** The prebuilt `nvim-asyncify.wasm` + `nvim-runtime.tar.gz` are fetched at build time (SHA-256 pinned, gitignored under `vendor/`). Our own engine host runs Neovim `--embed` (msgpack-RPC over stdin/stdout) in a module Web Worker using `@bjorn3/browser_wasi_shim`, with an Asyncify driver that truly suspends on `poll_oneoff`. The UI lives in an **extension-origin iframe** (`engine-frame.html`, web-accessible) that the content script positions over the focused textarea — this dodges host-page CSP for both wasm and workers, and gives clean keyboard capture (the Firenvim pattern). Content script ↔ iframe sync via `window.postMessage` with a nonce.

**Tech Stack:** TypeScript, esbuild, vitest (unit tests), `@msgpack/msgpack` (RPC codec), `@bjorn3/browser_wasi_shim` (WASI), native `DecompressionStream` (gunzip — no dep).

## Global Constraints

- Chrome MV3; no remote code (all deps vendored/bundled; never import from unpkg).
- `dist/chromium/` stays load-unpacked-able; version stamped from package.json (spec: Build & Release).
- nvim-wasm upstream has **NO license**: never commit its binaries (`vendor/` is gitignored), never copy its JS/C source into this repo. Interface facts (export names, message shapes) are fine; code is not. Fetch pinned by SHA-256 from commit `master` raw URLs.
- Idle CPU ≈ 0% is a hard gate: the worker must suspend, not poll (spec: Resource lifecycle).
- The escape chord `<C-S-Esc>` always deactivates and is never forwarded to Neovim (spec: Renderer).
- Conventional commits. Run `npm run typecheck` and `npm test` before every commit.

**Asset URLs (pin these):**
- `https://raw.githubusercontent.com/MuNeNICK/nvim-wasm/master/examples/demo-asyncify/nvim-asyncify.wasm` (8,386,869 bytes)
- `https://raw.githubusercontent.com/MuNeNICK/nvim-wasm/master/examples/demo-asyncify/nvim-runtime.tar.gz` (5,613,852 bytes)

**nvim boot argv (from nvim-wasm demos, verified):** `["nvim", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"]`

---

### Task 1: Vendored asset fetcher + deps

**Files:**
- Create: `scripts/fetch-nvim-wasm.mjs`
- Modify: `package.json` (deps + `fetch-assets` script), `.gitignore` (add `vendor/`), `README.md` (license caveat)

**Interfaces:**
- Produces: `vendor/nvim-wasm/nvim-asyncify.wasm`, `vendor/nvim-wasm/nvim-runtime.tar.gz` on disk; `npm run fetch-assets` idempotent.

- [ ] **Step 1: Add deps and script entries**

In `package.json`: add to `"scripts"`: `"fetch-assets": "node scripts/fetch-nvim-wasm.mjs"`, `"test": "vitest run"`. Add `"dependencies": { "@bjorn3/browser_wasi_shim": "^0.4.2", "@msgpack/msgpack": "^3.0.0" }` and to devDependencies `"vitest": "^2.0.0"`. Run `npm install --prefix .` from repo root.

- [ ] **Step 2: Write the fetcher**

```js
// scripts/fetch-nvim-wasm.mjs
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
  { name: "nvim-asyncify.wasm", sha256: "PASTE_AFTER_FIRST_RUN" },
  { name: "nvim-runtime.tar.gz", sha256: "PASTE_AFTER_FIRST_RUN" },
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
```

- [ ] **Step 3: Run once with `--print-hashes`, paste the two digests into `ASSETS`, run again plain**

Run: `node scripts/fetch-nvim-wasm.mjs --print-hashes` then edit the constants, then `npm run fetch-assets`.
Expected: `ok nvim-asyncify.wasm (8386869 bytes)` and `ok nvim-runtime.tar.gz (5613852 bytes)`; second run is a no-op using cached files. Byte sizes must match the pins above.

- [ ] **Step 4: gitignore + README caveat**

Append `vendor/` to `.gitignore`. Append to README a section: `## Third-party engine` stating: the Neovim WASM binary and runtime archive are fetched at build time from MuNeNICK/nvim-wasm, which currently has **no license**; Neovim itself is Apache-2.0; do not make this repo or its release assets public until upstream licensing is resolved (tracked: open an issue upstream).

- [ ] **Step 5: Verify clean tree ignores vendor, commit**

Run: `git status --short` — `vendor/` must not appear.
```bash
git add scripts/fetch-nvim-wasm.mjs package.json package-lock.json .gitignore README.md
git commit -m "feat: pinned fetcher for nvim-wasm engine assets"
```

---

### Task 2: msgpack-RPC framing (`src/engine/rpc.ts`)

**Files:**
- Create: `src/engine/rpc.ts`, `src/engine/rpc.test.ts`

**Interfaces:**
- Produces:
  - `class NvimRpc { constructor(send: (bytes: Uint8Array) => void); request(method: string, params: unknown[]): Promise<unknown>; notify(method: string, params: unknown[]): void; feed(chunk: Uint8Array): void; onNotification: (method: string, args: unknown[]) => void }`
  - `feed()` accepts arbitrary chunk boundaries (partial/coalesced messages).

- [ ] **Step 1: Write failing tests**

```ts
// src/engine/rpc.test.ts
import { describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { NvimRpc } from "./rpc";

describe("NvimRpc", () => {
  it("encodes a request and resolves its response", async () => {
    const sent: Uint8Array[] = [];
    const rpc = new NvimRpc((b) => sent.push(b));
    const p = rpc.request("nvim_eval", ["1+1"]);
    // response: [1, msgid, error, result]
    rpc.feed(encode([1, 0, null, 2]));
    await expect(p).resolves.toBe(2);
    expect(sent).toHaveLength(1);
  });

  it("rejects on error response", async () => {
    const rpc = new NvimRpc(() => {});
    const p = rpc.request("nvim_eval", ["bogus("]);
    rpc.feed(encode([1, 0, [1, "parse error"], null]));
    await expect(p).rejects.toThrow("parse error");
  });

  it("dispatches notifications and survives split chunks", () => {
    const rpc = new NvimRpc(() => {});
    const seen = vi.fn();
    rpc.onNotification = seen;
    const bytes = encode([2, "redraw", [["flush", []]]]);
    rpc.feed(bytes.slice(0, 5));
    rpc.feed(bytes.slice(5));
    expect(seen).toHaveBeenCalledWith("redraw", [["flush", []]]);
  });

  it("handles two messages in one chunk", () => {
    const rpc = new NvimRpc(() => {});
    const seen = vi.fn();
    rpc.onNotification = seen;
    const a = encode([2, "a", []]);
    const b = encode([2, "b", []]);
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a); joined.set(b, a.length);
    rpc.feed(joined);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/engine/rpc.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/engine/rpc.ts
import { Decoder, encode } from "@msgpack/msgpack";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class NvimRpc {
  onNotification: (method: string, args: unknown[]) => void = () => {};
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buffer = new Uint8Array(0);
  private decoder = new Decoder();

  constructor(private send: (bytes: Uint8Array) => void) {}

  request(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    this.send(encode([0, id, method, params]));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown[]): void {
    this.send(encode([2, method, params]));
  }

  feed(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer); joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    for (;;) {
      let msg: unknown;
      try {
        // decode() consumes one message; on truncated input it throws RangeError.
        msg = this.decoder.decode(this.buffer);
      } catch (e) {
        if (e instanceof RangeError) return; // wait for more bytes
        throw e;
      }
      // @msgpack/msgpack Decoder doesn't report consumed length via decode();
      // re-encode is wasteful, so use decodeMulti-style manual tracking instead:
      // see implementation note below — actual code uses decodeMultiInPlace.
      this.dispatch(msg);
      this.buffer = new Uint8Array(0);
      break;
    }
  }

  private dispatch(msg: unknown): void {
    const arr = msg as unknown[];
    if (arr[0] === 1) {
      const [, id, err, result] = arr as [number, number, unknown, unknown];
      const p = this.pending.get(id as number);
      if (!p) return;
      this.pending.delete(id as number);
      if (err) p.reject(new Error(String((err as unknown[])[1] ?? err)));
      else p.resolve(result);
    } else if (arr[0] === 2) {
      const [, method, params] = arr as [number, string, unknown[]];
      this.onNotification(method, params);
    }
  }
}
```

**Implementation note (do this, the sketch above is intentionally incomplete for `feed`):** `@msgpack/msgpack`'s `decodeMulti(buffer)` returns a generator that yields each complete message and throws `RangeError` when it hits a truncated tail. Correct `feed` algorithm: append chunk to `this.buffer`; iterate `decodeMulti(this.buffer)` collecting messages and tracking consumed bytes via a wrapping `DataView` — since `decodeMulti` does not expose offsets, instead use this robust pattern: try `decodeMulti` over the whole buffer inside try/catch; if it completes, dispatch all yielded messages and clear the buffer; on `RangeError` mid-iteration, dispatch the messages yielded so far and keep only the undecoded tail. To know the tail offset, use the `Decoder` class's documented `decodeStream`/`decodeMultiStream` alternative: maintain a `ReadableStream` fed by `feed()` and run `for await (const msg of decodeMultiStream(stream))` dispatching each — this is the simplest correct approach and is what the tests must pass against. Choose whichever passes all four tests; do not hand-roll a msgpack parser.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/engine/rpc.test.ts` — Expected: 4 passed.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/engine/rpc.ts src/engine/rpc.test.ts
git commit -m "feat: msgpack-RPC framing for nvim --embed"
```

---

### Task 3: Minimal ustar extractor (`src/engine/untar.ts`)

**Files:**
- Create: `src/engine/untar.ts`, `src/engine/untar.test.ts`

**Interfaces:**
- Produces: `function untar(bytes: Uint8Array): Array<{ path: string; type: "file" | "dir"; data: Uint8Array }>` — handles ustar headers, 512-byte blocks, `prefix` field, skips pax/gnu extension entries (typeflag `x`, `g`, `L` payloads applied when present is NOT required — nvim-runtime.tar.gz is plain ustar from GNU tar; treat unknown typeflags by skipping their data blocks).
- Consumed by Task 5 (worker builds the WASI FS from these entries).

- [ ] **Step 1: Write failing tests (fixture built with Node, not a binary blob)**

```ts
// src/engine/untar.test.ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { untar } from "./untar";

function makeTar(): Uint8Array {
  const dir = mkdtempSync(path.join(tmpdir(), "untar-test-"));
  mkdirSync(path.join(dir, "runtime/lua"), { recursive: true });
  writeFileSync(path.join(dir, "runtime/hello.txt"), "hello nvim\n");
  writeFileSync(path.join(dir, "runtime/lua/init.lua"), "-- lua\n");
  const tarPath = path.join(dir, "out.tar");
  execFileSync("tar", ["-cf", tarPath, "-C", dir, "runtime"]);
  return new Uint8Array(readFileSync(tarPath));
}

describe("untar", () => {
  it("extracts files and directories with correct contents", () => {
    const entries = untar(makeTar());
    const file = entries.find((e) => e.path === "runtime/hello.txt");
    expect(file?.type).toBe("file");
    expect(new TextDecoder().decode(file!.data)).toBe("hello nvim\n");
    expect(entries.some((e) => e.path.replace(/\/$/, "") === "runtime/lua" && e.type === "dir")).toBe(true);
    expect(entries.find((e) => e.path === "runtime/lua/init.lua")).toBeTruthy();
  });

  it("returns empty for empty archive terminator", () => {
    expect(untar(new Uint8Array(1024))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/engine/untar.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/engine/untar.ts
export interface TarEntry { path: string; type: "file" | "dir"; data: Uint8Array }

const dec = new TextDecoder();
const field = (b: Uint8Array, off: number, len: number) =>
  dec.decode(b.subarray(off, off + len)).replace(/\0.*$/, "");
const octal = (b: Uint8Array, off: number, len: number) =>
  parseInt(field(b, off, len).trim() || "0", 8);

export function untar(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let pos = 0;
  while (pos + 512 <= bytes.length) {
    const header = bytes.subarray(pos, pos + 512);
    if (header.every((x) => x === 0)) break; // terminator
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const fullPath = prefix ? `${prefix}/${name}` : name;
    pos += 512;
    const dataEnd = pos + size;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      out.push({ path: fullPath, type: "file", data: bytes.slice(pos, dataEnd) });
    } else if (typeflag === "5") {
      out.push({ path: fullPath, type: "dir", data: new Uint8Array(0) });
    } // other typeflags (pax x/g, gnu L, symlinks): skip payload
    pos += Math.ceil(size / 512) * 512;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/engine/untar.test.ts` — Expected: 2 passed. (If macOS `tar` emits pax headers making the first test fail on a `PaxHeader` entry, that's the skip path working — assertions target real entries only.)

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/engine/untar.ts src/engine/untar.test.ts
git commit -m "feat: minimal ustar extractor for nvim runtime archive"
```

---

### Task 4: Key translation (`src/ui/keymap.ts`)

**Files:**
- Create: `src/ui/keymap.ts`, `src/ui/keymap.test.ts`

**Interfaces:**
- Produces: `function keyEventToNvim(ev: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): string | null` — returns nvim `nvim_input` notation, or `null` for events nvim shouldn't see (bare modifiers, unhandled). `ESCAPE_CHORD(ev): boolean` returns true for Ctrl+Shift+Escape.

- [ ] **Step 1: Write failing tests**

```ts
// src/ui/keymap.test.ts
import { describe, expect, it } from "vitest";
import { keyEventToNvim, isEscapeChord } from "./keymap";

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe("keyEventToNvim", () => {
  it("passes printable chars through", () => {
    expect(keyEventToNvim(ev("a"))).toBe("a");
    expect(keyEventToNvim(ev("A", { shiftKey: true }))).toBe("A");
  });
  it("escapes < as <lt>", () => {
    expect(keyEventToNvim(ev("<"))).toBe("<lt>");
  });
  it("maps special keys", () => {
    expect(keyEventToNvim(ev("Escape"))).toBe("<Esc>");
    expect(keyEventToNvim(ev("Enter"))).toBe("<CR>");
    expect(keyEventToNvim(ev("Backspace"))).toBe("<BS>");
    expect(keyEventToNvim(ev("Tab"))).toBe("<Tab>");
    expect(keyEventToNvim(ev("ArrowLeft"))).toBe("<Left>");
  });
  it("applies modifiers", () => {
    expect(keyEventToNvim(ev("w", { ctrlKey: true }))).toBe("<C-w>");
    expect(keyEventToNvim(ev("x", { altKey: true }))).toBe("<M-x>");
    expect(keyEventToNvim(ev("Enter", { ctrlKey: true }))).toBe("<C-CR>");
    expect(keyEventToNvim(ev("R", { ctrlKey: true, shiftKey: true }))).toBe("<C-S-R>");
  });
  it("ignores bare modifier keys", () => {
    expect(keyEventToNvim(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(keyEventToNvim(ev("Control", { ctrlKey: true }))).toBeNull();
  });
  it("detects the escape chord and never translates it", () => {
    const chord = ev("Escape", { ctrlKey: true, shiftKey: true });
    expect(isEscapeChord(chord)).toBe(true);
    expect(keyEventToNvim(chord)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ui/keymap.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/ui/keymap.ts
type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

const SPECIAL: Record<string, string> = {
  Escape: "Esc", Enter: "CR", Backspace: "BS", Tab: "Tab", Delete: "Del",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  " ": "Space",
};
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

export function isEscapeChord(ev: KeyLike): boolean {
  return ev.key === "Escape" && ev.ctrlKey && ev.shiftKey;
}

export function keyEventToNvim(ev: KeyLike): string | null {
  if (isEscapeChord(ev)) return null;
  if (MODIFIER_KEYS.has(ev.key)) return null;
  const special = SPECIAL[ev.key];
  const isPrintable = !special && ev.key.length === 1;
  if (!special && !isPrintable) return null;

  let mods = "";
  if (ev.ctrlKey) mods += "C-";
  if (ev.altKey) mods += "M-";
  if (ev.metaKey) mods += "D-";
  // Shift is only explicit for special keys or when combined with other mods;
  // printable chars already carry case ("A" vs "a").
  if (ev.shiftKey && (special || mods)) {
    if (!(isPrintable && !mods)) mods += "S-";
  }
  // Reorder to nvim's canonical C-S / C-M order: C, S, M, D
  const order = ["C-", "S-", "M-", "D-"];
  const present = order.filter((m) => mods.includes(m));
  mods = present.join("");

  const base = special ?? ev.key;
  if (base === "<") return "<lt>";
  if (!mods && isPrintable) return base;
  return `<${mods}${base}>`;
}
```

**Note:** the `<C-S-R>` test pins the modifier order `C-S-`; make sure the reorder logic yields exactly that. If a test disagrees with the implementation sketch, the test wins — adjust the implementation.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/ui/keymap.test.ts` — Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/ui/keymap.ts src/ui/keymap.test.ts
git commit -m "feat: DOM key event to nvim_input notation translator"
```

---

### Task 5: Engine worker — WASI + Asyncify driver (`src/engine/worker.ts`)

**Files:**
- Create: `src/engine/worker.ts`, `tsconfig.worker.json`
- Modify: `package.json` (typecheck script), `scripts/build.mjs` (worker entry)

**Interfaces:**
- Consumes: `untar` from Task 3.
- Produces (postMessage protocol, all `{ type, ... }` objects):
  - page → worker: `{ type: "start", wasmUrl: string, runtimeUrl: string }`, `{ type: "stdin", chunk: Uint8Array }` (transferable)
  - worker → page: `{ type: "ready" }` (before `_start`), `{ type: "stdout", chunk: Uint8Array }`, `{ type: "exit", code: number }`, `{ type: "fatal", message: string }`, `{ type: "stat", wakeupsPerSecond: number }` (emitted every 5s — the idle-CPU gate instrument)
- This worker is browser-only; no vitest. Verification is Task 6's boot. Typecheck must pass under `tsconfig.worker.json` (lib: WebWorker, no DOM).

- [ ] **Step 1: Worker tsconfig + build entry**

`tsconfig.worker.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "lib": ["ES2022", "WebWorker"], "types": [] },
  "include": ["src/engine/worker.ts", "src/engine/untar.ts"]
}
```
In root `tsconfig.json` `"exclude"`: add `["src/engine/worker.ts"]`. In `package.json`: `"typecheck": "tsc --noEmit && tsc -p tsconfig.worker.json"`. In `scripts/build.mjs` add entry `{ in: path.join(root, "src", "engine", "worker.ts"), out: "engine-worker" }` and copy vendored assets:
```js
await cp(path.join(root, "vendor", "nvim-wasm", "nvim-asyncify.wasm"), path.join(outDir, "nvim-asyncify.wasm"));
await cp(path.join(root, "vendor", "nvim-wasm", "nvim-runtime.tar.gz"), path.join(outDir, "nvim-runtime.tar.gz"));
```
Guard with a clear error telling the developer to run `npm run fetch-assets` if missing.

- [ ] **Step 2: Implement the worker**

The complete file. Key facts (verified against nvim-wasm research): only `wasi_snapshot_preview1.poll_oneoff` is asyncified; the driver uses Binaryen's standard Asyncify ABI exports `asyncify_start_unwind(dataPtr)`, `asyncify_stop_unwind()`, `asyncify_start_rewind(dataPtr)`, `asyncify_stop_rewind()`, `asyncify_get_state()` (0=normal,1=unwinding,2=rewinding). We allocate the Asyncify scratch region by growing memory ourselves and writing `[start+8, end]` into its first two i32s.

```ts
// src/engine/worker.ts
import { Directory, File, OpenFile, PreopenDirectory, WASI, ConsoleStdout, wasi as wasiDefs } from "@bjorn3/browser_wasi_shim";
import { untar } from "./untar";

type StartMsg = { type: "start"; wasmUrl: string; runtimeUrl: string };
type StdinMsg = { type: "stdin"; chunk: Uint8Array };

const ASYNCIFY_PAGES = 64; // 4 MiB scratch
let wakeups = 0;

function buildTree(entries: ReturnType<typeof untar>): Map<string, any> {
  const root = new Map<string, any>();
  const dirFor = (segments: string[]): Map<string, any> => {
    let cur = root;
    for (const seg of segments) {
      if (!cur.has(seg)) cur.set(seg, new Directory(new Map()));
      const d = cur.get(seg);
      cur = d.contents;
    }
    return cur;
  };
  for (const e of entries) {
    const parts = e.path.replace(/\/+$/, "").split("/").filter(Boolean);
    if (e.type === "dir") { dirFor(parts); continue; }
    const dir = dirFor(parts.slice(0, -1));
    dir.set(parts[parts.length - 1], new File(e.data));
  }
  return root;
}

self.onmessage = async (first: MessageEvent) => {
  const msg = first.data as StartMsg;
  if (msg.type !== "start") return;
  try {
    await run(msg);
  } catch (e) {
    self.postMessage({ type: "fatal", message: String(e) });
  }
};

async function run(msg: StartMsg) {
  const [wasmBytes, runtimeGz] = await Promise.all([
    fetch(msg.wasmUrl).then((r) => r.arrayBuffer()),
    fetch(msg.runtimeUrl).then((r) => r.arrayBuffer()),
  ]);
  const gunzipped = new Uint8Array(
    await new Response(
      new Blob([runtimeGz]).stream().pipeThrough(new DecompressionStream("gzip"))
    ).arrayBuffer()
  );
  const tree = buildTree(untar(gunzipped));

  // stdin: queue fed by postMessage; a pending waker resolves the poll promise
  const stdinQueue: Uint8Array[] = [];
  let stdinWaker: (() => void) | null = null;
  self.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data as StdinMsg;
    if (m.type === "stdin") {
      stdinQueue.push(m.chunk);
      stdinWaker?.();
      stdinWaker = null;
    }
  });

  // Custom stdin Fd: non-blocking reads from the queue (EAGAIN when empty).
  class StdinFd extends OpenFile {
    constructor() { super(new File(new Uint8Array(0))); }
    override fd_read(size: number): { ret: number; data: Uint8Array } {
      if (stdinQueue.length === 0) return { ret: wasiDefs.ERRNO_AGAIN, data: new Uint8Array(0) };
      const head = stdinQueue[0];
      if (head.length <= size) { stdinQueue.shift(); wakeups++; return { ret: 0, data: head }; }
      stdinQueue[0] = head.subarray(size);
      return { ret: 0, data: head.subarray(0, size) };
    }
  }

  const stdout = ConsoleStdout.lineBuffered ? null : null; // not used; custom below
  class StdoutFd extends OpenFile {
    constructor() { super(new File(new Uint8Array(0))); }
    override fd_write(data: Uint8Array): { ret: number; nwritten: number } {
      const copy = data.slice();
      (self as unknown as Worker).postMessage({ type: "stdout", chunk: copy }, [copy.buffer]);
      return { ret: 0, nwritten: data.length };
    }
  }
  class StderrFd extends OpenFile {
    constructor() { super(new File(new Uint8Array(0))); }
    override fd_write(data: Uint8Array): { ret: number; nwritten: number } {
      console.warn("[nvim stderr]", new TextDecoder().decode(data));
      return { ret: 0, nwritten: data.length };
    }
  }

  const home = new Map<string, any>();
  home.set(".config", new Directory(new Map()));
  home.set(".local", new Directory(new Map([["share", new Directory(new Map())]])));
  const fds = [
    new StdinFd(), new StdoutFd(), new StderrFd(),
    new PreopenDirectory("/nvim", tree),
    new PreopenDirectory("/home", home),
    new PreopenDirectory("/tmp", new Map()),
  ];
  const argv = ["nvim", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"];
  const env = ["HOME=/home", "VIMRUNTIME=/nvim/runtime", "TMPDIR=/tmp", "NVIM_LOG_FILE=/tmp/nvim.log"];
  const wasiInst = new WASI(argv, env, fds, { debug: false });

  // Asyncify plumbing around poll_oneoff
  let exports: any;
  let asyncifyDataPtr = 0;
  let pendingPoll: { args: number[] } | null = null;
  let wakePromise: Promise<void> | null = null;

  const wasiImport: Record<string, unknown> = { ...wasiInst.wasiImport };
  const realPoll = wasiInst.wasiImport.poll_oneoff?.bind(wasiInst.wasiImport);
  wasiImport.poll_oneoff = (inPtr: number, outPtr: number, nsubs: number, neventsPtr: number) => {
    if (exports.asyncify_get_state() === 2) {
      // rewinding: resume normally, report the (now-ready) events
      exports.asyncify_stop_rewind();
      pendingPoll = null;
      return pollReady(inPtr, outPtr, nsubs, neventsPtr);
    }
    const ready = pollReady(inPtr, outPtr, nsubs, neventsPtr, /*probe*/ true);
    if (ready !== null) return pollReady(inPtr, outPtr, nsubs, neventsPtr);
    // nothing ready: suspend
    pendingPoll = { args: [inPtr, outPtr, nsubs, neventsPtr] };
    wakePromise = wakeFor(inPtr, nsubs);
    exports.asyncify_start_unwind(asyncifyDataPtr);
    return 0;
  };

  // Reads the subscription list; if any stdin sub and queue non-empty (or any
  // clock deadline already passed) -> can complete now. probe=true returns
  // null when it would block instead of writing events.
  function pollReady(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number, probe = false): number | null {
    const mem = new DataView(exports.memory.buffer);
    let stdinWanted = false;
    let minDeadlineNs: bigint | null = null;
    for (let i = 0; i < nsubs; i++) {
      const sub = inPtr + i * 48; // sizeof(subscription)
      const tag = mem.getUint8(sub + 8);
      if (tag === 0) { // clock
        const timeoutNs = mem.getBigUint64(sub + 24, true);
        if (minDeadlineNs === null || timeoutNs < minDeadlineNs) minDeadlineNs = timeoutNs;
      } else { // fd_read/fd_write
        const fd = mem.getUint32(sub + 16, true);
        if (tag === 1 && fd === 0) stdinWanted = true;
      }
    }
    const stdinReady = stdinWanted && stdinQueue.length > 0;
    const timerFired = minDeadlineNs !== null && minDeadlineNs === 0n;
    if (!stdinReady && !timerFired && probe) return null;
    if (probe) return 0;
    // write events: one event per ready sub; minimal correct encoding
    let nevents = 0;
    for (let i = 0; i < nsubs; i++) {
      const sub = inPtr + i * 48;
      const userdata = mem.getBigUint64(sub, true);
      const tag = mem.getUint8(sub + 8);
      const fd = tag !== 0 ? mem.getUint32(sub + 16, true) : 0;
      const fire =
        (tag === 0) || (tag === 1 && fd === 0 && stdinQueue.length > 0);
      if (!fire) continue;
      const evt = outPtr + nevents * 32; // sizeof(event)
      mem.setBigUint64(evt, userdata, true);
      mem.setUint16(evt + 8, 0, true); // errno success
      mem.setUint8(evt + 10, tag);
      if (tag === 1) mem.setBigUint64(evt + 16, BigInt(stdinQueue.reduce((n, c) => n + c.length, 0)), true);
      nevents++;
    }
    const memAfter = new DataView(exports.memory.buffer);
    memAfter.setUint32(neventsPtr, nevents, true);
    return 0;
  }

  function wakeFor(inPtr: number, nsubs: number): Promise<void> {
    const mem = new DataView(exports.memory.buffer);
    let timeoutMs: number | null = null;
    for (let i = 0; i < nsubs; i++) {
      const sub = inPtr + i * 48;
      if (mem.getUint8(sub + 8) === 0) {
        const ns = mem.getBigUint64(sub + 24, true);
        const ms = Number(ns / 1000000n);
        if (timeoutMs === null || ms < timeoutMs) timeoutMs = ms;
      }
    }
    const waiters: Promise<void>[] = [new Promise<void>((res) => { stdinWaker = res; })];
    if (timeoutMs !== null) waiters.push(new Promise((res) => setTimeout(res, timeoutMs)));
    return Promise.race(waiters);
  }

  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasiImport as WebAssembly.ModuleImports,
  });
  exports = instance.exports as any;
  wasiInst.inst = instance as any;

  // Allocate asyncify scratch: grow memory, region = [ptr+8, end]
  const memory: WebAssembly.Memory = exports.memory;
  const basePages = memory.grow(ASYNCIFY_PAGES);
  asyncifyDataPtr = basePages * 65536;
  const dv = new DataView(memory.buffer);
  dv.setUint32(asyncifyDataPtr, asyncifyDataPtr + 8, true);
  dv.setUint32(asyncifyDataPtr + 4, asyncifyDataPtr + ASYNCIFY_PAGES * 65536, true);

  self.postMessage({ type: "ready" });

  setInterval(() => {
    self.postMessage({ type: "stat", wakeupsPerSecond: wakeups / 5 });
    wakeups = 0;
  }, 5000);

  // Asyncify driver loop
  try {
    exports._start();
    while (exports.asyncify_get_state() === 1) {
      exports.asyncify_stop_unwind();
      wakeups++;
      await wakePromise!;
      exports.asyncify_start_rewind(asyncifyDataPtr);
      exports._start();
    }
    self.postMessage({ type: "exit", code: 0 });
  } catch (e) {
    if ((e as { code?: number }).code !== undefined) {
      self.postMessage({ type: "exit", code: (e as { code: number }).code });
    } else {
      self.postMessage({ type: "fatal", message: String(e) });
    }
  }
}
```

**Implementation notes (read before coding):**
- `@bjorn3/browser_wasi_shim@0.4.x` export names: verify `OpenFile`, `File`, `Directory`, `PreopenDirectory`, `WASI`, and the errno constants module (`wasi` namespace with `ERRNO_AGAIN`) against `node_modules/@bjorn3/browser_wasi_shim/dist/index.d.ts` — adjust imports/overrides to the actual signatures (e.g. `fd_read` in 0.4 takes `(size: number)` and returns `{ ret, data }`; if the installed version differs, adapt: the tests are Task 6's boot, not names).
- The wasi struct offsets (subscription=48 bytes, event=32 bytes, clock timeout at +24, fd at +16, tag at +8) are from the WASI preview1 ABI. If nvim hangs or misbehaves at boot, dump the first poll's subscription bytes and re-derive.
- `PreopenDirectory` constructor in 0.4.2 takes `(name, Map)`.
- If `_start` traps immediately with an Asyncify state error, the scratch-region init or the unwind/rewind sequence is wrong — compare `asyncify_get_state()` transitions first.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck` — Expected: clean under both tsconfigs.
Run: `npm run fetch-assets` then `npm run build` — Expected: `dist/chromium/` now contains `engine-worker.js`, `nvim-asyncify.wasm`, `nvim-runtime.tar.gz`.

- [ ] **Step 4: Commit**

```bash
git add src/engine/worker.ts tsconfig.worker.json tsconfig.json package.json scripts/build.mjs
git commit -m "feat: WASI asyncify engine worker hosting nvim --embed"
```

---

### Task 6: Engine frame — client, renderer, first boot (`src/engine-frame/`)

**Files:**
- Create: `src/engine-frame/engine-frame.html`, `src/engine-frame/engine-frame.ts`, `src/engine/client.ts`, `src/ui/grid-renderer.ts`
- Modify: `scripts/build.mjs` (entries + html copy), `src/manifest.json` (CSP + web_accessible_resources), `src/scratch/scratch.html` + `src/scratch/scratch.ts` (host the frame full-page)

**Interfaces:**
- Consumes: `NvimRpc` (Task 2), `keyEventToNvim`/`isEscapeChord` (Task 4), worker protocol (Task 5).
- Produces:
  - `class NvimClient { constructor(workerUrl: string, wasmUrl: string, runtimeUrl: string); start(cols: number, rows: number): Promise<void>; input(keys: string): void; request(m: string, p: unknown[]): Promise<unknown>; onRedraw: (batch: unknown[]) => void; onExit: (code: number) => void; onStat: (wps: number) => void }`
  - `class GridRenderer { constructor(canvas: HTMLCanvasElement); apply(batch: unknown[]): void; resizeToFit(cols: number, rows: number): void }` — handles `grid_resize`, `default_colors_set`, `hl_attr_define`, `grid_line`, `grid_clear`, `grid_cursor_goto`, `grid_scroll`, `flush`, `mode_change` (block vs bar cursor). Single grid (grid 1) only.
  - `engine-frame.html?mode=embed|full` — `full` used by scratch page; `embed` (Task 7) syncs with a parent via postMessage.

- [ ] **Step 1: Implement `NvimClient`**

```ts
// src/engine/client.ts
import { NvimRpc } from "./rpc";

export class NvimClient {
  onRedraw: (batch: unknown[]) => void = () => {};
  onExit: (code: number) => void = () => {};
  onStat: (wps: number) => void = () => {};
  private worker: Worker;
  private rpc: NvimRpc;

  constructor(workerUrl: string, private wasmUrl: string, private runtimeUrl: string) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.rpc = new NvimRpc((bytes) => {
      const copy = bytes.slice();
      this.worker.postMessage({ type: "stdin", chunk: copy }, [copy.buffer]);
    });
    this.rpc.onNotification = (method, args) => {
      if (method === "redraw") this.onRedraw(args);
    };
  }

  start(cols: number, rows: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "ready") {
          void this.rpc
            .request("nvim_ui_attach", [cols, rows, { rgb: true, ext_linegrid: true }])
            .then(() => resolve(), reject);
        } else if (m.type === "stdout") this.rpc.feed(m.chunk);
        else if (m.type === "exit") this.onExit(m.code);
        else if (m.type === "fatal") reject(new Error(m.message));
        else if (m.type === "stat") this.onStat(m.wakeupsPerSecond);
      };
      this.worker.postMessage({ type: "start", wasmUrl: this.wasmUrl, runtimeUrl: this.runtimeUrl });
    });
  }

  input(keys: string): void { this.rpc.notify("nvim_input", [keys]); }
  request(m: string, p: unknown[]): Promise<unknown> { return this.rpc.request(m, p); }
  dispose(): void { this.worker.terminate(); }
}
```

- [ ] **Step 2: Implement `GridRenderer`**

```ts
// src/ui/grid-renderer.ts
interface Cell { text: string; hl: number }
interface HlAttr { fg?: number; bg?: number; bold?: boolean; italic?: boolean; underline?: boolean; reverse?: boolean }

export class GridRenderer {
  private ctx: CanvasRenderingContext2D;
  private cols = 0; private rows = 0;
  private cells: Cell[][] = [];
  private hl = new Map<number, HlAttr>();
  private defaultFg = 0xcdd6f4; private defaultBg = 0x1e1e2e;
  private cursor = { row: 0, col: 0 };
  private cursorShape: "block" | "bar" = "block";
  private cellW = 9; private cellH = 18; private baseline = 14;
  private dirty = false; private rafPending = false;

  constructor(private canvas: HTMLCanvasElement, private font = "14px ui-monospace, Menlo, monospace") {
    this.ctx = canvas.getContext("2d")!;
    this.measure();
  }

  private measure(): void {
    this.ctx.font = this.font;
    const m = this.ctx.measureText("M");
    this.cellW = Math.ceil(m.width);
    this.cellH = Math.ceil((m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * 1.35);
    this.baseline = Math.ceil(m.actualBoundingBoxAscent * 1.15);
  }

  sizeForGrid(cols: number, rows: number): { width: number; height: number } {
    return { width: cols * this.cellW, height: rows * this.cellH };
  }
  gridForSize(width: number, height: number): { cols: number; rows: number } {
    return { cols: Math.max(20, Math.floor(width / this.cellW)), rows: Math.max(4, Math.floor(height / this.cellH)) };
  }

  apply(batch: unknown[]): void {
    for (const entry of batch as [string, ...unknown[][]][]) {
      const [name, ...calls] = entry;
      for (const args of calls) this.handle(name, args as unknown[]);
    }
  }

  private handle(name: string, a: unknown[]): void {
    switch (name) {
      case "grid_resize": { const [, c, r] = a as number[]; this.cols = c; this.rows = r;
        this.cells = Array.from({ length: r }, () => Array.from({ length: c }, () => ({ text: " ", hl: 0 })));
        const size = this.sizeForGrid(c, r);
        this.canvas.width = size.width * devicePixelRatio; this.canvas.height = size.height * devicePixelRatio;
        this.canvas.style.width = `${size.width}px`; this.canvas.style.height = `${size.height}px`;
        this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        break; }
      case "default_colors_set": { const [fg, bg] = a as number[];
        if (fg >= 0) this.defaultFg = fg; if (bg >= 0) this.defaultBg = bg; break; }
      case "hl_attr_define": { const [id, attr] = a as [number, HlAttr]; this.hl.set(id, attr ?? {}); break; }
      case "grid_line": { const [, row, colStart, cellsArg] = a as [number, number, number, [string, number?, number?][]];
        let col = colStart; let hlId = 0;
        for (const cell of cellsArg) {
          const [text, maybeHl, repeat = 1] = cell;
          if (maybeHl !== undefined) hlId = maybeHl;
          for (let i = 0; i < repeat; i++) { if (this.cells[row]?.[col]) this.cells[row][col] = { text, hl: hlId }; col++; }
        }
        break; }
      case "grid_clear": this.cells.forEach((r) => r.forEach((c) => { c.text = " "; c.hl = 0; })); break;
      case "grid_cursor_goto": { const [, r, c] = a as number[]; this.cursor = { row: r, col: c }; break; }
      case "grid_scroll": { const [, top, bot, left, right, rows] = a as number[];
        if (rows > 0) for (let r = top; r < bot - rows; r++) for (let c = left; c < right; c++) this.cells[r][c] = this.cells[r + rows][c];
        else if (rows < 0) for (let r = bot - 1; r >= top - rows; r--) for (let c = left; c < right; c++) this.cells[r][c] = this.cells[r + rows][c];
        break; }
      case "mode_change": { const [mode] = a as [string]; this.cursorShape = mode.startsWith("insert") || mode.startsWith("cmdline") ? "bar" : "block"; break; }
      case "flush": this.scheduleDraw(); break;
    }
  }

  private scheduleDraw(): void {
    this.dirty = true;
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => { this.rafPending = false; if (this.dirty) { this.dirty = false; this.draw(); } });
  }

  private color(n: number | undefined, fallback: number): string {
    const v = n ?? fallback;
    return `#${v.toString(16).padStart(6, "0")}`;
  }

  private draw(): void {
    const { ctx } = this;
    ctx.font = this.font;
    ctx.fillStyle = this.color(undefined, this.defaultBg);
    ctx.fillRect(0, 0, this.cols * this.cellW, this.rows * this.cellH);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = this.cells[r][c];
        const attr = this.hl.get(cell.hl) ?? {};
        let fg = attr.reverse ? attr.bg ?? this.defaultBg : attr.fg ?? this.defaultFg;
        let bg = attr.reverse ? attr.fg ?? this.defaultFg : attr.bg ?? this.defaultBg;
        if (bg !== this.defaultBg) { ctx.fillStyle = this.color(bg, this.defaultBg); ctx.fillRect(c * this.cellW, r * this.cellH, this.cellW, this.cellH); }
        if (cell.text !== " ") { ctx.fillStyle = this.color(fg, this.defaultFg); ctx.fillText(cell.text, c * this.cellW, r * this.cellH + this.baseline); }
      }
    }
    // cursor
    const { row, col } = this.cursor;
    ctx.fillStyle = this.color(undefined, this.defaultFg);
    if (this.cursorShape === "block") {
      ctx.globalAlpha = 0.7;
      ctx.fillRect(col * this.cellW, row * this.cellH, this.cellW, this.cellH);
      ctx.globalAlpha = 1;
      const cell = this.cells[row]?.[col];
      if (cell && cell.text !== " ") { ctx.fillStyle = this.color(undefined, this.defaultBg); ctx.fillText(cell.text, col * this.cellW, row * this.cellH + this.baseline); }
    } else {
      ctx.fillRect(col * this.cellW, row * this.cellH, 2, this.cellH);
    }
  }
}
```

- [ ] **Step 3: Engine frame page**

`src/engine-frame/engine-frame.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>nvim</title>
    <style>html,body{margin:0;background:#1e1e2e;overflow:hidden;height:100%}canvas{display:block}</style>
  </head>
  <body><canvas id="grid" tabindex="0"></canvas><script type="module" src="./engine-frame.js"></script></body>
</html>
```

`src/engine-frame/engine-frame.ts`:
```ts
import { NvimClient } from "../engine/client";
import { GridRenderer } from "../ui/grid-renderer";
import { isEscapeChord, keyEventToNvim } from "../ui/keymap";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "full";
const canvas = document.getElementById("grid") as HTMLCanvasElement;
const renderer = new GridRenderer(canvas);
const client = new NvimClient(
  chrome.runtime.getURL("engine-worker.js"),
  chrome.runtime.getURL("nvim-asyncify.wasm"),
  chrome.runtime.getURL("nvim-runtime.tar.gz"),
);
client.onRedraw = (batch) => renderer.apply(batch);
client.onStat = (wps) => console.log(`[nvim] poll wakeups/sec: ${wps}`);
client.onExit = () => parent.postMessage({ type: "nvim-deactivate", text: null }, "*");

const { cols, rows } = renderer.gridForSize(innerWidth, innerHeight);

document.addEventListener("keydown", (ev) => {
  if (isEscapeChord(ev)) { ev.preventDefault(); void deactivate(); return; }
  const keys = keyEventToNvim(ev);
  if (keys !== null) { ev.preventDefault(); client.input(keys); }
});

async function currentText(): Promise<string> {
  const lines = (await client.request("nvim_buf_get_lines", [0, 0, -1, false])) as string[];
  return lines.join("\n");
}

async function deactivate(): Promise<void> {
  const text = await currentText();
  parent.postMessage({ type: "nvim-deactivate", text }, "*");
}

window.addEventListener("message", async (ev) => {
  const m = ev.data;
  if (m?.type === "nvim-init") {
    await client.start(cols, rows);
    if (typeof m.text === "string" && m.text.length > 0) {
      await client.request("nvim_buf_set_lines", [0, 0, -1, false, m.text.split("\n")]);
    }
    // TextChanged sync: poll-free push via autocmd -> rpcnotify
    await client.request("nvim_exec2", [
      "autocmd TextChanged,TextChangedI * call rpcnotify(1, 'wasm_text_changed')", {},
    ]);
    parent.postMessage({ type: "nvim-ready" }, "*");
    canvas.focus();
  }
});

// debounce buffer pulls on change notifications
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const rpcAny = client as unknown as { rpc?: unknown };
client["onNotificationHook"] = undefined; // placeholder; see note below

if (mode === "full") {
  void client.start(cols, rows).then(() => canvas.focus());
}
```

**Implementation note:** `NvimClient` must expose notification pass-through: add to `NvimClient` a public `onEvent: (method: string, args: unknown[]) => void` invoked from `rpc.onNotification` for methods ≠ `redraw`, and in `engine-frame.ts` (embed mode) subscribe: on `wasm_text_changed`, debounce 300 ms then `currentText()` → `parent.postMessage({ type: "nvim-text", text }, "*")`. Remove the placeholder lines above; the plan's Task 7 content script consumes `nvim-ready`, `nvim-text`, `nvim-deactivate`.

- [ ] **Step 4: Build wiring + manifest + scratch page**

`scripts/build.mjs`: add entries `{ in: src/engine-frame/engine-frame.ts, out: "engine-frame" }`; copy `engine-frame.html`. `src/manifest.json` additions:
```json
"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
"web_accessible_resources": [{
  "resources": ["engine-frame.html", "engine-frame.js", "engine-worker.js", "nvim-asyncify.wasm", "nvim-runtime.tar.gz"],
  "matches": ["<all_urls>"]
}]
```
`src/scratch/scratch.html`: replace the placeholder `<main>` with `<iframe id="nvim" src="./engine-frame.html?mode=full" style="border:0;width:100vw;height:100vh"></iframe>`; `scratch.ts` shrinks to nothing (delete the version line and keep an empty module or drop the script tag + entry).

- [ ] **Step 5: Boot verification (manual gate — spike gate 1)**

Run: `npm run fetch-assets`, `npm run build`. Load `dist/chromium` via `chrome://extensions` → Load unpacked (or `chrome-debug --load-extension=$PWD/dist/chromium`). Click the toolbar button → scratch page opens.
Expected: nvim boots — you see the intro screen / an editable buffer. Type `ihello world<Esc>`, then `:q!` typed keys echo in the grid. In DevTools console of the frame, `[nvim] poll wakeups/sec:` lines appear.
If boot fails: check worker console for `fatal`; debug per Task 5 notes before proceeding.

- [ ] **Step 6: Typecheck, test, commit**

```bash
npm run typecheck
npm test
git add src/engine-frame src/engine/client.ts src/ui/grid-renderer.ts src/manifest.json src/scratch scripts/build.mjs
git commit -m "feat: engine frame with nvim client, canvas grid renderer, scratch boot"
```

---

### Task 7: Textarea overlay content script

**Files:**
- Create: `src/content/overlay.ts`, `test-pages/textarea.html`
- Modify: `src/background.ts`, `src/manifest.json`, `scripts/build.mjs` (content entry; content script must be bundled IIFE, not ESM — add `format: "iife"` via a second esbuild call for this entry)

**Interfaces:**
- Consumes: frame messages `nvim-ready`, `nvim-text`, `nvim-deactivate` (Task 6); sends `nvim-init`.
- Produces: activation flow — keyboard command `activate-nvim` (default `Ctrl+Shift+E`) → background `chrome.commands.onCommand` → `chrome.tabs.sendMessage(tabId, { type: "nvim-activate" })` → content script overlays the focused textarea/eligible input.

- [ ] **Step 1: Manifest + background**

`src/manifest.json` additions:
```json
"permissions": [],
"commands": {
  "activate-nvim": {
    "suggested_key": { "default": "Ctrl+Shift+E", "mac": "MacCtrl+Shift+E" },
    "description": "Activate Neovim on the focused text field"
  }
},
"content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle" }]
```
`src/background.ts` addition:
```ts
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "activate-nvim" && tab?.id !== undefined) {
    void chrome.tabs.sendMessage(tab.id, { type: "nvim-activate" });
  }
});
```

- [ ] **Step 2: Implement the overlay**

```ts
// src/content/overlay.ts
const ELIGIBLE_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);

type Target = HTMLTextAreaElement | HTMLInputElement;
let active: { frame: HTMLIFrameElement; target: Target } | null = null;

function eligibleTarget(): Target | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && ELIGIBLE_INPUT_TYPES.has(el.type)) return el;
  return null;
}

// React/Vue controlled components ignore plain .value writes; go through the
// native setter and fire a synthetic input event so frameworks see the change.
function setNativeValue(el: Target, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function positionFrame(frame: HTMLIFrameElement, target: Target): void {
  const rect = target.getBoundingClientRect();
  const minH = 220; // comfortable multi-row strip even over small inputs
  frame.style.cssText = [
    "position:fixed", "z-index:2147483647", "border:1px solid #45475a",
    "box-shadow:0 8px 32px rgba(0,0,0,.5)", "border-radius:6px", "background:#1e1e2e",
    `left:${Math.max(4, rect.left)}px`,
    `top:${Math.max(4, rect.top)}px`,
    `width:${Math.max(rect.width, 480)}px`,
    `height:${Math.max(rect.height, minH)}px`,
  ].join(";");
}

function activate(): void {
  if (active) return;
  const target = eligibleTarget();
  if (!target) return;
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("engine-frame.html?mode=embed");
  frame.allow = "clipboard-read; clipboard-write";
  positionFrame(frame, target);
  document.body.appendChild(frame);
  active = { frame, target };

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (m?.type === "nvim-text" && active) {
      setNativeValue(active.target, m.text);
    } else if (m?.type === "nvim-deactivate") {
      if (typeof m.text === "string" && active) setNativeValue(active.target, m.text);
      deactivate();
    }
  };
  window.addEventListener("message", onMessage);

  frame.addEventListener("load", () => {
    frame.contentWindow?.postMessage({ type: "nvim-init", text: target.value }, "*");
    frame.contentWindow?.focus();
  });

  const cleanupOnScroll = (): void => { if (active) positionFrame(active.frame, active.target); };
  window.addEventListener("scroll", cleanupOnScroll, true);

  function deactivate(): void {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("scroll", cleanupOnScroll, true);
    active?.frame.remove();
    const t = active?.target;
    active = null;
    t?.focus();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "nvim-activate") activate();
});
```

- [ ] **Step 3: Build wiring**

In `scripts/build.mjs`, add a second `build()` call for the content script (content scripts can't be ESM):
```js
await build({
  entryPoints: [{ in: path.join(root, "src", "content", "overlay.ts"), out: "content" }],
  outdir: outDir, bundle: true, format: "iife", target: "chrome120", minify: true,
});
```

- [ ] **Step 4: Fixture page**

`test-pages/textarea.html` (repo-local, opened via `file://` for manual testing):
```html
<!doctype html>
<html><body>
  <h1>overlay fixture</h1>
  <textarea rows="8" cols="60">The quick brown fox.</textarea>
  <form onsubmit="document.title='SUBMITTED:'+this.q.value;return false">
    <input name="q" type="text" value="single line" />
    <button>submit</button>
  </form>
  <input type="password" value="never-touch-me" />
</body></html>
```

- [ ] **Step 5: Manual verification (spike gate 1 complete)**

Run: `npm run build`, reload the extension, open `test-pages/textarea.html`, click into the textarea, press `Ctrl+Shift+E`.
Expected:
- Overlay appears over the textarea with the buffer containing "The quick brown fox."
- `ciwslow<Esc>` changes the first word; after ~300 ms the underlying textarea shows "slow quick brown fox." (wait: `ciw` on first word gives "slow quick brown fox.")
- `Ctrl+Shift+Esc` closes the overlay, final text synced, focus returns to the textarea.
- Focus the single-line input, activate, edit, `Ctrl+Shift+Esc` — value syncs. Password field: activation does nothing.
- Repeat once on a real site (e.g. GitHub comment box) — overlay works; note any breakage as journal observations, not blockers.

- [ ] **Step 6: Typecheck, test, commit**

```bash
npm run typecheck
npm test
git add src/content src/background.ts src/manifest.json scripts/build.mjs test-pages
git commit -m "feat: textarea/input overlay content script with activation command"
```

---

### Task 8: Idle-CPU gate, docs, release

**Files:**
- Modify: `README.md` (usage), `docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md` (milestone 1 status + any interface reality-corrections), `memory/journal/2026-07-14.md` (observations)

**Interfaces:** none new.

- [ ] **Step 1: Idle-CPU measurement (spike gate 2)**

With the scratch page open and nvim idle (normal mode, no input for 60s):
1. DevTools console: `[nvim] poll wakeups/sec:` must settle at **≤ 2** (0 is ideal; CursorHold/timers may legitimately tick once).
2. Chrome Task Manager (⋮ → More tools → Task Manager): the extension's CPU column must read **~0** at idle.
Record both numbers. If wakeups/sec is high (hundreds+), the poll suspension is broken — fix Task 5 before proceeding (this gate is blocking; do NOT rationalize it away).

- [ ] **Step 2: Update docs**

README: add "Usage" (load unpacked, toolbar button = scratch page, `Ctrl+Shift+E` = overlay, `Ctrl+Shift+Esc` = escape chord). Spec: mark Milestone 1 complete; correct any component descriptions that drifted during implementation (e.g. actual worker message protocol). Journal: record measured wakeups/sec, boot time, binary sizes, and any nvim-wasm quirks found.

- [ ] **Step 3: Full verification + commit**

```bash
npm run typecheck
npm test
npm run build
git add README.md docs memory 2>/dev/null || git add README.md docs
git commit -m "docs: milestone 1 spike results and usage"
```
(Note: `memory/` is gitignored; the `|| git add` fallback keeps the step from failing.)

- [ ] **Step 4: Release v0.2.0**

Run: `scripts/release.sh minor` (0.1.0 → 0.2.0).
Expected: PR opened + squash-merged, tag `v0.2.0`, GitHub release published with both zips (now containing the engine: ~15 MB each). Verify with `gh release view v0.2.0 --json assets`.

---

## Self-review notes

- **Spec coverage:** Milestone 1 spike scope only — engine host (Tasks 2,3,5,6), renderer + input (4,6), overlay + sync + single-line inputs + password exclusion (7), idle-CPU gate (5's stat + 8), escape chord (4,6). Virtual-FS persistence, config import, watchdog, threaded build: later milestones by design.
- **Known-risk areas flagged inline:** browser_wasi_shim 0.4.x API drift (Task 5 note), WASI poll ABI offsets (Task 5 note), asyncify scratch-region bootstrapping (Task 5 note), `@msgpack/msgpack` streaming decode (Task 2 note). Implementers must treat inline notes as part of the step.
- **Type consistency check:** worker protocol names (`start/stdin/stdout/ready/exit/fatal/stat`) match between Tasks 5 and 6; frame messages (`nvim-init/nvim-ready/nvim-text/nvim-deactivate`) match between Tasks 6 and 7; `keyEventToNvim`/`isEscapeChord` names match between Tasks 4 and 6.
