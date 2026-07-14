# nvim-in-browser

Real Neovim — compiled to WebAssembly — editing browser text fields and a
standalone scratch page. No local Neovim install required.

Design: [docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md](docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md)

## Usage

1. `npm ci`, `npm run fetch-assets`, `npm run build`
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

## Release

```sh
scripts/release.sh patch   # or minor | major | X.Y.Z; add --dry-run to test
```

Builds, packages `nvim-in-browser-chromium.zip` + `nvim-in-browser-chromium-X.Y.Z.zip`,
opens and merges a release PR, tags `vX.Y.Z`, and publishes a GitHub release
with both zips attached.

## Third-party engine

The Neovim WASM binary and runtime archive are fetched at build time from
[MuNeNICK/nvim-wasm](https://github.com/MuNeNICK/nvim-wasm), which currently
has **no license**. Neovim itself is Apache-2.0. Do not make this repo or its
release assets public until upstream licensing is resolved (tracked: open an
issue upstream).
