# nvim-in-browser — Design Spec

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation

## Overview

A Chrome (MV3) browser extension that provides real Neovim editing — every motion,
action, and Ex command — in browser text fields and a standalone scratch page,
with **zero local dependencies**. No native Neovim install, no native messaging
host. The engine is genuine Neovim compiled to WebAssembly (wasm32-wasi), running
in a Web Worker inside the extension.

## Goals

- Real Neovim fidelity: all motions/actions/registers/macros/Ex commands behave
  exactly as desktop Neovim, because it *is* Neovim — no emulation.
- Totally configurable: the user's `init.lua` and pure-Lua/Vimscript plugins load
  from a persistent virtual filesystem.
- Works on `<textarea>` and text-like `<input>` elements on arbitrary pages, plus
  a standalone full-screen scratch page for drafting.
- Chrome/Chromium first (covers Edge, Arc, Brave). Code structured (via
  `webextension-polyfill`) so a Firefox port is a milestone, not a rewrite.

## Non-goals

- Plugins that require OS resources: spawning processes (LSP servers, git,
  external formatters), networking from within Neovim, or native binaries.
  The compatibility cut-line is precisely "does it spawn a process or touch the
  OS?" — pure-Lua/Vimscript plugins work, process-spawning ones don't.
- Plugin managers that shell out to git (lazy.nvim, packer, vim.pack) — replaced
  by a built-in tarball fetcher (see Config & Plugins).
- contenteditable/rich-text editors (Gmail composer, Notion, Google Docs) — out
  of scope for v1; the scratch page + copy-out is the workaround. May become a
  later milestone.
- Firefox support in v1.
- `password` inputs — deliberately excluded (security: never route passwords
  through registers/undo/shada).

## Architecture

One engine, two surfaces. Five components:

```
┌─────────────────────────────────────────────────────────┐
│ Chrome MV3 Extension                                     │
│                                                          │
│  Surfaces                                                │
│  ┌────────────────────┐  ┌─────────────────────────────┐ │
│  │ Scratch page       │  │ Content-script overlay      │ │
│  │ (extension page,   │  │ (injected into host pages,  │ │
│  │  threaded build)   │  │  Asyncify build)            │ │
│  └─────────┬──────────┘  └─────────────┬───────────────┘ │
│            │      both embed           │                 │
│  ┌─────────▼───────────────────────────▼───────────────┐ │
│  │ Engine host (JS lib)                                │ │
│  │  spawns Worker · WASI shims · msgpack-RPC bridge    │ │
│  └───────┬─────────────────────┬───────────────────────┘ │
│  ┌───────▼────────┐   ┌────────▼──────────┐              │
│  │ Renderer       │   │ Virtual FS        │              │
│  │ canvas grid ·  │   │ IndexedDB-backed  │              │
│  │ input capture  │   │ ~/.config/nvim    │              │
│  └────────────────┘   └───────────────────┘              │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Web Worker: nvim.wasm (real Neovim, wasm32-wasi)    │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 1. nvim core

Real Neovim compiled to wasm32-wasi via an
[nvim-wasm](https://github.com/MuNeNICK/nvim-wasm)-style wrapper: upstream
Neovim source stays unpatched; a wrapper repo owns the shims and builds the
artifact in CI. Two build variants:

- **Threaded build** — uses SharedArrayBuffer + real threads. Faster. Requires
  COOP/COEP headers, which extension pages can set via the MV3 manifest — so
  this build powers the **scratch page**.
- **Asyncify build** — instrumented so the C stack can suspend/resume across
  async JS boundaries; no special headers needed. Larger and slower, but works
  when injected into arbitrary pages — so this build powers the
  **content-script overlay**. (JSPI is the successor to watch; adopt when
  Chrome support is solid.)

Rationale: Neovim's event loop is libuv (POSIX threads/sockets/timers), none of
which exist in WASM — these two variants are the two viable escape hatches.
Upstream context: Neovim has an official WASM-build tracking issue
(neovim/neovim#35567) and an active GSoC 2026 browser project, so this shim
layer is expected to shrink over time.

### 2. Engine host

Surface-agnostic JS/TS library. Spawns the worker, provides WASI shims
(filesystem, clock, stdio, `poll_oneoff`), and exposes **stock Neovim
msgpack-RPC** (`nvim_input`, `nvim_buf_get_lines`, UI events). Everything above
this seam sees an ordinary Neovim RPC endpoint, same as any GUI client. This is
the load-bearing decision: the WASM-ness is quarantined to one component; as
upstream WASM support matures, the `.wasm` artifact and shims swap out without
touching renderer or surfaces.

### 3. Renderer

Attaches with `nvim_ui_attach` + `ext_linegrid`. Redraw notifications update an
in-memory grid model; a `requestAnimationFrame`-coalesced pass paints dirty
cells to a canvas (cells, cursor, highlights, mode). Font metrics measured once
per font for exact cell alignment. Input capture:

- `keydown` in capture phase, `preventDefault()` so the host page never sees
  keystrokes; events translated to Neovim key notation (`<C-w>`, `<M-x>`,
  `<lt>`, …) → `nvim_input()`.
- IME composition events pass through untranslated until composition ends.
- A reserved **escape chord** (default `<C-S-Esc>`, configurable) that the
  translator never forwards — always deactivates the overlay, so a broken
  config can't trap the keyboard.

### 4. Virtual FS

IndexedDB-backed persistent filesystem mounted at `~/.config/nvim` plus plugin
and scratch directories. Shared by both surfaces; survives restarts and browser
sessions. Carries a schema version for migration across extension updates.

### 5. Surfaces

**Scratch page** — full-screen extension page, threaded build. Buffers live
under persistent `~/scratch/` so drafts survive tab closure. Copy-out via
toolbar button or `"+y` (clipboard bridged through a custom `g:clipboard`
provider that RPCs to `navigator.clipboard`). Also serves as the graceful
fallback for hostile pages.

**Content-script overlay** — activates on explicit user hotkey on a focused
eligible field, Asyncify build, positions a canvas overlay over the field.

## Target fields

- `<textarea>`
- `<input>` of text-like types: `text`, `search`, `url`, `email`, `tel`.
  **Never `password`.**

### Single-line `<input>` semantics

- Buffer is logically single-line.
- `<CR>` (insert or normal mode) syncs, deactivates, and re-dispatches Enter to
  the input so form submission works as the page expects. `:wq` does the same
  minus the re-dispatch.
- The overlay expands to a comfortable multi-row editing strip anchored to the
  field (statusline/cmdline need rows), while the synced value stays one line.

## Data flow

**Input:** keydown → translate → `nvim_input()` → Neovim.
**Output:** `redraw` events → grid model → rAF-coalesced canvas paint.

**Textarea/input sync:**

- On activation: read element value → buffer lines; filetype set from a
  per-site rule table (e.g. github.com → `markdown`), user-overridable.
- Ongoing: autocmd on `TextChanged`/`TextChangedI` marks dirty; host debounces
  (~300ms) and pulls `nvim_buf_get_lines` → writes back to the element.
- Write-back uses the **native value setter + synthetic `input` event** so
  React/Vue controlled components register the change (plain `.value =` is
  ignored by frameworks and silently discarded on submit).
- `:w` forces immediate sync. `:q` / escape chord: sync, deactivate, restore
  focus. The element always holds the last synced text — this invariant is what
  makes watchdog-kill and crash recovery safe.

## Config & plugins

Options page offers three routes into virtual `~/.config/nvim`:

1. In-page editor (the engine editing its own config — self-hosting).
2. Fetch-from-URL (dotfiles repo / gist).
3. Drag-and-drop folder upload.

**Plugin installation:** a built-in *plugin fetcher* downloads GitHub tarballs
over HTTPS and unpacks into `pack/plugins/start/` — Neovim's native `packpath`
— so Neovim's own loading machinery does everything after "files on disk."
The one real porting cost for users: replace the plugin-manager block in
`init.lua` with a declarative plugin list for this environment.

**Future/nice-to-have:** loading `.wasm`-based plugin components (e.g. wasm
treesitter parsers via Neovim's wasmtime support) aligns with upstream
direction; not in v1.

## Resource lifecycle

Browser sandboxes lack OS pressure valves (OOM killer, signals, visibility in
`top`), so lifecycle is explicit, with the worker boundary as enforcement point
(`worker.terminate()` is the always-available backstop; a runaway instance can
peg one core and its own memory but cannot freeze the host page):

- **Lazy & scarce:** nothing spawns until explicit activation; one instance per
  tab; torn down on deactivation.
- **Idle timeout:** no input for 5 min → persist state, terminate worker,
  transparent respawn on next activation. Also reclaims WASM memory peaks
  (linear memory grows but never shrinks).
- **Memory cap:** build-time maximum (512MB) so growth fails loudly.
- **Idle CPU ≈ 0%:** the `poll_oneoff` shim must genuinely block
  (`Atomics.wait` in threaded build, true suspension in Asyncify build), never
  busy-wait. This is a hard acceptance criterion of the initial spike and a
  permanent CI gate.
- **Background tabs:** on `visibilitychange` → hidden, pause rendering and
  suspend timers.
- **Storage:** default `noswapfile` (the element is the durable copy), capped
  undo/shada, log rotation, storage-usage readout + clear button in options.
- **Redraw storms:** rAF coalescing bounds paint work at frame rate.

All numbers tunable.

## Error handling

Principle: *the user's text is never the casualty.* The element / scratch FS
always holds the last synced state; every failure degrades to "restart the
editor," never "lose the draft."

- **Worker crash** (WASM trap, OOM at cap): banner + one-click restart, buffer
  repopulated from last synced text. Two crashes within seconds of boot →
  offer **safe mode** (`nvim --clean`), since that pattern implicates the
  user's config.
- **Watchdog hang** (e.g. runaway Lua loop — no SIGINT exists in WASM): RPC
  ping every 5s; ~10s unresponsive → "Neovim is stuck — restart?" backed by
  `worker.terminate()`.
- **Config errors:** surface through Neovim's own error messages; safe mode is
  the escape hatch.
- **Hostile pages** (key capture fails, cross-origin iframe): detect and offer
  "edit in scratch page" with copy-back rather than half-working.
- **Storage quota:** toast pointing at the storage manager; virtual FS schema
  version enables migration across extension updates.

## Testing

Layered, TDD throughout:

- **Unit (fast, no WASM):** key-event → nvim-notation translator (dead keys,
  `<C-[>` vs `Esc`, `<lt>`); grid model applying recorded `redraw` streams;
  sync debouncer; WASI-FS-on-IndexedDB shim against a filesystem-law suite
  (write/read/rename/unlink round-trips).
- **Fidelity suite (differential):** corpus of editing scenarios — motions,
  text objects, macros, registers, `:g` commands — executed against desktop
  `nvim --headless` as the **oracle** to generate expected buffer outputs, then
  replayed against the WASM build asserting identical results. Any noticed
  behavior difference becomes a new corpus entry. Re-validates the whole
  editing surface on every Neovim/toolchain bump.
- **E2E (Playwright, extension loaded):** fixture pages — plain textarea, text
  inputs (incl. Enter-to-submit forms), React controlled component,
  contenteditable-adjacent traps; activate, edit, deactivate, assert the page
  *framework's* state received the text.
- **Performance gates in CI:** idle CPU ≈ 0%; input-latency p95 budget on the
  Asyncify build; boot-time budget.

## Build & Release

- **Build output:** `npm run build` compiles `src/` into **`dist/chromium/`** — a
  directory loadable directly via `chrome://extensions` → "Load unpacked".
  `dist/` is gitignored. The version in `package.json` is the single source of
  truth; the build stamps it into the output `manifest.json` (the source
  manifest carries a `0.0.0` placeholder).
- **Remote:** `git@github.com:unknownbreaker/nvim-in-browser.git`.
- **Release pipeline:** a local script, `scripts/release.sh <patch|minor|major|X.Y.Z>`:
  1. Preconditions: clean tree, on `main`, up to date with origin, `gh` authed.
  2. Bump version in `package.json` (`npm version --no-git-tag-version`).
  3. Build `dist/chromium/`, then package two zips with identical contents
     (extension files at zip root): `nvim-in-browser-chromium.zip` and
     `nvim-in-browser-chromium-X.Y.Z.zip`.
  4. Commit the bump on branch `release/vX.Y.Z`, push, open a PR via `gh`.
  5. Merge the PR (squash). If branch protection blocks the merge, stop and
     leave the PR open.
  6. Tag `vX.Y.Z` on merged `main`, push the tag, publish a GitHub release for
     it with both zips attached as assets.
  - Supports `--dry-run` (build + package, no git/GitHub side effects).

## Sequencing / milestones

0. **Scaffolding & release pipeline:** minimal loadable MV3 extension stub,
   `npm run build` → `dist/chromium/`, `scripts/release.sh` as above, remote
   wired, pipeline verified end-to-end with a v0.1.0 scaffold release.
1. **Spike (de-risk):** nvim-wasm Asyncify build boots inside a minimal MV3
   extension and edits a buffer rendered on one textarea overlay. Hard gates:
   it works at all; idle CPU ≈ 0%. If the WASM build proves too immature, the
   fallback is CodeMirror 6 + vim emulation behind the same overlay chrome
   (degraded, swappable later) — decision point, not a silent switch.
2. **Scratch page:** threaded build, persistent `~/scratch/`, clipboard bridge.
   Easiest surface; proves the engine end-to-end.
3. **Textarea/input overlay:** activation hotkey, sync semantics, escape chord,
   single-line input handling, hostile-page fallback.
4. **Config & plugins:** virtual FS persistence, options page (editor / URL
   fetch / folder upload), plugin fetcher, per-site filetype rules.
5. **Hardening:** resource lifecycle, watchdog, safe mode, fidelity suite
   expansion, performance gates.

## Alternatives considered

- **CodeMirror 6 vim emulation:** small, robust, fast to ship — but an
  emulator: no `init.lua`, no Lua plugins, hardcoded vim subset. Fails both
  core requirements. Retained only as spike-failure fallback. (Maintenance
  asymmetry: an emulator is an unbounded feature-parity treadmill; a real-binary
  port is a bounded platform-shim problem that shrinks as upstream matures.)
- **Firenvim (native messaging to local nvim):** gold-standard UX, but requires
  local Neovim — violates the core "zero local setup" requirement. Its
  textarea-takeover patterns are prior art worth studying.
- **Full Linux VM in browser (v86/container2wasm):** runs everything, but
  100MB+ download and multi-second boots — rejected as absurd machinery for a
  text field.
- **Hosted Neovim over WebSocket:** full fidelity incl. process-spawning
  plugins, but adds a server dependency, latency, privacy exposure of
  everything typed — violates the "just works anywhere" spirit.

## Open risks

- **Upstream immaturity:** browser WASM Neovim is frontier work (buggy demos,
  no releases). Mitigated by the spike gate and by riding active upstream
  effort (GSoC 2026, tracking issue neovim/neovim#35567).
- **Asyncify input latency:** must be measured in the spike; JSPI adoption is
  the improvement path.
- **Binary size:** tens of MB inside the extension package — acceptable for an
  extension, but watch Chrome Web Store limits and lazy-load the engine.
- **Site diversity:** keyboard-capture and DOM-sync edge cases are a long tail;
  E2E fixtures + hostile-page fallback bound the damage.
