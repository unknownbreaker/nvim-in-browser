# Neovim in Browser

Real Neovim — compiled to WebAssembly — editing browser text fields and a
standalone scratch page. No local Neovim install required. (Repo/package slug:
`nvim-in-browser`.)

Design: [docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md](docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md)

## Usage

1. `npm ci`, `npm run fetch-assets` (pulls the pinned engine — see "Engine"
   below), then `npm run build`
2. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/chromium/`
3. **Scratch page:** click the toolbar button — full-page real Neovim (inset a
   few pixels so the browser window's rounded corners never clip the UI). Your
   draft persists across reloads and restarts (saved to IndexedDB, debounced),
   and the system clipboard is bridged: `"+y`/`"*y` copies out and `"+p`/`"*p`
   pastes in. A `g:clipboard` provider is registered, so `set
   clipboard=unnamedplus` works too (rather than erroring "No clipboard
   provider"). Paste-freshness caveat: the `+`/`*` registers are refreshed when
   the page gains focus or becomes visible (browsers only grant clipboard reads
   to the focused document), so a paste reflects the clipboard as of the last
   focus/visibility sync, not always the instant of the paste.
4. **Overlay:** focus any `<textarea>`, text-like `<input>`, or a supported
   in-page code editor (Monaco, CodeMirror 5, CodeMirror 6) and press
   `Ctrl+Shift+E`. Edits sync back live (debounced), so **your text is written
   into the underlying web page's field automatically as you type** — that is
   the only "save," and it's continuous. (Code editors are reached through a
   main-world bridge, since their live instances aren't visible to a content
   script; CodeMirror 6 support is best-effort and version-dependent.)
   - **Closing:** use **`:q!`**, or the escape chord `Ctrl+Shift+Esc` (the chord
     always works, even if your config wedges the editor). Plain `:q` is
     *rejected* — the buffer is always "modified", so Neovim refuses to quit
     with `E37: No write since last change`. `:q!` force-quits; you lose
     nothing because your edits are already in the page field (and the final
     text is synced once more on quit). If you have no physical Escape key,
     `:q!` is your close command.
   - **`:w` does NOT save to any file.** The overlay buffer is unnamed, so
     `:w` alone fails (`E32: No file name`) and `:w somename` writes only into
     the engine's **in-memory virtual filesystem, which is discarded when the
     overlay closes** — it never touches your disk and is not how your text is
     persisted. There is no reason to `:w`; the automatic sync to the page
     field is the real save. (The escape chord is not yet reassignable.)
   - Password fields are never touched.
   IME/composition input works: compose CJK or accented text with your system
   IME and the finished text lands in the buffer. On known sites the overlay
   sets a filetype for syntax highlighting (GitHub / GitLab / Stack Overflow /
   Reddit / Hacker News → `markdown`). If activation can't attach to a field
   (no focused text field, or focus is trapped in a cross-origin iframe) it
   shows a dismissible fallback notice offering the scratch page instead.

## Options / config

The extension boots real Neovim with **your** `init.lua`.

- **Open the options page:** `chrome://extensions` → find nvim-in-browser →
  **Details** → **Extension options** (or right-click the toolbar icon →
  **Options**).
- **Edit your config:** the multi-file editor manages your whole
  `~/.config/nvim/` tree — add files (e.g. `lua/opts.lua`), rename/delete them,
  and edit each in place, not just a single `init.lua`. You can **Fetch to
  init.lua** from a raw URL, or **import a config folder** from disk. Save —
  everything is stored in IndexedDB (mapped to `~/.config/nvim/`).
- **Install plugins:** add a pure-Lua / Vimscript plugin by GitHub
  **`owner/repo`** (optionally pinning a ref; default `main`) — no extra
  permissions, it fetches over the public GitHub API — or **upload a plugin
  folder** from disk. Installed plugins stage into `pack/plugins/start` and
  auto-load on boot; each has a per-plugin **enable/disable** toggle so you can
  keep one installed but off.
- **Optional GitHub token:** unauthenticated GitHub API calls are limited to
  60/hr **per IP** (easily exhausted behind a shared/corporate/VPN address),
  which shows up as an install failure. Save a **personal access token** in the
  Advanced section to raise that to 5,000/hr and to install from your **private**
  repos. A fine-grained, read-only token is enough (`Contents: read` only for
  the private repos you install). The token is kept in a **separate local
  database** — never written into your config or the editor, never included in a
  config export, and sent only to GitHub over HTTPS.
- **It loads on the next editor boot:** reload the scratch tab, or re-activate
  the overlay (`Ctrl+Shift+E`). Neovim starts with your config and enabled
  plugins applied.
- **The "Load my config on boot" checkbox is the master switch.** Unchecked, it
  boots a stock Neovim that ignores **both** your saved config and your plugins
  — a quick way to bypass everything without deleting it.
- **A broken config auto-recovers into safe mode.** If your config errors or
  hangs at boot, a 12s watchdog disposes the wedged engine and reboots a clean
  one, so the editor always comes up (a banner notes the fallback). Fix the
  config and reload to try again.

**Sandbox limits.** This is Neovim compiled to WebAssembly in a browser, with
no subprocesses and no host network from Lua. So:

- **Works:** pure-Lua / Vimscript config, `set`/option tweaks, keymaps,
  autocmds, and pure-Lua plugins (no external processes).
- **Does NOT work:** plugins that spawn processes or open sockets (LSP servers,
  Telescope's `ripgrep`, `git` integrations, Treesitter parser compilation,
  Mason, etc.), and plugin managers (lazy.nvim / packer) that clone from the
  network.
- **Installing plugins** works for pure-Lua / Vimscript plugins: add them by
  GitHub `owner/repo` (no extra permissions) or a folder upload, and toggle each
  on/off, via the options page (see "Options / config" above). The same sandbox
  limits apply — a plugin that spawns a process or opens a socket still won't
  run.

**Hardening.** The editor reclaims resources and guards against runaway configs:

- **Idle sleep / resume.** The scratch page sleeps after a few minutes of
  inactivity — it saves your draft, disposes the Neovim worker to release its
  memory and thread, and shows a "💤 sleeping" overlay. Press any key (or click)
  to resume: a fresh engine boots and your draft is restored where you left off.
  (The transient overlay editor is exempt — it is already torn down when it
  closes.)
- **Memory guard.** A runaway config or plugin that balloons the wasm heap past
  ~700 MB is stopped rather than crashing the tab: the worker is disposed with a
  notice and is deliberately *not* auto-respawned (no crash loop). Fix the config
  and reload.
- **Performance budgets.** The browser smoke enforces generous headless-CI
  ceilings to catch gross regressions — cold boot (including the ~11 MB wasm
  compile) under 6 s, and RPC round-trip latency p95 under 75 ms. Real numbers
  are far under these (warm boot ~1–2 s, latency ~2–3 ms).

**Engine fidelity** — the differential test suite that checks the WASM engine
against desktop `nvim --headless` as an oracle (matching it case-for-case on core
editing) — lives in the separate
[`nvim-wasi`](https://github.com/unknownbreaker/nvim-wasi) engine repo, not here.

Verification: `npm test` (unit), `node scripts/smoke-nvim.mjs` (engine in
Node), `node scripts/browser-smoke.mjs` and `node scripts/overlay-smoke.mjs`
(real Chrome; needs Chrome for Testing via
`npx @puppeteer/browsers install chrome@stable` if system Chrome is
MDM-managed).

## Develop

```sh
npm ci
npm run fetch-assets # -> vendor/nvim-wasi (pinned engine; needs gh auth)
npm run build        # -> dist/chromium (load via chrome://extensions -> Load unpacked)
npm run typecheck
```

Each build copies the fetched engine into `dist/chromium/` and stamps
`dist/chromium/engine-info.json` recording the source (`nvim-wasi`), the pinned
release tag, and each file's byte size + SHA-256.

**Git hooks.** `npm ci`/`npm install` runs a `prepare` step that points
`core.hooksPath` at `scripts/git-hooks/`, enabling a **`post-merge`** hook that
refreshes your build after a `git pull`: it reinstalls deps if `package.json`
changed, re-fetches the pinned `nvim-wasi` engine if `engine.lock.json` changed,
and then **always runs `npm run build`** so the loaded extension is current
(reload it at `chrome://extensions`). Enable it manually with `git config
core.hooksPath scripts/git-hooks`. Caveats: it fires only on a merge-style pull
(a rebase pull skips `post-merge`), and because git runs hooks without your
login shell, an **nvm-managed `npm` must be on `PATH`** — a normal terminal is
fine, but a GUI/IDE git client may not source your profile, in which case pull
from a terminal (or run `npm run build` yourself).

## Release

```sh
scripts/release.sh patch   # or minor | major | X.Y.Z; add --dry-run to test
```

Builds, packages `nvim-in-browser-chromium.zip` + `nvim-in-browser-chromium-X.Y.Z.zip`,
opens and merges a release PR, tags `vX.Y.Z`, and publishes a GitHub release
with both zips attached.

## Engine

The Neovim-to-WebAssembly engine is **not** built in this repo. It lives in a
separate project, [`nvim-wasi`](https://github.com/unknownbreaker/nvim-wasi),
which builds it clean-room and publishes SHA-pinned release artifacts
(`nvim-asyncify.wasm` + `nvim-runtime.tar.gz`). This extension consumes a
pinned release as its sole engine source.

```sh
npm run fetch-assets   # scripts/fetch-engine.mjs
npm run build
```

`npm run fetch-assets` reads [`engine.lock.json`](engine.lock.json) — which
pins the `nvim-wasi` repo, release tag, and per-file SHA-256 — and downloads
each artifact into `vendor/nvim-wasi/` via `gh release download`, verifying it
against the pinned hash (a mismatch is fatal). Both repos are private, so this
needs an authenticated `gh` (`gh auth login`). The fetch is idempotent: an
artifact already present with a matching hash is skipped.

To move to a new engine build, cut a new `nvim-wasi` release, then update the
`tag` and `sha256` values in `engine.lock.json` and re-run `npm run
fetch-assets`.
