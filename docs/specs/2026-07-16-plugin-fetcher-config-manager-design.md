# Plugin Fetcher + Config File-Manager — Design Spec

**Date:** 2026-07-16
**Status:** Approved (brainstorming) — pending implementation plan
**Milestone:** M4 follow-up (deferred from Milestone 4 core, v0.7.0)
**Predecessor context:** [Milestone 4 core (config loading)](./2026-07-14-nvim-in-browser-design.md) shipped the IndexedDB config store, options page (single `init.lua` textarea + fetch-from-URL + enable toggle), config-argv boot, and the safe-mode watchdog. Milestone 5 (v0.8.0) added the memory watchdog + idle teardown. This spec builds on both.

## Goal

Let a user install **pure-Lua / Vimscript Neovim plugins** (no subprocesses, no host network from Lua) into the browser editor, and manage a **full multi-file config tree** (`init.lua` + `lua/**` require-modules and friends) — all from the options page, without adding any new extension permissions.

## Non-goals

- Plugins that spawn processes or open sockets (LSP servers, Telescope's `ripgrep`, Treesitter parser compilation, Mason, `git` integrations) — impossible in the WASI sandbox and explicitly out of scope.
- Plugin managers that clone from the network at runtime (lazy.nvim / packer) — the fetch happens host-side in the options page, not from Lua.
- Auto-update of installed plugins.
- Storing a GitHub Personal Access Token.
- `.zip` import (folder-picker import only for the MVP; `.zip` is a documented later add).

## Constraints (carried from predecessors)

- **Engine untouched.** All work is host-side TypeScript + tests + docs. The `nvim-wasi` engine is consumed as the pinned API; its `.wasm`/runtime are not modified.
- **No new manifest permissions.** The manifest stays `["clipboardRead", "clipboardWrite"]`. The GitHub fetch works only through CORS-`*` endpoints (`api.github.com`, `raw.githubusercontent.com`), never through endpoints that would force `host_permissions`.
- **Default (no config, no plugins) boot stays byte-identical.** Everything new is gated behind the presence of enabled config/plugins.
- **IndexedDB shared DB** ("nvim-in-browser"): version bump creates ALL object stores idempotently in `onupgradeneeded`; a lower-version open throws. M2 (`docs`) and M4 (`config`) data must survive the bump.
- **One command per Bash call** (hook-enforced) during implementation. Conventional commits.

## Decisions (from the brainstorming session)

1. **Acquisition — both paths, no new permissions.** A GitHub API fetcher AND a manual folder upload, sharing one IndexedDB store and one boot-integration path.
2. **Activation — per-plugin enable/disable toggle.** Each installed plugin carries an `enabled` flag. Enabled plugins are written to the FS at boot; disabled plugins stay in IndexedDB but off the FS (so a bad plugin can be bisected without losing it).
3. **Config UI — full in-page multi-file editor.** List every config file; click to edit in a textarea; add / rename / delete individual files; plus folder import.
4. **No GitHub token** — token-free MVP; unauthenticated rate-limit (60 req/hr) surfaced as a clear error.
5. **Pin to the given ref** (branch/tag/SHA); a per-plugin **Refresh** re-fetches that ref; no auto-update.
6. **Bad-plugin recovery** reuses the M5 safe-mode watchdog (a hang/error at boot reboots clean, no user config or plugins) + the enable toggle to bisect. No per-plugin bisection built into safe-mode for the MVP.
7. **Folder-picker import, not `.zip`** (webkitdirectory needs no archive library).

## Architecture

Small, independently testable units. Data flows: options page (fetch/upload) → IndexedDB → `engine-frame` boot resolution → `nvim-host` writes files into the WASI FS before instantiate → Neovim auto-sources them.

### New units

**`src/storage/plugin-store.ts`** — IndexedDB CRUD for plugins, mirroring `config-store.ts`'s shape.
- DB "nvim-in-browser" bumped **v2 → v3**, adding a `"plugins"` object store. `onupgradeneeded` creates `docs`, `config`, AND `plugins` idempotently (guard each `createObjectStore` with `objectStoreNames.contains`).
- Record shape (keyed by plugin `name`):
  ```ts
  interface PluginRecord {
    name: string;            // FS dir name under pack/plugins/start/, e.g. "mini.nvim"
    source: "github" | "upload";
    repo?: string;           // "owner/repo" when source === "github"
    ref?: string;            // branch/tag/SHA when source === "github"
    enabled: boolean;
    files: { path: string; data: Uint8Array }[];  // relpaths within the plugin dir
    addedAt: number;         // epoch ms (Date.now() in the options page)
  }
  ```
- API: `openPluginStore(): Promise<PluginStore>` where `PluginStore` = `{ list(): Promise<PluginRecord[]>; add(rec): Promise<void>; remove(name): Promise<void>; setEnabled(name, enabled): Promise<void>; get(name): Promise<PluginRecord | null> }`.
- `name` derivation: for `source:"github"` it is the repo name (the part after `/` in `owner/repo`); for `source:"upload"` it is the top-level folder segment of the `webkitdirectory` selection. Either way it is validated as a **single** safe path segment (no `..`, no `/`, non-empty) before use as the FS dir name; a collision with an existing plugin `name` is rejected with a message (the user removes or refreshes the existing one instead).

**`src/plugins/github-fetch.ts`** — pure fetch logic (runs in the options page, which has `fetch`).
- `fetchGithubPlugin(repo: string, ref: string): Promise<{ files: { path: string; data: Uint8Array }[] }>`.
- Steps: (1) `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1` (CORS `*`) → tree entries; (2) filter to `type === "blob"` text paths — allow-list extensions `.lua .vim .vimrc` and `doc/*.txt` (vimdoc), skip everything else; (3) enforce caps (**≤ 200 files, ≤ 5 MB total** by summing tree entry `size`); (4) fetch each kept file via `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` (CORS `*`) as bytes.
- Errors (each a distinct typed failure the UI maps to a message): `repo-not-found` (404), `rate-limited` (403 + `X-RateLimit-Remaining: 0`), `too-large` (cap exceeded — refuse before fetching blobs), `network`.
- Fully unit-testable by injecting a `fetch` implementation (default: global `fetch`).

**`src/plugins/pack-layout.ts`** — pure mapping, no I/O.
- `pluginsToConfigFiles(plugins: PluginRecord[]): { path: string; data: Uint8Array }[]` — for each **enabled** plugin, emit absolute WASI paths `"/home/.local/share/nvim/site/pack/plugins/start/" + name + "/" + file.path`. (`$XDG_DATA_HOME/nvim/site` is `~/.local/share/nvim/site`, already on the default packpath; `makeHome()` in `nvim-host.ts` already creates `.local/share/nvim`.)
- Unit-testable: given records in/out, assert the path set.

**`src/options/folder-upload.ts`** — browser File handling.
- `readFolderUpload(files: FileList): Promise<{ path: string; data: Uint8Array }[]>` — reads a `<input type="file" webkitdirectory>` selection; each file's `webkitRelativePath` (minus the top folder segment) becomes the stored relpath, sanitized via `isSafeRelpath`; bytes via `file.arrayBuffer()`. Rejects unsafe paths. Reused by both plugin manual-upload and config folder-import.

### Modified units

**`src/storage/config-store.ts`** — add `deleteFile(relpath): Promise<void>`, `renameFile(from, to): Promise<void>`, and confirm `loadFiles()` returns the full tree for the file list. Keep `isSafeRelpath` as the single sanitizer (export it for reuse).

**`src/engine-frame/engine-frame.ts`** (`resolveBoot()`): after reading config files, also open the plugin store, map enabled plugins via `pluginsToConfigFiles`, and concatenate into the `configFiles` array handed to `nvim-host`. Boot still uses the config-argv path (which drops `-u NORC --noplugin` and disables netrw) whenever there is any config OR any enabled plugin; otherwise the byte-identical clean default. The M5 safe-mode watchdog already wraps this path unchanged.

**`src/options/`** — split the growing `options.ts` into:
- `options-config.ts` — the config file-manager: file list from `config-store` (init.lua + lua/** …), click-to-edit textarea, add / rename / delete, folder import via `folder-upload`, the existing enable toggle + fetch-from-URL (for a single `init.lua`).
- `options-plugins.ts` — the plugin manager: `owner/repo` + ref input → `github-fetch` → `plugin-store.add`; manual folder upload → `plugin-store.add({source:"upload"})`; installed list with per-plugin enable/disable toggle, Refresh (github only), Remove; status line mapping fetch errors to messages.
- `options.ts` becomes the thin shell wiring both modules into `options.html` (two sections).

### Boot / activation data flow

```
options page ──add/upload/toggle──▶ IndexedDB (config + plugins stores)
                                          │
scratch reload / overlay activate         │ resolveBoot()
                                          ▼
      config files  +  enabled-plugin files (pack-layout)
                                          │ configFiles[]
                                          ▼
                 nvim-host writes absolute WASI paths, then instantiate
                                          ▼
   nvim boots (config-argv), auto-sources site/pack/plugins/start/*/plugin/*.lua
```

## Error handling

- **Fetch:** `github-fetch` throws typed errors; `options-plugins.ts` maps each to a status message (`repo-not-found` → "Repo or ref not found"; `rate-limited` → "GitHub rate limit hit (60/hr, unauthenticated) — try again later"; `too-large` → "Plugin exceeds the 200-file / 5 MB limit"; `network` → the browser error + the existing CORS hint).
- **Upload:** unsafe relpaths rejected with a message; empty selection ignored.
- **Boot:** a plugin that errors or hangs at startup is caught by the existing 12s safe-mode watchdog + post-start `nvim_eval` health check → reboots clean (no config, no plugins), `debug.safeMode = true`. The user disables the culprit via the toggle and reloads.
- **DB:** v3 `onupgradeneeded` creates missing stores idempotently; a store already present is left intact (M2/M4 data preserved).

## Testing

**Unit (vitest, fake-indexeddb where needed):**
- `plugin-store.test.ts` — add/list/get/remove/setEnabled round-trips; name sanitization rejects `../` and absolute; DB v3 bump preserves a pre-seeded `config` record (regression for the shared-DB migration).
- `github-fetch.test.ts` — injected `fetch`: happy path (tree → filtered files → raw bytes), extension filtering (skips binaries/other), cap refusal (>200 files or >5 MB, refused before blob fetches), 404 → `repo-not-found`, 403+`X-RateLimit-Remaining:0` → `rate-limited`. CI never touches real GitHub.
- `pack-layout.test.ts` — only enabled plugins emitted; correct absolute site-pack paths; disabled excluded.
- `folder-upload.test.ts` — `webkitRelativePath` → sanitized relpath; unsafe paths rejected.
- `config-store.test.ts` — extend with delete/rename.

**Browser smoke (new PHASE F in `scripts/browser-smoke.mjs`), driven via IndexedDB directly like PHASE C:**
- Plugin activation: write a tiny pure-Lua plugin to the `plugins` store, `enabled:true` — a `plugin/marker.lua` that sets `vim.g.nib_plugin_marker = 1` (or defines a `:NibMarker` command). Boot scratch → assert the global is set (proves `pack/plugins/start` auto-load). Then `setEnabled(false)`, reboot a fresh scratch page → assert the global is absent (proves the enable toggle gates FS writes).
- Multi-file config: write `init.lua` that does `require("nibcfg").apply()` plus `lua/nibcfg.lua` defining `apply()` (e.g. sets `vim.o.tabstop = 5`). Boot → assert `tabstop == 5` (proves the `lua/` require path resolves in the WASI FS layout).
- All existing phases (A–E) stay green; PHASE F is additive.

## Scope & sequencing

One spec, phased implementation plan so each phase is independently reviewable and shippable:

1. **Phase 1 — shared storage + boot plumbing:** DB v3 + `plugin-store`, `pack-layout`, `folder-upload`, `config-store` CRUD additions, `resolveBoot()` integration, unit tests, browser-smoke PHASE F (plugin enable/disable + multi-file config). No new UI yet (smoke drives IndexedDB directly). This phase alone proves the whole engine/FS story.
2. **Phase 2 — plugin manager UI:** `options-plugins.ts` (`github-fetch` add, folder upload add, list with toggle/refresh/remove) wired into `options.html`.
3. **Phase 3 — config file-manager UI:** `options-config.ts` (multi-file list/edit/add/rename/delete + folder import) wired into `options.html`; retire the single-textarea-only layout.

Each phase merges + (optionally) releases on its own; a natural minor bump (v0.9.0) at Phase 1, patch/minor as the UI phases land.

## Docs to update (per the doc-freshness rule)

- `README.md` — the "Options / config" and "Sandbox limits" sections: plugins now install (pure-Lua only), how (GitHub `owner/repo` or folder upload), enable/disable, and the multi-file config editor. The current "Plugin bundling … is a planned follow-up" note gets replaced with the real behavior.
- The predecessor spec's milestone tracker — mark the M4 follow-up delivered.
- Memory `nvim-in-browser-clean-engine.md` — note the plugin store + pack-layout boot path.
