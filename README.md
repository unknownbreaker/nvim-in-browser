# nvim-in-browser

Real Neovim — compiled to WebAssembly — editing browser text fields and a
standalone scratch page. No local Neovim install required.

Design: [docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md](docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md)

## Usage

1. `npm ci`, `npm run fetch-assets` (pulls the pinned engine — see "Engine"
   below), then `npm run build`
2. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/chromium/`
3. **Scratch page:** click the toolbar button — full-page real Neovim. Your
   draft persists across reloads and restarts (saved to IndexedDB, debounced),
   and the system clipboard is bridged: `"+y`/`"*y` copies out and `"+p`/`"*p`
   pastes in. Paste-freshness caveat: the `+`/`*` registers are refreshed when
   the page gains focus or becomes visible (browsers only grant clipboard reads
   to the focused document), so a paste reflects the clipboard as of the last
   focus/visibility sync, not always the instant of the paste.
4. **Overlay:** focus any `<textarea>` or text-like `<input>` and press
   `Ctrl+Shift+E`. Edits sync back live (debounced); `:q` or the escape chord
   `Ctrl+Shift+Esc` closes the overlay (the chord always works, even if your
   config wedges the editor).
   Password fields are never touched.
   IME/composition input works: compose CJK or accented text with your system
   IME and the finished text lands in the buffer. On known sites the overlay
   sets a filetype for syntax highlighting (GitHub / GitLab / Stack Overflow /
   Reddit / Hacker News → `markdown`). If activation can't attach to a field
   (no focused text field, or focus is trapped in a cross-origin iframe) it
   shows a dismissible fallback notice offering the scratch page instead.

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
