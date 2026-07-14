# nvim-in-browser

Real Neovim — compiled to WebAssembly — editing browser text fields and a
standalone scratch page. No local Neovim install required.

Design: [docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md](docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md)

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
