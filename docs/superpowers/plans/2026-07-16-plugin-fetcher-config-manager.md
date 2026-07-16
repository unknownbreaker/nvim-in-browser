# Plugin Fetcher + Config File-Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users install pure-Lua/Vimscript Neovim plugins (from GitHub `owner/repo` or a manual folder upload) and manage a full multi-file config tree, all from the options page, with no new extension permissions.

**Architecture:** New host-side units — a `plugins` IndexedDB store (shared DB bumped v2→v3), a pure GitHub fetcher over CORS-`*` endpoints, a pure pack-layout mapper, and a folder-upload reader — feed enabled plugin files plus config files into the existing `nvim-host` `configFiles` boot mechanism. Neovim auto-sources plugins from `pack/plugins/start`. The engine (`nvim-wasi`) is untouched.

**Tech Stack:** TypeScript, Chrome MV3, IndexedDB, `fetch` (options-page context), vitest (pure-unit only — node has no IndexedDB), Puppeteer browser smoke.

**Spec:** [docs/superpowers/specs/2026-07-16-plugin-fetcher-config-manager-design.md](../specs/2026-07-16-plugin-fetcher-config-manager-design.md)

## Global Constraints

- Engine (`nvim-wasi` `.wasm`/runtime + `src/engine/*` ABI) NOT modified — host-side TS + tests + docs only.
- Manifest permissions stay exactly `["clipboardRead", "clipboardWrite"]`. Fetch only `api.github.com` + `raw.githubusercontent.com` (both send `Access-Control-Allow-Origin: *`). Never an endpoint needing `host_permissions`.
- Default boot (no config, no enabled plugins) stays byte-identical: `resolveBoot` returns `{ usedConfig: false }` and `nvim-host` uses `NVIM_ARGV` with no `configFiles`.
- **Master switch:** the existing config `meta.enabled` gates EVERYTHING. `meta.enabled === false` → clean boot (no config files, no plugin files) regardless of per-plugin flags. When `true`, config files load iff `init.lua` is non-empty, and each plugin loads iff its own `enabled` is true.
- IndexedDB shared DB "nvim-in-browser": `onupgradeneeded` creates every store idempotently (`if (!db.objectStoreNames.contains(name))`); M2 `docs` + M4 `config` data must survive the v3 bump.
- Testing follows the codebase convention: pure logic gets vitest unit tests; IndexedDB round-trips and boot integration are proven by `scripts/browser-smoke.mjs` (node's vitest env has no IndexedDB — do NOT add fake-indexeddb).
- Plugin file `data` is `Uint8Array` end-to-end (config file content is `string`, encoded to bytes in `resolveBoot`). `pluginsToConfigFiles` emits `{ path, data: Uint8Array }` directly.
- WASI FS paths: config → `/home/.config/nvim/<relpath>`; plugins → `/home/.local/share/nvim/site/pack/plugins/start/<name>/<file.path>` (that site dir is on the default packpath; `HOME=/home`, `XDG_DATA_HOME=/home/.local/share`).
- Conventional commits. One command per Bash call (hook-enforced: no `;` `&&` `||` `|` `$(` backticks `>>` `<<`). Browser smokes rebuild dist — run sequentially, never concurrently. Chrome for Testing lives at `./chrome`.

## File Structure

**Create:**
- `src/storage/plugin-store.ts` — `plugins` IndexedDB store CRUD + `isSafePluginName`.
- `src/storage/plugin-store.test.ts` — unit tests for `isSafePluginName`.
- `src/plugins/github-fetch.ts` — pure GitHub fetcher (injectable `fetch`); `GithubFetchError`.
- `src/plugins/github-fetch.test.ts` — unit tests with a fake `fetch`.
- `src/plugins/pack-layout.ts` — pure `pluginsToConfigFiles`.
- `src/plugins/pack-layout.test.ts` — unit tests.
- `src/options/folder-upload.ts` — `readFolderUpload` + pure `toUploadRelpath`.
- `src/options/folder-upload.test.ts` — unit tests for `toUploadRelpath`.
- `src/options/options-plugins.ts` — plugin-manager UI module (Phase 2).
- `src/options/options-config.ts` — config file-manager UI module (Phase 3).

**Modify:**
- `src/storage/idb.ts` — `DB_VERSION = 3`, add `"plugins"` to `STORES`.
- `src/engine-frame/engine-frame.ts` — `resolveBoot()` unions config + enabled-plugin files under the master switch.
- `src/storage/config-store.ts` — add `deleteFile`, `renameFile` (Phase 3); export `isSafeRelpath` (already exported).
- `src/options/options.ts` — becomes a thin shell wiring the two UI modules (Phases 2–3).
- `src/options/options.html` — plugins section (Phase 2) + multi-file config section (Phase 3).
- `scripts/browser-smoke.mjs` — PHASE F (plugin enable/disable + multi-file config).
- `README.md`, the predecessor spec's tracker, memory doc (Phase 3 final).

---

## Phase 1 — Shared storage + boot plumbing

Goal: prove the whole engine/FS story via unit tests + browser-smoke PHASE F, with NO new UI (the smoke drives IndexedDB directly, exactly like PHASE C).

### Task 1: Plugin store + DB v3 bump

**Files:**
- Modify: `src/storage/idb.ts`
- Create: `src/storage/plugin-store.ts`, `src/storage/plugin-store.test.ts`

**Interfaces:**
- Produces:
  - `isSafePluginName(name: string): boolean` — true iff a single safe path segment: matches `/^[A-Za-z0-9._-]+$/`, not `.` or `..`, non-empty.
  - `interface PluginRecord { name: string; source: "github" | "upload"; repo?: string; ref?: string; enabled: boolean; files: { path: string; data: Uint8Array }[]; addedAt: number }`
  - `interface PluginStore { list(): Promise<PluginRecord[]>; add(rec: PluginRecord): Promise<void>; remove(name: string): Promise<void>; setEnabled(name: string, enabled: boolean): Promise<void>; get(name: string): Promise<PluginRecord | null> }`
  - `openPluginStore(): PluginStore`

- [ ] **Step 1: Write the failing test** — `src/storage/plugin-store.test.ts`

```ts
// Only the pure isSafePluginName validator is unit-tested; vitest's node env has
// no IndexedDB, so the plugin store's IDB round-trip is proven by the browser
// smoke (PHASE F), not here — mirroring config-store.test.ts.
import { describe, expect, it } from "vitest";
import { isSafePluginName } from "./plugin-store";

describe("isSafePluginName", () => {
  it("accepts a normal repo name", () => {
    expect(isSafePluginName("mini.nvim")).toBe(true);
  });
  it("accepts hyphens and underscores", () => {
    expect(isSafePluginName("vim-surround_2")).toBe(true);
  });
  it("rejects a path separator", () => {
    expect(isSafePluginName("a/b")).toBe(false);
  });
  it("rejects a parent-directory name", () => {
    expect(isSafePluginName("..")).toBe(false);
  });
  it("rejects a single dot", () => {
    expect(isSafePluginName(".")).toBe(false);
  });
  it("rejects empty", () => {
    expect(isSafePluginName("")).toBe(false);
  });
  it("rejects spaces / other chars", () => {
    expect(isSafePluginName("bad name")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/plugin-store.test.ts`
Expected: FAIL — cannot import `isSafePluginName` (module/function not defined).

- [ ] **Step 3: Bump the DB to v3** — edit `src/storage/idb.ts`

Change the version and store list (comment updated to mention `plugins`):

```ts
const DB_NAME = "nvim-in-browser";
const DB_VERSION = 3;
const STORES = ["docs", "config", "plugins"] as const;
```

Leave `openDb`'s `onupgradeneeded` loop as-is — it already creates each store in `STORES` only if absent, so a v2 DB upgrades by adding just `plugins`, preserving `docs` + `config`.

- [ ] **Step 4: Write `src/storage/plugin-store.ts`**

```ts
// IndexedDB-backed persistence for installed Neovim plugins. Each plugin is one
// record in the "plugins" store keyed by its `name` (also its FS dir name under
// pack/plugins/start/). Only the pure isSafePluginName validator is unit-tested
// (node has no IndexedDB); the IDB round-trip is proven by browser-smoke PHASE F.
import { openDb, serializeError } from "./idb";

const STORE = "plugins";

export interface PluginRecord {
  name: string;
  source: "github" | "upload";
  repo?: string;
  ref?: string;
  enabled: boolean;
  files: { path: string; data: Uint8Array }[];
  addedAt: number;
}

export interface PluginStore {
  list(): Promise<PluginRecord[]>;
  add(rec: PluginRecord): Promise<void>;
  remove(name: string): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  get(name: string): Promise<PluginRecord | null>;
}

// A plugin name is a single safe path segment: it becomes an FS directory under
// pack/plugins/start/, so no separators, no "." / ".." traversal, non-empty.
export function isSafePluginName(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return name !== "." && name !== "..";
}

export function openPluginStore(): PluginStore {
  const tx = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> => {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(new Error(serializeError(req.error)));
      });
    } finally {
      db.close();
    }
  };

  return {
    async list() {
      const db = await openDb();
      try {
        return await new Promise<PluginRecord[]>((resolve, reject) => {
          const store = db.transaction(STORE, "readonly").objectStore(STORE);
          const req = store.getAll();
          req.onsuccess = () => resolve((req.result as PluginRecord[]) ?? []);
          req.onerror = () => reject(new Error(serializeError(req.error)));
        });
      } finally {
        db.close();
      }
    },

    async add(rec) {
      if (!isSafePluginName(rec.name)) {
        throw new Error(`unsafe plugin name: ${rec.name}`);
      }
      await tx<IDBValidKey>("readwrite", (s) => s.put(rec, rec.name));
    },

    async remove(name) {
      await tx<undefined>("readwrite", (s) => s.delete(name));
    },

    async get(name) {
      const v = await tx<unknown>("readonly", (s) => s.get(name));
      return v && typeof v === "object" ? (v as PluginRecord) : null;
    },

    async setEnabled(name, enabled) {
      const rec = await this.get(name);
      if (!rec) throw new Error(`no such plugin: ${name}`);
      rec.enabled = enabled;
      await tx<IDBValidKey>("readwrite", (s) => s.put(rec, name));
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/storage/plugin-store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Full unit run + typecheck**

Run: `npm test`  → all pass (existing 26 + 7 new).
Run: `npm run typecheck`  → clean.

- [ ] **Step 7: Commit**

```
git add src/storage/idb.ts src/storage/plugin-store.ts src/storage/plugin-store.test.ts
git commit -m "feat: plugins IndexedDB store (DB v3) with name validation"
```

### Task 2: Pack-layout mapper (pure)

**Files:**
- Create: `src/plugins/pack-layout.ts`, `src/plugins/pack-layout.test.ts`

**Interfaces:**
- Consumes: `PluginRecord` from `../storage/plugin-store`.
- Produces: `pluginsToConfigFiles(plugins: PluginRecord[]): { path: string; data: Uint8Array }[]` — for each plugin with `enabled === true`, one entry per file at absolute path `PACK_BASE + name + "/" + file.path`; disabled plugins contribute nothing.
  - `PACK_BASE = "/home/.local/share/nvim/site/pack/plugins/start/"` (exported for the test).

- [ ] **Step 1: Write the failing test** — `src/plugins/pack-layout.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { pluginsToConfigFiles, PACK_BASE } from "./pack-layout";
import type { PluginRecord } from "../storage/plugin-store";

const rec = (name: string, enabled: boolean, files: string[]): PluginRecord => ({
  name,
  source: "upload",
  enabled,
  addedAt: 0,
  files: files.map((path) => ({ path, data: new TextEncoder().encode(path) })),
});

describe("pluginsToConfigFiles", () => {
  it("maps an enabled plugin's files to absolute site-pack paths", () => {
    const out = pluginsToConfigFiles([rec("mini.nvim", true, ["plugin/mini.lua", "lua/mini/init.lua"])]);
    expect(out.map((f) => f.path)).toEqual([
      `${PACK_BASE}mini.nvim/plugin/mini.lua`,
      `${PACK_BASE}mini.nvim/lua/mini/init.lua`,
    ]);
  });
  it("carries the file bytes through unchanged", () => {
    const out = pluginsToConfigFiles([rec("foo", true, ["plugin/foo.lua"])]);
    expect(new TextDecoder().decode(out[0].data)).toBe("plugin/foo.lua");
  });
  it("excludes disabled plugins", () => {
    const out = pluginsToConfigFiles([
      rec("on", true, ["plugin/a.lua"]),
      rec("off", false, ["plugin/b.lua"]),
    ]);
    expect(out.map((f) => f.path)).toEqual([`${PACK_BASE}on/plugin/a.lua`]);
  });
  it("returns empty for no plugins", () => {
    expect(pluginsToConfigFiles([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/pack-layout.test.ts`
Expected: FAIL — cannot import `pluginsToConfigFiles` / `PACK_BASE`.

- [ ] **Step 3: Write `src/plugins/pack-layout.ts`**

```ts
// Pure mapping: enabled plugins -> absolute WASI FS entries under the Neovim
// site pack "start" dir, which nvim auto-sources at startup (that dir is on the
// default packpath). Consumed by engine-frame's resolveBoot, which hands the
// entries to nvim-host's configFiles mechanism (written before instantiate).
import type { PluginRecord } from "../storage/plugin-store";

// HOME=/home, XDG_DATA_HOME=/home/.local/share (see NVIM_ENV in nvim-host.ts);
// $XDG_DATA_HOME/nvim/site is on the default packpath.
export const PACK_BASE = "/home/.local/share/nvim/site/pack/plugins/start/";

export function pluginsToConfigFiles(
  plugins: PluginRecord[],
): { path: string; data: Uint8Array }[] {
  const out: { path: string; data: Uint8Array }[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const f of p.files) {
      out.push({ path: `${PACK_BASE}${p.name}/${f.path}`, data: f.data });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/pack-layout.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add src/plugins/pack-layout.ts src/plugins/pack-layout.test.ts
git commit -m "feat: pack-layout maps enabled plugins to site-pack FS paths"
```

### Task 3: GitHub fetcher (pure, injectable fetch)

**Files:**
- Create: `src/plugins/github-fetch.ts`, `src/plugins/github-fetch.test.ts`

**Interfaces:**
- Produces:
  - `class GithubFetchError extends Error { kind: "repo-not-found" | "rate-limited" | "too-large" | "network" }`
  - `fetchGithubPlugin(repo: string, ref: string, fetchImpl?: typeof fetch): Promise<{ files: { path: string; data: Uint8Array }[] }>` — `repo` is `"owner/name"`. Lists the tree via `api.github.com`, filters to allowed text files, enforces caps, fetches each blob via `raw.githubusercontent.com`. `fetchImpl` defaults to the global `fetch` (injected in tests).
  - `MAX_FILES = 200`, `MAX_TOTAL_BYTES = 5 * 1024 * 1024` (exported for the test).

- [ ] **Step 1: Write the failing test** — `src/plugins/github-fetch.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fetchGithubPlugin, GithubFetchError, MAX_FILES } from "./github-fetch";

// Build a fake fetch that answers the tree API then raw file requests.
function fakeFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [frag, make] of Object.entries(handlers)) {
      if (url.includes(frag)) return make();
    }
    throw new TypeError("network");
  }) as unknown as typeof fetch;
}

const treeJson = (tree: { path: string; type: string; size?: number }[]) =>
  new Response(JSON.stringify({ tree, truncated: false }), { status: 200 });

describe("fetchGithubPlugin", () => {
  it("fetches only allowed text files and returns their bytes", async () => {
    const f = fakeFetch({
      "api.github.com": () =>
        treeJson([
          { path: "plugin/foo.lua", type: "blob", size: 10 },
          { path: "README.md", type: "blob", size: 10 },
          { path: "assets/logo.png", type: "blob", size: 10 },
          { path: "doc/foo.txt", type: "blob", size: 10 },
          { path: "lua", type: "tree" },
        ]),
      "raw.githubusercontent.com/o/r/main/plugin/foo.lua": () =>
        new Response("vim.g.x = 1", { status: 200 }),
      "raw.githubusercontent.com/o/r/main/doc/foo.txt": () =>
        new Response("help", { status: 200 }),
    });
    const { files } = await fetchGithubPlugin("o/r", "main", f);
    expect(files.map((x) => x.path).sort()).toEqual(["doc/foo.txt", "plugin/foo.lua"]);
    const foo = files.find((x) => x.path === "plugin/foo.lua");
    expect(new TextDecoder().decode(foo.data)).toBe("vim.g.x = 1");
  });

  it("throws repo-not-found on a 404 tree", async () => {
    const f = fakeFetch({ "api.github.com": () => new Response("", { status: 404 }) });
    await expect(fetchGithubPlugin("o/r", "main", f)).rejects.toMatchObject({ kind: "repo-not-found" });
  });

  it("throws rate-limited on a 403 with no remaining quota", async () => {
    const f = fakeFetch({
      "api.github.com": () =>
        new Response("", { status: 403, headers: { "X-RateLimit-Remaining": "0" } }),
    });
    await expect(fetchGithubPlugin("o/r", "main", f)).rejects.toMatchObject({ kind: "rate-limited" });
  });

  it("refuses a repo over the file-count cap before fetching blobs", async () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      path: `plugin/f${i}.lua`,
      type: "blob",
      size: 1,
    }));
    const f = fakeFetch({ "api.github.com": () => treeJson(many) });
    await expect(fetchGithubPlugin("o/r", "main", f)).rejects.toMatchObject({ kind: "too-large" });
  });

  it("surfaces a network error as kind network", async () => {
    const f = fakeFetch({});
    const err = await fetchGithubPlugin("o/r", "main", f).catch((e) => e);
    expect(err).toBeInstanceOf(GithubFetchError);
    expect(err.kind).toBe("network");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/github-fetch.test.ts`
Expected: FAIL — cannot import `fetchGithubPlugin`.

- [ ] **Step 3: Write `src/plugins/github-fetch.ts`**

```ts
// Pure GitHub plugin fetcher. Runs in the options page (which has fetch). Uses
// ONLY endpoints that send Access-Control-Allow-Origin: * (api.github.com for
// the file tree, raw.githubusercontent.com for blobs), so no host_permissions
// are needed. fetchImpl is injectable for unit tests. Enforces file-count and
// total-size caps so a giant repo can't be pulled into IndexedDB.
export type GithubFetchErrorKind =
  | "repo-not-found"
  | "rate-limited"
  | "too-large"
  | "network";

export class GithubFetchError extends Error {
  kind: GithubFetchErrorKind;
  constructor(kind: GithubFetchErrorKind, message: string) {
    super(message);
    this.name = "GithubFetchError";
    this.kind = kind;
  }
}

export const MAX_FILES = 200;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

// Only text files that a pure-Lua/Vimscript plugin needs. Everything else
// (binaries, images, tests, CI) is skipped.
function isAllowedPath(path: string): boolean {
  if (/\.(lua|vim)$/.test(path)) return true;
  if (path === "vimrc" || path.endsWith("/vimrc")) return true;
  if (path.startsWith("doc/") && path.endsWith(".txt")) return true;
  return false;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

export async function fetchGithubPlugin(
  repo: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ files: { path: string; data: Uint8Array }[] }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new GithubFetchError("repo-not-found", `expected owner/repo, got "${repo}"`);
  }
  const treeUrl = `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`;

  let treeRes: Response;
  try {
    treeRes = await fetchImpl(treeUrl);
  } catch (e) {
    throw new GithubFetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (treeRes.status === 404) {
    throw new GithubFetchError("repo-not-found", `repo or ref not found: ${repo}@${ref}`);
  }
  if (treeRes.status === 403 && treeRes.headers.get("X-RateLimit-Remaining") === "0") {
    throw new GithubFetchError("rate-limited", "GitHub rate limit hit (60/hr unauthenticated)");
  }
  if (!treeRes.ok) {
    throw new GithubFetchError("network", `tree HTTP ${treeRes.status}`);
  }

  const body = (await treeRes.json()) as { tree?: TreeEntry[] };
  const blobs = (body.tree ?? []).filter((e) => e.type === "blob" && isAllowedPath(e.path));

  if (blobs.length > MAX_FILES) {
    throw new GithubFetchError("too-large", `plugin has ${blobs.length} files (max ${MAX_FILES})`);
  }
  const totalBytes = blobs.reduce((n, e) => n + (e.size ?? 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new GithubFetchError("too-large", `plugin is ${totalBytes} bytes (max ${MAX_TOTAL_BYTES})`);
  }

  const files: { path: string; data: Uint8Array }[] = [];
  for (const b of blobs) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${b.path}`;
    let res: Response;
    try {
      res = await fetchImpl(rawUrl);
    } catch (e) {
      throw new GithubFetchError("network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) {
      throw new GithubFetchError("network", `${b.path}: HTTP ${res.status}`);
    }
    files.push({ path: b.path, data: new Uint8Array(await res.arrayBuffer()) });
  }
  return { files };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/github-fetch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```
git add src/plugins/github-fetch.ts src/plugins/github-fetch.test.ts
git commit -m "feat: pure GitHub plugin fetcher over CORS-safe endpoints"
```

### Task 4: Folder-upload reader

**Files:**
- Create: `src/options/folder-upload.ts`, `src/options/folder-upload.test.ts`

**Interfaces:**
- Consumes: `isSafeRelpath` from `../storage/config-store`.
- Produces:
  - `toUploadRelpath(webkitRelativePath: string): string | null` — strips the leading top-folder segment (`"mycfg/lua/x.lua"` → `"lua/x.lua"`), returns `null` if the result is empty or fails `isSafeRelpath`.
  - `readFolderUpload(files: FileList): Promise<{ path: string; data: Uint8Array }[]>` — maps each File through `toUploadRelpath` (skipping `null`s) and reads bytes via `file.arrayBuffer()`.

- [ ] **Step 1: Write the failing test** — `src/options/folder-upload.test.ts`

```ts
// Only the pure toUploadRelpath transform is unit-tested; readFolderUpload needs
// a browser File/FileList and is exercised via the options page + manual QA.
import { describe, expect, it } from "vitest";
import { toUploadRelpath } from "./folder-upload";

describe("toUploadRelpath", () => {
  it("strips the top-level folder segment", () => {
    expect(toUploadRelpath("mycfg/lua/opts.lua")).toBe("lua/opts.lua");
  });
  it("handles a file directly under the top folder", () => {
    expect(toUploadRelpath("mycfg/init.lua")).toBe("init.lua");
  });
  it("returns null for a top-folder-only path (no file part)", () => {
    expect(toUploadRelpath("mycfg/")).toBe(null);
  });
  it("returns null when the stripped path is unsafe", () => {
    expect(toUploadRelpath("mycfg/../evil")).toBe(null);
  });
  it("returns null for an empty string", () => {
    expect(toUploadRelpath("")).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/options/folder-upload.test.ts`
Expected: FAIL — cannot import `toUploadRelpath`.

- [ ] **Step 3: Write `src/options/folder-upload.ts`**

```ts
// Reads a <input type="file" webkitdirectory> selection into path/bytes pairs,
// stripping the top folder segment (the user picked ".../mycfg", we want the
// tree beneath it) and sanitizing each path. Shared by the config folder-import
// and the manual plugin-folder-upload flows.
import { isSafeRelpath } from "../storage/config-store";

export function toUploadRelpath(webkitRelativePath: string): string | null {
  const slash = webkitRelativePath.indexOf("/");
  if (slash < 0) return null; // no top-folder segment -> not a folder upload entry
  const rel = webkitRelativePath.slice(slash + 1);
  if (rel.length === 0) return null;
  if (!isSafeRelpath(rel)) return null;
  return rel;
}

export async function readFolderUpload(
  files: FileList,
): Promise<{ path: string; data: Uint8Array }[]> {
  const out: { path: string; data: Uint8Array }[] = [];
  for (const file of Array.from(files)) {
    const rel = toUploadRelpath(file.webkitRelativePath);
    if (rel === null) continue;
    out.push({ path: rel, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/options/folder-upload.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```
git add src/options/folder-upload.ts src/options/folder-upload.test.ts
git commit -m "feat: folder-upload reader with path sanitization"
```

### Task 5: Boot integration — union config + enabled plugins under the master switch

**Files:**
- Modify: `src/engine-frame/engine-frame.ts` (`resolveBoot()` at ~line 253–293)

**Interfaces:**
- Consumes: `openPluginStore` from `../storage/plugin-store`, `pluginsToConfigFiles` from `../plugins/pack-layout`.
- Produces: unchanged `resolveBoot` return shape `{ argv?, configFiles?, usedConfig }`.

- [ ] **Step 1: Add imports** at the top of `engine-frame.ts` (next to the existing `openConfigStore` import on line 12):

```ts
import { openPluginStore } from "../storage/plugin-store";
import { pluginsToConfigFiles } from "../plugins/pack-layout";
```

- [ ] **Step 2: Rewrite the `resolveBoot` body** (replace the current `try { ... } catch { ... } return { usedConfig: false }` block, lines ~258–292). New logic — master switch, then union config + enabled-plugin files:

```ts
  try {
    const configStore = openConfigStore();
    const pluginStore = openPluginStore();
    const [meta, files, plugins] = await Promise.all([
      configStore.getMeta(),
      configStore.loadFiles(),
      pluginStore.list(),
    ]);
    // Master switch: when the user has unchecked "load my config", boot is
    // byte-identical clean — no config files AND no plugins, regardless of
    // per-plugin flags.
    if (!meta.enabled) return { usedConfig: false };

    const encoder = new TextEncoder();
    const configFiles: { path: string; data: Uint8Array }[] = [];
    const initLua = files["init.lua"];
    if (typeof initLua === "string" && initLua.trim().length > 0) {
      for (const [relpath, content] of Object.entries(files)) {
        configFiles.push({ path: "/home/.config/nvim/" + relpath, data: encoder.encode(content) });
      }
    }
    // pluginsToConfigFiles already filters to enabled plugins.
    const pluginFiles = pluginsToConfigFiles(plugins);
    const allFiles = [...configFiles, ...pluginFiles];

    // Nothing to load (no init.lua, no enabled plugins) -> byte-identical clean.
    if (allFiles.length === 0) return { usedConfig: false };

    // `--cmd` runs BEFORE plugins/init load, so netrw's load-guard skips it.
    // Without this, nvim's WASI cwd is `/` (a directory), so the startup buffer
    // becomes a netrw directory listing — nomodifiable+readonly — which breaks
    // scratch-restore and overlay text-seed. The clean/default boot (NVIM_ARGV,
    // with --noplugin) already excludes netrw, so this only affects config/plugin
    // boots (which drop --noplugin so pack/plugins/start auto-loads).
    return {
      argv: [
        "nvim",
        "--cmd",
        "let g:loaded_netrw=1 | let g:loaded_netrwPlugin=1",
        "--embed",
        "-i",
        "NONE",
        "-n",
      ],
      configFiles: allFiles,
      usedConfig: true,
    };
  } catch (e) {
    console.warn("[config] load failed, booting without config:", serializeError(e));
  }
  return { usedConfig: false };
```

Update the `resolveBoot` doc-comment above the function to mention plugins: note it now also stages enabled-plugin files under the site pack dir and that the master switch gates both.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`  → clean.
Run: `npm run build`  → succeeds.

- [ ] **Step 4: Engine smoke (proves default boot unaffected)**

Run: `node scripts/smoke-nvim.mjs`
Expected: SMOKE PASS (no config/plugins present → clean boot, byte-identical).

- [ ] **Step 5: Commit**

```
git add src/engine-frame/engine-frame.ts
git commit -m "feat: boot enabled plugins alongside config under the master switch"
```

### Task 6: Browser-smoke PHASE F — plugin enable/disable + multi-file config

**Files:**
- Modify: `scripts/browser-smoke.mjs`

**Interfaces:**
- Consumes: existing `openScratchReady(browser, id, label, bootTimeout)`, `idbWriteConfig(page, initLua, enabled)`, `wait`, the `__nvim` hooks.

- [ ] **Step 1: Add two IndexedDB helpers** near `idbWriteConfig` (after `idbClearConfig`, ~line 130). `idbWritePlugin` writes a plugin record to the v3 `plugins` store; `idbWriteConfigFiles` writes several config files at once:

```js
// Write a plugin record straight into the v3 "plugins" store (simulating the
// options page having installed it). files: [{ path, text }] — text is encoded
// to the Uint8Array the boot path expects.
function idbWritePlugin(page, record) {
  return page.evaluate(
    (rec) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("nvim-in-browser", 3);
        open.onerror = () => reject(new Error("open failed: " + (open.error?.message ?? "?")));
        open.onblocked = () => reject(new Error("open blocked"));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("plugins", "readwrite");
          const store = tx.objectStore("plugins");
          const enc = new TextEncoder();
          store.put(
            {
              name: rec.name,
              source: "upload",
              enabled: rec.enabled,
              addedAt: 0,
              files: rec.files.map((f) => ({ path: f.path, data: enc.encode(f.text) })),
            },
            rec.name,
          );
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("tx error: " + (tx.error?.message ?? "?")));
          };
        };
      }),
    record,
  );
}

// Flip an installed plugin's enabled flag in place.
function idbSetPluginEnabled(page, name, enabled) {
  return page.evaluate(
    ({ name, enabled }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("nvim-in-browser", 3);
        open.onerror = () => reject(new Error("open failed: " + (open.error?.message ?? "?")));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("plugins", "readwrite");
          const store = tx.objectStore("plugins");
          const get = store.get(name);
          get.onsuccess = () => {
            const rec = get.result;
            rec.enabled = enabled;
            store.put(rec, name);
          };
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("tx error: " + (tx.error?.message ?? "?")));
          };
        };
      }),
    { name, enabled },
  );
}

// Write several config files at once (init.lua + lua/ modules), plus meta.
function idbWriteConfigFiles(page, filesObj, enabled) {
  return page.evaluate(
    ({ filesObj, enabled }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("nvim-in-browser", 3);
        open.onerror = () => reject(new Error("open failed: " + (open.error?.message ?? "?")));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("config", "readwrite");
          const store = tx.objectStore("config");
          for (const [relpath, content] of Object.entries(filesObj)) {
            store.put(content, "file:" + relpath);
          }
          store.put({ enabled }, "meta");
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("tx error: " + (tx.error?.message ?? "?")));
          };
        };
      }),
    { filesObj, enabled },
  );
}
```

- [ ] **Step 2: Add PHASE F** after PHASE E completes (before the final summary/`browser.close()`). It runs two sub-checks against fresh scratch pages:

```js
    // ---- PHASE F: plugin enable/disable + multi-file config ----------------
    // F1: a tiny pure-Lua plugin sets a global from plugin/marker.lua. With it
    // enabled, a fresh boot must auto-source it (g:nib_plugin_marker == 1);
    // disabled, a fresh boot must NOT (== 0). Proves pack/plugins/start auto-load
    // AND that the per-plugin enable flag gates the FS write.
    console.log("\n[PHASE F] plugin: installing an enabled marker plugin...");
    // Clear any config left by earlier phases so this boots on plugins alone,
    // and set config meta enabled=true (the master switch) with no init.lua.
    await idbClearConfig(page);
    await idbWriteConfigFiles(page, {}, true);
    await idbWritePlugin(page, {
      name: "markertest",
      enabled: true,
      files: [{ path: "plugin/marker.lua", text: "vim.g.nib_plugin_marker = 1" }],
    });
    const { page: pageF1, frame: frameF1 } = await openScratchReady(browser, id, "PHASE F1", BOOT_TIMEOUT_MS);
    const markerOn = await frameF1.evaluate(() =>
      window.__nvim.request("nvim_eval", ["get(g:, 'nib_plugin_marker', 0)"]),
    );
    console.log(`[PHASE F1] g:nib_plugin_marker -> ${JSON.stringify(markerOn)}`);
    if (markerOn !== 1) {
      await browser.close();
      return { ok: false, reason: `enabled plugin did not load: marker is ${JSON.stringify(markerOn)}, expected 1` };
    }
    console.log("[PHASE F1] ASSERT OK: enabled plugin auto-loaded");

    console.log("[PHASE F] plugin: disabling the marker plugin, rebooting...");
    await idbSetPluginEnabled(pageF1, "markertest", false);
    const { page: pageF2, frame: frameF2 } = await openScratchReady(browser, id, "PHASE F2", BOOT_TIMEOUT_MS);
    const markerOff = await frameF2.evaluate(() =>
      window.__nvim.request("nvim_eval", ["get(g:, 'nib_plugin_marker', 0)"]),
    );
    console.log(`[PHASE F2] g:nib_plugin_marker -> ${JSON.stringify(markerOff)}`);
    if (markerOff !== 0) {
      await browser.close();
      return { ok: false, reason: `disabled plugin still loaded: marker is ${JSON.stringify(markerOff)}, expected 0` };
    }
    console.log("[PHASE F2] ASSERT OK: disabled plugin did not load");

    // F3: multi-file config — init.lua requires a lua/ module that sets tabstop.
    // Proves the lua/ require path resolves in the WASI FS layout.
    console.log("[PHASE F] config: multi-file init.lua + lua/nibcfg.lua (tabstop=5)...");
    await idbWritePlugin(pageF2, { name: "markertest", enabled: false, files: [{ path: "plugin/marker.lua", text: "vim.g.nib_plugin_marker = 1" }] });
    await idbWriteConfigFiles(pageF2, {
      "init.lua": "require('nibcfg').apply()",
      "lua/nibcfg.lua": "return { apply = function() vim.o.tabstop = 5 end }",
    }, true);
    const { page: pageF3, frame: frameF3 } = await openScratchReady(browser, id, "PHASE F3", BOOT_TIMEOUT_MS);
    const tabstopF = await frameF3.evaluate(() =>
      window.__nvim.request("nvim_get_option_value", ["tabstop", {}]),
    );
    console.log(`[PHASE F3] tabstop -> ${JSON.stringify(tabstopF)}`);
    if (tabstopF !== 5) {
      await browser.close();
      return { ok: false, reason: `multi-file config did not resolve lua/ require: tabstop is ${JSON.stringify(tabstopF)}, expected 5` };
    }
    console.log("[PHASE F3] ASSERT OK: lua/ require-module resolved (tabstop=5)");
    console.log("PHASE F: plugin enable/disable + multi-file config all pass");
```

- [ ] **Step 3: Add PHASE F to the final summary block** (the run of `console.log` lines before the closing PASS). Add:

```js
    console.log("plugin enable/disable + multi-file config (PHASE F): PASS");
```

- [ ] **Step 4: Run the full browser smoke**

Run: `node scripts/browser-smoke.mjs`
Expected: all phases A–F PASS. Paste the PHASE F log.

- [ ] **Step 5: Overlay smoke (unaffected, confirm no regression)**

Run: `node scripts/overlay-smoke.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add scripts/browser-smoke.mjs
git commit -m "test: browser-smoke PHASE F — plugin enable/disable + multi-file config"
```

**Phase 1 done:** the full engine/FS story (plugin install → auto-load → enable/disable gate → multi-file config require path) is proven end-to-end with no UI yet.

---

## Phase 2 — Plugin manager UI

Goal: an options-page section to install plugins (GitHub `owner/repo` or folder upload) and manage them (enable/disable, refresh, remove). Self-contained module; the existing config UI in `options.ts` is untouched this phase.

### Task 7: Plugin manager section + module

**Files:**
- Create: `src/options/options-plugins.ts`
- Modify: `src/options/options.html` (add a plugins `<section>` + its styles reuse existing classes), `src/options/options.ts` (one import + call)

**Interfaces:**
- Consumes: `openPluginStore`, `isSafePluginName`, `PluginRecord` from `../storage/plugin-store`; `fetchGithubPlugin`, `GithubFetchError` from `../plugins/github-fetch`; `readFolderUpload` from `./folder-upload`.
- Produces: `initPluginsUI(): void` — queries the plugins-section DOM, wires handlers, renders the installed list.

- [ ] **Step 1: Add the plugins section to `options.html`** — insert after the "Fetch from URL" section's `<hr />` (before the enabled-checkbox section, ~line 244). It reuses existing `.row`, `button`, `input`, `.field-label`, `.note` styles:

```html
      <hr />

      <section id="plugins-section">
        <label class="field-label">Plugins (pure-Lua / Vimscript only)</label>
        <div class="note" style="border-left-color: var(--accent); margin-bottom: 12px">
          Installs into <code>pack/plugins/start</code> and auto-loads on boot.
          Plugins that spawn processes or use the network (LSP, Telescope+ripgrep,
          Treesitter parsers, Mason, plugin managers) will <strong>not</strong> work.
        </div>
        <div class="row">
          <input
            id="plugin-repo"
            type="url"
            placeholder="owner/repo  (e.g. echasnovski/mini.nvim)"
            aria-label="GitHub owner/repo to install"
            style="flex: 2 1 260px"
          />
          <input
            id="plugin-ref"
            type="url"
            placeholder="ref (default: main)"
            aria-label="git ref"
            style="flex: 1 1 120px"
          />
          <button id="plugin-add" class="primary" type="button">Add from GitHub</button>
        </div>
        <div class="row">
          <input id="plugin-folder" type="file" webkitdirectory aria-label="Upload a plugin folder" />
          <span class="hint" style="color: var(--subtext); font-size: 0.8rem"
            >…or upload a plugin folder from disk</span
          >
        </div>
        <ul id="plugin-list" style="list-style: none; padding: 0; margin: 16px 0 0"></ul>
      </section>
```

- [ ] **Step 2: Write `src/options/options-plugins.ts`**

```ts
// Options-page plugin manager: install pure-Lua plugins from GitHub (owner/repo)
// or a folder upload, list installed plugins with per-plugin enable/disable,
// refresh (github only), and remove. All store ops are wrapped so failures land
// in the shared status line, never a blank page. Thin UI over the tested
// plugin-store + github-fetch + folder-upload units.
import { openPluginStore, isSafePluginName, type PluginRecord } from "../storage/plugin-store";
import { fetchGithubPlugin, GithubFetchError } from "../plugins/github-fetch";
import { readFolderUpload } from "./folder-upload";

const store = openPluginStore();

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as unknown as T;
}

// Reuse the page's status line (owned by options.ts) via a tiny event so this
// module doesn't duplicate the status widget.
function status(message: string, kind: "ok" | "err" | "info"): void {
  document.dispatchEvent(new CustomEvent("nib-status", { detail: { message, kind } }));
}

function fetchErrorMessage(err: unknown): string {
  if (err instanceof GithubFetchError) {
    switch (err.kind) {
      case "repo-not-found":
        return "Repo or ref not found — check owner/repo and the ref.";
      case "rate-limited":
        return "GitHub rate limit hit (60/hr, unauthenticated). Try again later.";
      case "too-large":
        return "Plugin exceeds the 200-file / 5 MB limit.";
      case "network":
        return `Network error: ${err.message} (some hosts block cross-origin fetch; GitHub works).`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function render(): Promise<void> {
  const list = el<HTMLUListElement>("plugin-list");
  let plugins: PluginRecord[];
  try {
    plugins = await store.list();
  } catch (err) {
    status(`Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`, "err");
    return;
  }
  list.textContent = "";
  if (plugins.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.style.color = "var(--subtext)";
    empty.textContent = "No plugins installed.";
    list.append(empty);
    return;
  }
  for (const p of plugins.sort((a, b) => a.name.localeCompare(b.name))) {
    list.append(renderRow(p));
  }
}

function renderRow(p: PluginRecord): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "checkbox-row";
  li.style.marginBottom = "8px";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = p.enabled;
  toggle.addEventListener("change", () => void onToggle(p.name, toggle));

  const label = document.createElement("label");
  label.style.flex = "1 1 auto";
  const src = p.source === "github" ? `github: ${p.repo}@${p.ref}` : "uploaded";
  label.innerHTML = `<strong>${p.name}</strong> <span class="hint" style="color:var(--subtext)">${src} · ${p.files.length} files</span>`;

  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.margin = "0";
  if (p.source === "github") {
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", () => void onRefresh(p));
    actions.append(refresh);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => void onRemove(p.name));
  actions.append(remove);

  li.append(toggle, label, actions);
  return li;
}

async function onToggle(name: string, box: HTMLInputElement): Promise<void> {
  const enabled = box.checked;
  try {
    await store.setEnabled(name, enabled);
    status(enabled ? `${name} enabled (reload your editor).` : `${name} disabled (reload your editor).`, "info");
  } catch (err) {
    box.checked = !enabled;
    status(`Failed to update ${name}: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

async function onRemove(name: string): Promise<void> {
  if (!confirm(`Remove plugin "${name}"? This deletes it from this browser.`)) return;
  try {
    await store.remove(name);
    status(`Removed ${name}. (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Failed to remove ${name}: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

async function onRefresh(p: PluginRecord): Promise<void> {
  if (!p.repo || !p.ref) return;
  status(`Refreshing ${p.name}…`, "info");
  try {
    const { files } = await fetchGithubPlugin(p.repo, p.ref);
    await store.add({ ...p, files, addedAt: Date.now() });
    status(`Refreshed ${p.name} (${files.length} files). (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Refresh failed: ${fetchErrorMessage(err)}`, "err");
  }
}

async function onAddGithub(): Promise<void> {
  const repo = el<HTMLInputElement>("plugin-repo").value.trim();
  const ref = el<HTMLInputElement>("plugin-ref").value.trim() || "main";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    status("Enter a plugin as owner/repo (e.g. echasnovski/mini.nvim).", "info");
    return;
  }
  const name = repo.split("/")[1];
  if (!isSafePluginName(name)) {
    status(`Unsafe plugin name derived from repo: ${name}`, "err");
    return;
  }
  const btn = el<HTMLButtonElement>("plugin-add");
  btn.disabled = true;
  status(`Fetching ${repo}@${ref}…`, "info");
  try {
    if (await store.get(name)) {
      status(`A plugin named "${name}" is already installed — remove or refresh it first.`, "err");
      return;
    }
    const { files } = await fetchGithubPlugin(repo, ref);
    if (files.length === 0) {
      status(`No .lua/.vim files found in ${repo}@${ref}.`, "err");
      return;
    }
    await store.add({ name, source: "github", repo, ref, enabled: true, files, addedAt: Date.now() });
    el<HTMLInputElement>("plugin-repo").value = "";
    el<HTMLInputElement>("plugin-ref").value = "";
    status(`Installed ${name} (${files.length} files). (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Install failed: ${fetchErrorMessage(err)}`, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onUploadFolder(input: HTMLInputElement): Promise<void> {
  const files = input.files;
  if (!files || files.length === 0) return;
  // The top folder segment is the plugin name.
  const top = files[0].webkitRelativePath.split("/")[0];
  if (!isSafePluginName(top)) {
    status(`Unsafe plugin folder name: ${top}`, "err");
    input.value = "";
    return;
  }
  try {
    if (await store.get(top)) {
      status(`A plugin named "${top}" is already installed — remove it first.`, "err");
      return;
    }
    const pluginFiles = await readFolderUpload(files);
    if (pluginFiles.length === 0) {
      status(`No usable files found in ${top}.`, "err");
      return;
    }
    await store.add({ name: top, source: "upload", enabled: true, files: pluginFiles, addedAt: Date.now() });
    status(`Uploaded ${top} (${pluginFiles.length} files). (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    input.value = "";
  }
}

export function initPluginsUI(): void {
  el<HTMLButtonElement>("plugin-add").addEventListener("click", () => void onAddGithub());
  el<HTMLInputElement>("plugin-folder").addEventListener("change", (e) =>
    void onUploadFolder(e.target as HTMLInputElement),
  );
  void render();
}
```

- [ ] **Step 3: Wire the status bridge + init in `options.ts`.** Add near the top (after `setStatus` is defined, ~line 45) a listener so the plugins module can drive the shared status line:

```ts
document.addEventListener("nib-status", (e) => {
  const d = (e as CustomEvent<{ message: string; kind: "ok" | "err" | "info" }>).detail;
  setStatus(d.message, d.kind, d.kind !== "err");
});
```

At the bottom of `options.ts`, next to `void loadInitialState();`:

```ts
import { initPluginsUI } from "./options-plugins";
// …
initPluginsUI();
```

(Move the `import` to the top with the other imports; shown here for locality.)

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`  → clean.
Run: `npm run build`  → succeeds (esbuild bundles `options-plugins.ts` via the `options.ts` entry; no build-config change).

- [ ] **Step 5: Manual verification** (options page has no automated UI test; the underlying units are unit-tested + PHASE F covers store→boot). Load `dist/chromium` unpacked, open the options page, and confirm:
  1. Add `echasnovski/mini.nvim` (ref blank → main) → status shows "Installed mini.nvim (N files)"; row appears with an enabled checkbox + Refresh + Remove.
  2. Open a scratch page → `:lua print(1)` works and (if the plugin defines a command) it's available; toggle the plugin off, reload scratch → it's gone.
  3. Upload a small local plugin folder → row appears as "uploaded".
  4. A bad repo (e.g. `nope/nope`) → status shows "Repo or ref not found".
  5. Remove → row disappears.

Record the manual results in the task report.

- [ ] **Step 6: Commit**

```
git add src/options/options-plugins.ts src/options/options.html src/options/options.ts
git commit -m "feat: options-page plugin manager (install, toggle, refresh, remove)"
```

**Phase 2 done:** users can install/manage plugins from the options page. A natural minor release point (v0.9.0) if desired.

---

## Phase 3 — Config file-manager UI

Goal: replace the single `init.lua` textarea with a multi-file editor (list, click-to-edit, add/rename/delete, folder import), and slim `options.ts` to a thin shell wiring the config + plugins modules.

### Task 8: Config-store CRUD additions

**Files:**
- Modify: `src/storage/config-store.ts`

**Interfaces:**
- Produces (added to `ConfigStore`): `deleteFile(relpath: string): Promise<void>`, `renameFile(from: string, to: string): Promise<void>`.

- [ ] **Step 1: Extend the `ConfigStore` interface** (after `saveFile`):

```ts
  deleteFile(relpath: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
```

- [ ] **Step 2: Implement them** in `openConfigStore`'s returned object (after `saveFile`). `renameFile` reads the old value, writes it under the new key, deletes the old key:

```ts
    async deleteFile(relpath) {
      await tx<undefined>("readwrite", (s) => s.delete(FILE_PREFIX + relpath));
    },

    async renameFile(from, to) {
      if (!isSafeRelpath(to)) throw new Error(`unsafe config relpath: ${to}`);
      const content = await tx<unknown>("readonly", (s) => s.get(FILE_PREFIX + from));
      if (typeof content !== "string") throw new Error(`no such config file: ${from}`);
      await tx<IDBValidKey>("readwrite", (s) => s.put(content, FILE_PREFIX + to));
      await tx<undefined>("readwrite", (s) => s.delete(FILE_PREFIX + from));
    },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`  → clean. (IDB round-trip for delete/rename is exercised by Task 9's manual QA + PHASE F's multi-file `loadFiles`; node has no IndexedDB to unit-test here.)

- [ ] **Step 4: Commit**

```
git add src/storage/config-store.ts
git commit -m "feat: config-store deleteFile + renameFile"
```

### Task 9: Multi-file config editor + options.ts shell

**Files:**
- Create: `src/options/options-config.ts`
- Modify: `src/options/options.html` (replace the single-textarea config section with a file-list + editor + import), `src/options/options.ts` (slim to a shell)

**Interfaces:**
- Consumes: `openConfigStore`, `isSafeRelpath` from `../storage/config-store`; `readFolderUpload` from `./folder-upload`.
- Produces: `initConfigUI(): void`.

- [ ] **Step 1: Replace the config + fetch sections in `options.html`.** Swap the current `init.lua` `<section>` (the `#editor` textarea block) and the "Fetch from URL" section for a file-manager layout. Keep the enabled-checkbox section and `#status`. New markup:

```html
      <section id="config-section">
        <label class="field-label">Config files (<code>~/.config/nvim</code>)</label>
        <div class="row">
          <input id="config-new" type="url" placeholder="new file path (e.g. lua/opts.lua)" style="flex: 2 1 220px" />
          <button id="config-add" type="button">New file</button>
          <input id="config-folder" type="file" webkitdirectory aria-label="Import a config folder" />
          <input id="fetch-url" type="url" placeholder="https://…/init.lua" style="flex: 1 1 200px" />
          <button id="fetch" type="button">Fetch to init.lua</button>
          <button id="clear" class="danger" type="button">Clear all</button>
        </div>
        <div class="row" style="align-items: stretch">
          <ul id="config-list" style="list-style: none; padding: 0; margin: 0; flex: 1 1 180px; min-width: 160px"></ul>
          <div style="flex: 3 1 360px; min-width: 0">
            <label class="field-label" id="config-editing-label" for="editor">init.lua</label>
            <textarea id="editor" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="config file contents"></textarea>
            <div class="row">
              <button id="save" class="primary" type="button">Save file</button>
              <button id="config-rename" type="button">Rename</button>
              <button id="config-delete" class="danger" type="button">Delete file</button>
            </div>
          </div>
        </div>
      </section>
```

- [ ] **Step 2: Write `src/options/options-config.ts`.** It owns: the file list, the current-file selection + editor, save/add/rename/delete, folder import, fetch-to-init.lua, clear-all, and the enabled toggle. Full module:

```ts
// Options-page config file-manager: a list of ~/.config/nvim files with a
// click-to-edit textarea, add/rename/delete, folder import, fetch-to-init.lua,
// clear-all, and the master enable toggle. Thin UI over the config-store +
// folder-upload units. Drives the shared status line via the nib-status event.
import { openConfigStore, isSafeRelpath } from "../storage/config-store";
import { readFolderUpload } from "./folder-upload";

const store = openConfigStore();
let current = "init.lua"; // relpath being edited

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as unknown as T;
}
function status(message: string, kind: "ok" | "err" | "info"): void {
  document.dispatchEvent(new CustomEvent("nib-status", { detail: { message, kind } }));
}
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function refreshList(): Promise<void> {
  const list = el<HTMLUListElement>("config-list");
  let files: Record<string, string>;
  try {
    files = await store.loadFiles();
  } catch (err) {
    status(`Failed to load config: ${describe(err)}`, "err");
    return;
  }
  const names = Object.keys(files).sort();
  if (!names.includes("init.lua")) names.unshift("init.lua"); // always offer init.lua
  list.textContent = "";
  for (const name of names) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = name;
    btn.style.width = "100%";
    btn.style.textAlign = "left";
    btn.style.marginBottom = "4px";
    if (name === current) btn.className = "primary";
    btn.addEventListener("click", () => void select(name));
    li.append(btn);
    list.append(li);
  }
}

async function select(name: string): Promise<void> {
  current = name;
  el<HTMLLabelElement>("config-editing-label").textContent = name;
  try {
    const files = await store.loadFiles();
    el<HTMLTextAreaElement>("editor").value = files[name] ?? "";
  } catch (err) {
    status(`Failed to open ${name}: ${describe(err)}`, "err");
  }
  await refreshList();
}

async function onSave(): Promise<void> {
  const btn = el<HTMLButtonElement>("save");
  btn.disabled = true;
  try {
    await store.saveFile(current, el<HTMLTextAreaElement>("editor").value);
    status(`Saved ${current} ✓ (reload your editor tab to apply)`, "ok");
    await refreshList();
  } catch (err) {
    status(`Save failed: ${describe(err)}`, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onAdd(): Promise<void> {
  const path = el<HTMLInputElement>("config-new").value.trim();
  if (!path) return;
  if (!isSafeRelpath(path)) {
    status(`Unsafe path: ${path}`, "err");
    return;
  }
  try {
    await store.saveFile(path, "");
    el<HTMLInputElement>("config-new").value = "";
    await select(path);
    status(`Created ${path}.`, "ok");
  } catch (err) {
    status(`Create failed: ${describe(err)}`, "err");
  }
}

async function onRename(): Promise<void> {
  const to = prompt(`Rename ${current} to:`, current);
  if (!to || to === current) return;
  if (!isSafeRelpath(to)) {
    status(`Unsafe path: ${to}`, "err");
    return;
  }
  try {
    await store.renameFile(current, to);
    await select(to);
    status(`Renamed to ${to}. (reload your editor)`, "ok");
  } catch (err) {
    status(`Rename failed: ${describe(err)}`, "err");
  }
}

async function onDelete(): Promise<void> {
  if (!confirm(`Delete config file "${current}"?`)) return;
  try {
    await store.deleteFile(current);
    status(`Deleted ${current}. (reload your editor)`, "ok");
    await select("init.lua");
  } catch (err) {
    status(`Delete failed: ${describe(err)}`, "err");
  }
}

async function onImportFolder(input: HTMLInputElement): Promise<void> {
  if (!input.files || input.files.length === 0) return;
  try {
    const files = await readFolderUpload(input.files);
    if (files.length === 0) {
      status("No usable files in the selected folder.", "err");
      return;
    }
    const dec = new TextDecoder();
    for (const f of files) await store.saveFile(f.path, dec.decode(f.data));
    status(`Imported ${files.length} config files. (reload your editor)`, "ok");
    await select("init.lua");
  } catch (err) {
    status(`Import failed: ${describe(err)}`, "err");
  } finally {
    input.value = "";
  }
}

async function onFetch(): Promise<void> {
  const url = el<HTMLInputElement>("fetch-url").value.trim();
  if (!url) {
    status("Enter a URL to fetch from.", "info");
    return;
  }
  const btn = el<HTMLButtonElement>("fetch");
  btn.disabled = true;
  status("Fetching…", "info");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    current = "init.lua";
    el<HTMLLabelElement>("config-editing-label").textContent = "init.lua";
    el<HTMLTextAreaElement>("editor").value = await res.text();
    status("Fetched ✓ into init.lua — review, then Save.", "ok");
  } catch (err) {
    status(`Fetch failed: ${describe(err)} — some hosts block cross-origin fetch; raw GitHub / gists usually work.`, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onClear(): Promise<void> {
  if (!confirm("Clear ALL saved config files from this browser? This cannot be undone.")) return;
  try {
    await store.clear();
    el<HTMLTextAreaElement>("editor").value = "";
    status("Config cleared. (reload your editor)", "ok");
    await select("init.lua");
  } catch (err) {
    status(`Clear failed: ${describe(err)}`, "err");
  }
}

async function onToggleEnabled(box: HTMLInputElement): Promise<void> {
  const enabled = box.checked;
  try {
    await store.setMeta({ enabled });
    status(enabled ? "Config + plugins will load on boot." : "Editors will boot clean.", "info");
  } catch (err) {
    box.checked = !enabled;
    status(`Failed to update setting: ${describe(err)}`, "err");
  }
}

export function initConfigUI(): void {
  el<HTMLButtonElement>("save").addEventListener("click", () => void onSave());
  el<HTMLButtonElement>("config-add").addEventListener("click", () => void onAdd());
  el<HTMLButtonElement>("config-rename").addEventListener("click", () => void onRename());
  el<HTMLButtonElement>("config-delete").addEventListener("click", () => void onDelete());
  el<HTMLButtonElement>("fetch").addEventListener("click", () => void onFetch());
  el<HTMLButtonElement>("clear").addEventListener("click", () => void onClear());
  el<HTMLInputElement>("config-folder").addEventListener("change", (e) =>
    void onImportFolder(e.target as HTMLInputElement),
  );
  const box = el<HTMLInputElement>("enabled");
  box.addEventListener("change", () => void onToggleEnabled(box));
  store
    .getMeta()
    .then((m) => (box.checked = m.enabled))
    .catch(() => undefined);
  void select("init.lua");
}
```

- [ ] **Step 3: Slim `options.ts` to a shell.** Replace the whole file with the element-agnostic status widget + the status bridge + the two module inits (the config-specific handlers now live in `options-config.ts`):

```ts
// Options page shell: owns the shared status line and wires the config + plugin
// UI modules. All feature logic lives in options-config.ts / options-plugins.ts.
import { initConfigUI } from "./options-config";
import { initPluginsUI } from "./options-plugins";

const statusEl = document.getElementById("status") as HTMLDivElement | null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(message: string, kind: "ok" | "err" | "info", autoClear: boolean): void {
  if (!statusEl) return;
  if (statusTimer !== undefined) {
    clearTimeout(statusTimer);
    statusTimer = undefined;
  }
  statusEl.textContent = message;
  statusEl.className = kind;
  if (autoClear) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "";
      statusTimer = undefined;
    }, 5000);
  }
}

document.addEventListener("nib-status", (e) => {
  const d = (e as CustomEvent<{ message: string; kind: "ok" | "err" | "info" }>).detail;
  setStatus(d.message, d.kind, d.kind !== "err");
});

initConfigUI();
initPluginsUI();
```

- [ ] **Step 4: Update the intro `<p class="tagline">` and the sandbox `.note`** in `options.html` so they describe plugins + multi-file config (the note currently says "Plugin loading … is coming in a follow-up" — replace with "Pure-Lua plugins install below"). Keep it short.

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck`  → clean.
Run: `npm run build`  → succeeds.

- [ ] **Step 6: Manual verification.** Load `dist/chromium`, open options, confirm: file list shows `init.lua`; create `lua/opts.lua`, edit + Save, it appears in the list; rename it; import a folder of config files; the enable toggle still gates boot; Clear-all empties the list. Boot a scratch page to confirm a multi-file config (init.lua requiring a lua/ module) applies. Record results.

- [ ] **Step 7: Commit**

```
git add src/options/options-config.ts src/options/options.ts src/options/options.html
git commit -m "feat: multi-file config editor; options.ts becomes a shell"
```

### Task 10: Docs + full gate

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md` (milestone tracker), `.claude/.../memory/nvim-in-browser-clean-engine.md` (if present in the working copy; else skip — it's outside the repo)

- [ ] **Step 1: README** — in the "Options / config" section, replace the "Plugin bundling … is a planned follow-up" bullet with the real behavior: install pure-Lua/Vimscript plugins via `owner/repo` (GitHub, no extra permissions) or a folder upload; per-plugin enable/disable; the multi-file config editor; the master "Load my config" switch gates config + plugins. Keep the sandbox-limits list (still accurate: no process/network plugins).

- [ ] **Step 2: Spec tracker** — in `2026-07-14-nvim-in-browser-design.md`, mark the M4 follow-up (plugin fetcher + multi-file config) delivered, pointing at this plan's spec.

- [ ] **Step 3: Full sequential gate** (each its own Bash call; browser smokes never concurrent):
  - `npm test`  (all unit tests incl. the new pure-logic suites)
  - `npm run typecheck`
  - `node scripts/smoke-nvim.mjs`
  - `node scripts/browser-smoke.mjs`  (PHASE A–F all pass)
  - `node scripts/overlay-smoke.mjs`

- [ ] **Step 4: Commit**

```
git add README.md docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md
git commit -m "docs: plugin fetcher + multi-file config manager"
```

**Phase 3 done:** the M4 follow-up is complete. Merge the branch and release (minor bump).

---

## Self-review notes

- **Spec coverage:** acquisition both-paths (Tasks 3, 4, 7) ✔; no new permissions (Task 3 uses only CORS-`*` endpoints) ✔; per-plugin enable/disable (Tasks 1, 5, 7) ✔; full multi-file config editor (Tasks 8, 9) ✔; no GitHub token ✔; ref-pin + refresh (Task 7 `onRefresh`) ✔; caps (Task 3) ✔; DB v3 idempotent + data survival (Task 1, proven by PHASE F reusing config store) ✔; boot integration + master switch (Task 5) ✔; PHASE F plugin + multi-file proofs (Task 6) ✔; docs (Task 10) ✔.
- **Testing-mechanism deviation from the spec (intentional):** the spec mentioned fake-indexeddb for `plugin-store.test.ts`; this plan instead unit-tests only pure logic and proves IDB round-trips via browser-smoke PHASE F, matching the existing `config-store.test.ts` convention and adding no dependency. The spec's testing INTENT (these units are verified) is fully met.
- **Type consistency:** `PluginRecord`, `PluginStore`, `pluginsToConfigFiles`, `PACK_BASE`, `fetchGithubPlugin`, `GithubFetchError`, `isSafePluginName`, `isSafeRelpath`, `toUploadRelpath`, `readFolderUpload`, `initPluginsUI`, `initConfigUI` names are consistent across tasks. `data` is `Uint8Array` for plugins throughout; config content is `string` encoded in `resolveBoot`.
- **Master switch** semantics (Task 5) are consistent with the smoke (PHASE F sets `meta.enabled=true` before expecting plugins to load; the default-boot byte-identical guarantee holds when nothing is enabled).
