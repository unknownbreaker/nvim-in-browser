# nvim-in-browser

Real Neovim — compiled to WebAssembly — editing browser text fields and a
standalone scratch page. No local Neovim install required.

Design: [docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md](docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md)

## Usage

1. `npm ci`, `npm run build` (see "Engine" below for building the engine itself)
2. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/chromium/`
3. **Scratch page:** click the toolbar button — full-page real Neovim.
4. **Overlay:** focus any `<textarea>` or text-like `<input>` and press
   `Ctrl+Shift+E`. Edits sync back live (debounced); `:q` or the escape chord
   `Ctrl+Shift+Esc` closes the overlay (the chord always works, even if your
   config wedges the editor).
   Password fields are never touched.

Verification: `npm test` (unit), `node scripts/smoke-nvim.mjs` (engine in
Node), `node scripts/browser-smoke.mjs` and `node scripts/overlay-smoke.mjs`
(real Chrome; needs Chrome for Testing via
`npx @puppeteer/browsers install chrome@stable` if system Chrome is
MDM-managed).

## Develop

```sh
npm ci
npm run build        # -> dist/chromium (load via chrome://extensions -> Load unpacked)
npm run typecheck
```

The default engine is the local clean-room build in `nvim-wasm-prototype/dist/`
(built by the prototype pipeline). Set `NVIM_ENGINE=vendored npm run build` to
bundle the legacy fetched engine from `vendor/nvim-wasm/` instead (run
`npm run fetch-assets` first). Each build stamps `dist/chromium/engine-info.json`
recording which engine (`cleanroom` or `vendored`) landed and its file
byte sizes + SHA-256s.

## Release

```sh
scripts/release.sh patch   # or minor | major | X.Y.Z; add --dry-run to test
```

Builds, packages `nvim-in-browser-chromium.zip` + `nvim-in-browser-chromium-X.Y.Z.zip`,
opens and merges a release PR, tags `vX.Y.Z`, and publishes a GitHub release
with both zips attached.

## Engine

By default the extension ships a first-party, clean-room WASM build of
Neovim from [`nvim-wasm-prototype/`](nvim-wasm-prototype/) (see its README
and `STATUS.md`), built locally: `cd nvim-wasm-prototype && bash
scripts/fetch-toolchain.sh && bash scripts/fetch-sources.sh && bash
scripts/build-deps.sh && bash scripts/build-nvim.sh && bash
scripts/asyncify.sh && bash scripts/package-runtime.sh` (each step is
idempotent/resumable; produces `dist/nvim-asyncify.wasm` +
`dist/nvim-runtime.tar.gz`). `npm run build` here then picks it up
automatically. It carries no third-party license encumbrance.

The old vendored `nvim-wasm` engine is still available as a legacy fallback:
`npm run fetch-assets` (pulls from
[MuNeNICK/nvim-wasm](https://github.com/MuNeNICK/nvim-wasm)) then
`NVIM_ENGINE=vendored npm run build`. That upstream currently has **no
license** (Neovim itself is Apache-2.0), so builds using this fallback must
keep this repo and its release assets private until upstream licensing is
resolved (tracked: open an issue upstream).
