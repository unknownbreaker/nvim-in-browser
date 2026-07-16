# Milestone 4 (core): Config Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Your `init.lua` loads and persists — edited/imported via an options page, restored into the engine's filesystem before boot — with a safe-mode fallback so a broken config can't brick the editor.

**Scope (user-chosen: config-loading core).** IN: persistent config FS (`~/.config/nvim/init.lua` in IndexedDB, restored before boot), an options page (in-page editor + fetch-from-URL + clear + enable/safe-mode), safe-mode fallback. DEFERRED to a fast follow-up: the plugin fetcher (GitHub tarball → packpath), multi-file/folder upload. Pure-Lua/Vimscript config works; process-spawning plugins (LSP, git, telescope+rg) cannot in the sandbox — the options page states this.

**Architecture:** Host stays generic — `startNvimHost` gains optional `argv` + `configFiles` (write files into the WASI FS before boot, use given argv); worker + client thread them through. The frame reads the config from IndexedDB and decides the boot: config present + enabled → boot loading `init.lua`; else → clean boot (today's `-u NORC --noplugin`). A boot-timeout / onFatal watchdog retries clean (safe mode) on failure. The engine (nvim-wasi) is NOT touched.

**Tech Stack:** existing. New extension page `options.html`. No new deps.

## Global Constraints
- Engine (nvim-wasi artifact/API) NOT touched. Files: `src/storage/*`, `src/engine/{nvim-host.ts,worker.ts,client.ts}` (host layer — allowed, delicate), `src/engine-frame/*`, `src/options/*`, `src/manifest.json`, `scripts/build.mjs`, smokes, docs.
- No regression: M2 scratch persistence, M2 clipboard, M3 IME/notice/filetype, and all existing smokes stay green. The DB version bump (Task 1) MUST NOT break the M2 `docs` store — the browser smoke's persistence-across-reload assertion is the guard.
- Default boot (no config / config disabled) must be byte-for-byte the behavior today: argv `["nvim","--embed","-u","NORC","--noplugin","-i","NONE","-n"]`, no extra files. `startNvimHost` with no opts = identical to now.
- User config runs arbitrary Lua in the sandbox — that is expected (it's the user's own config). The nvim-wasi engine already redirects `io.write`→stderr so config can't corrupt the RPC stream. Safe mode is for hangs (infinite loops → boot timeout) and hard traps (→ onFatal), NOT Lua errors (nvim shows those and still boots).
- Two browser smokes run SEQUENTIALLY (each rebuilds dist).
- Conventional commits. Shell rule: one command per Bash tool call. Branch: `feat/milestone-4`.

---

### Task 1: Shared IndexedDB opener + config store

**Files:**
- Create: `src/storage/idb.ts`, `src/storage/config-store.ts`, `src/storage/config-store.test.ts`
- Modify: `src/scratch/scratch-store.ts` (use the shared opener)

**Interfaces:**
- `src/storage/idb.ts`: `function openDb(): Promise<IDBDatabase>` — opens DB `"nvim-in-browser"` at **version 2**, creating stores `"docs"` (M2 scratch) and `"config"` if absent (idempotent `if (!db.objectStoreNames.contains(...))`). `function serializeError(e: unknown): string` (moved here from scratch-store; scratch-store re-exports or imports it).
- `src/storage/config-store.ts`:
  ```ts
  export interface ConfigMeta { enabled: boolean; }   // extensible
  export interface ConfigStore {
    loadFiles(): Promise<Record<string, string>>;      // relpath under .config/nvim -> content, e.g. { "init.lua": "..." }
    saveFile(relpath: string, content: string): Promise<void>;
    clear(): Promise<void>;                            // remove all config files
    getMeta(): Promise<ConfigMeta>;                    // defaults { enabled: true }
    setMeta(meta: Partial<ConfigMeta>): Promise<void>;
  }
  export function openConfigStore(): ConfigStore;
  ```
  Files are stored keyed by `"file:" + relpath`; meta under key `"meta"`. `loadFiles` returns only file entries. `relpath` validated against `/^[A-Za-z0-9._\-\/]+$/` and rejecting `..` segments (never write outside `.config/nvim`); reject otherwise.

- [ ] **Step 1: Shared opener.** Create `src/storage/idb.ts` with `openDb()` (version 2, both stores) + `serializeError`. Refactor `src/scratch/scratch-store.ts` to import `openDb`/`serializeError` from `../storage/idb` instead of its own; keep its public API (`openScratchStore`, `serializeError` re-export) identical so nothing else changes. Keep its existing test green.
- [ ] **Step 2: Failing tests for config-store pure bits.** Only the pure helpers are unit-tested (no IndexedDB in vitest); the IDB round-trip is proven by Task 5's browser smoke. Test the relpath validator (export it as `isSafeRelpath(p: string): boolean`): `"init.lua"`→true, `"lua/foo.lua"`→true, `"../evil"`→false, `"/abs"`→false, `"a/../../b"`→false, `"bad name!"`→false.
- [ ] **Step 3: Implement** `config-store.ts` per the interface, using `openDb()`. `saveFile` rejects unsafe relpaths via `isSafeRelpath`. Run tests → green. Typecheck.
- [ ] **Step 4: Regression check.** `npm test` (scratch-store test + new config tests green). Commit `feat: shared IndexedDB opener and config store`.

---

### Task 2: Thread argv + configFiles through host → worker → client

**Files:**
- Modify: `src/engine/nvim-host.ts`, `src/engine/worker.ts`, `src/engine/client.ts`

**Interfaces:**
- `startNvimHost(wasmBytes, runtimeEntries, cb, opts?)` where `opts?: { argv?: string[]; configFiles?: { path: string; data: Uint8Array }[] }`. `argv` defaults to the existing `NVIM_ARGV`. Each `configFiles` entry's `path` is ABSOLUTE in the WASI FS (e.g. `"/home/.config/nvim/init.lua"`); the host creates parent dirs in the in-memory tree and writes the file BEFORE `WebAssembly.instantiate`.
- Worker `StartMsg` gains `argv?: string[]` and `configFiles?: { path: string; data: Uint8Array }[]`; passed straight into `startNvimHost` opts.
- `NvimClient.start(cols, rows, opts?)` where `opts?: { argv?: string[]; configFiles?: { path: string; data: Uint8Array }[] }`; included in the `{type:"start"}` postMessage.

**Regression is the whole risk here.** `start()` / worker / host with NO opts must behave exactly as today.

- [ ] **Step 1: nvim-host.ts.** Add the `opts` param. Replace the hardcoded `NVIM_ARGV` use with `opts?.argv ?? NVIM_ARGV`. After `buildTree` + `makeHome` populate `root`, add a helper that, for each `configFiles` entry, splits the absolute path, walks/creates `Directory`s under `root`, and sets a `File(data)` at the leaf. (Mirror the existing `makeHome`/`buildTree` dir-walk.) Guard: skip entries whose path doesn't start with `/`.
- [ ] **Step 2: worker.ts.** Extend `StartMsg` with `argv?`, `configFiles?`; pass `{ argv: msg.argv, configFiles: msg.configFiles }` as the 4th arg to `startNvimHost`.
- [ ] **Step 3: client.ts.** `start(cols, rows, opts?)` — thread `opts?.argv`, `opts?.configFiles` into the start postMessage. (Transfer note: `configFiles` data arrays are small; a structured-clone copy is fine — do NOT transfer their buffers unless you also stop using them locally.)
- [ ] **Step 4: Verify no regression.** `npm run typecheck`; `npm run fetch-assets`; `npm run build`; `node scripts/smoke-nvim.mjs` (boots with default opts → SMOKE PASS, proving the default path is unchanged). Commit `feat: host/worker/client accept argv + config files for boot`.

---

### Task 3: Config boot + safe-mode fallback in the frame

**Files:**
- Modify: `src/engine-frame/engine-frame.ts`

Both surfaces (embed overlay + full scratch) should boot with the user config. Centralize the decision + the safe-mode wrapper so both `init()` and `startScratch()` use it.

**Interfaces (module-internal):**
- `async function resolveBoot(): Promise<{ argv?: string[]; configFiles?: {path,data}[]; usedConfig: boolean }>` — reads the config store: if meta.enabled AND `loadFiles()` returns a non-empty `init.lua` (and/or other files), returns config argv `["nvim","--embed","-i","NONE","-n"]` (drops `-u NORC --noplugin` so nvim reads `$XDG_CONFIG_HOME/nvim/init.lua`) + the files mapped to absolute `/home/.config/nvim/<relpath>` (data = TextEncoder.encode(content)), `usedConfig:true`. Else returns `{}` (clean boot), `usedConfig:false`.
- `async function startWithSafeMode(startFn: (opts) => Promise<void>): Promise<{safeMode:boolean}>` — resolves the boot opts, races the config `start` against a boot timeout (e.g. 12s) AND catches rejection/onFatal-before-ready. On config-boot failure: `client.dispose()` (terminate the worker), create a FRESH client, retry with clean opts, and report `safeMode:true`. On clean-boot path or success, `safeMode:false`.

- [ ] **Step 1: resolveBoot().** Implement per interface. Config argv drops `-u NORC` + `--noplugin`; keeps `-i NONE -n`. Map each config file to `{ path: "/home/.config/nvim/" + relpath, data: new TextEncoder().encode(content) }`.
- [ ] **Step 2: Safe-mode wrapper.** Because a hung config never resolves `client.start()`, wrap it in a timeout race (12s). On timeout or a pre-ready fatal (client.start rejects): dispose the client, construct a new `NvimClient` (same URLs), and `start()` it with clean opts (no argv/files). Show a notice via `postDeactivate`? No — for the scratch page, log + set a visible banner is out of scope; instead post a console warning AND set `debug.safeMode = true` on the `__nvim` hook (so the smoke can assert), and — if a lightweight in-frame banner is cheap — show a one-line "config failed to load; started in safe mode" div. Keep it minimal.
  - NOTE: constructing a new NvimClient means re-wiring onRedraw/onEvent/onExit/onFatal/onStat to the same handlers and re-running installBufferHooks after the clean start. Factor the client-wiring into a small `wireClient(c)` helper so both the initial and the retry client share setup. This refactor must preserve all existing handlers (redraw, stat, onEvent for wasm_text_changed/wasm_text_final/clipboard_copy, onExit/onFatal deactivate).
- [ ] **Step 3: Use it in both modes.** `init()` (embed) and `startScratch()` (full) call the boot through the safe-mode wrapper, passing the resolved opts to `client.start(cols, rows, opts)`. Everything after `client.start` (installBufferHooks, seed, filetype, clipboard sync, nvim-ready, focus) is unchanged and runs after whichever boot succeeded.
- [ ] **Step 4: Verify.** `npm run typecheck`; `npm run build`; `node scripts/smoke-nvim.mjs` (unaffected — node smoke uses its own host, not engine-frame). Re-read: default/no-config path boots clean and identically; the client re-wire preserves every handler. Commit `feat: boot the user config with a safe-mode fallback`.

---

### Task 4: Options page

**Files:**
- Create: `src/options/options.html`, `src/options/options.ts`
- Modify: `src/manifest.json` (`"options_page": "options.html"`), `scripts/build.mjs` (build options.ts + copy options.html)

**Interfaces:** consumes `openConfigStore` (Task 1).

- [ ] **Step 1: options.html + options.ts.** A styled page with:
  - A `<textarea>` for `init.lua` (loaded from the config store on open; monospace).
  - **Save** → `store.saveFile("init.lua", value)`; shows a saved confirmation. Note: takes effect on the next editor boot (reload the scratch tab / re-activate the overlay).
  - **Fetch from URL** → an input + button; `fetch(url)` the raw text, put it in the textarea (user reviews, then Saves). Catch CORS/network errors into a visible message (note: some hosts block cross-origin fetch; raw GitHub / gists work).
  - **Enable config** toggle → `store.setMeta({enabled})`. When off, editors boot clean.
  - **Clear config** → `store.clear()` (with a confirm).
  - A short, prominent note: this is a browser sandbox — pure-Lua/Vimscript config and settings work; plugins/LSP that spawn processes or use the network do NOT. Plugin loading is coming in a follow-up.
  - Never throw on store errors — surface them in the status line.
- [ ] **Step 2: Manifest + build.** `src/manifest.json`: add `"options_page": "options.html"`. `scripts/build.mjs`: add `{ in: src/options/options.ts, out: "options" }` to the esbuild entry list and `cp` `options.html` into `dist/chromium/`.
- [ ] **Step 3: Verify.** `npm run typecheck`; `npm run build`; confirm `dist/chromium/options.html` + `options.js` exist and manifest has `options_page`. Commit `feat: options page for editing and importing config`.

---

### Task 5: Verify (browser smoke) + docs

**Files:**
- Modify: `scripts/browser-smoke.mjs` (config-applies + safe-mode assertions), `src/engine-frame/engine-frame.ts` (expose `debug.safeMode` on the `__nvim` hook if not already), `README.md`, spec.

- [ ] **Step 1: Debug hook.** Ensure `window.__nvim` exposes `safeMode: boolean` (set true when the safe-mode retry ran). Small.
- [ ] **Step 2: Config-applies assertion (browser-smoke).** In a new phase: open the scratch page, then write a config via the config store from the PAGE context — `chrome.runtime`? no; the scratch page can `import`? Simplest: drive it through IndexedDB directly in the page context via `page.evaluate` using the same DB name/store the config store uses (open "nvim-in-browser" v2, put `file:init.lua` = `vim.o.tabstop = 7` and `meta` = `{enabled:true}`), then RELOAD the scratch page, wait for `__nvim.ready`, and assert `await __nvim.request("nvim_get_option_value", ["tabstop", {}]) === 7`. This proves: config persisted → restored into the FS → loaded by nvim at boot. (Use `vim.o.tabstop = 7` — a trivially observable, side-effect-free setting.)
- [ ] **Step 3: Safe-mode assertion.** Write a hanging config (`while true do end`) to the config store via `page.evaluate`, reload the scratch page, and assert within a reasonable window that `__nvim.ready === true` (the clean retry booted) AND `__nvim.safeMode === true` AND `nvim_get_option_value tabstop` is the default (config did NOT apply). Then clear the config store so it doesn't poison later runs. (This is the headline safety proof — a broken config recovers.)
- [ ] **Step 4: Full gate (sequential).** `npm test`; `npm run typecheck`; `node scripts/smoke-nvim.mjs`; `node scripts/browser-smoke.mjs` (now includes config + safe-mode; also M2 persistence+clipboard still pass — the DB v2 bump must not break `docs`); `node scripts/overlay-smoke.mjs` (unaffected).
- [ ] **Step 5: Docs.** README: an "Options / config" section — open the options page (chrome://extensions → Details → Extension options, or right-click the toolbar icon → Options), edit/import `init.lua`, it loads on next boot; safe mode recovers a broken config; sandbox limits (no process/network plugins yet). Spec: mark Milestone 4 (core) done; note plugin fetcher + folder upload deferred.
- [ ] **Step 6: Commit** `test: config-loads + safe-mode browser smokes; docs: milestone 4 core done`.

---

## Self-review notes
- Engine untouched — all host-side. The host-layer changes (Task 2) are generic (argv/files params), no IndexedDB coupling, default behavior preserved.
- DB v2 bump is the M2-regression risk; the browser smoke's persistence assertion guards it, and the opener creates both stores idempotently.
- Deferred + documented: plugin fetcher (packpath), multi-file/folder upload, self-hosted-nvim config editing (the options editor is a plain textarea for now), persistent crash-counter safe-mode (this pass retries once per page load + an Enable toggle).
- Interface consistency: `openDb`, `openConfigStore`/`ConfigStore`, `isSafeRelpath`, `startNvimHost(...,opts)`, `NvimClient.start(...,opts)`, `resolveBoot`, `__nvim.safeMode` names consistent across tasks.
