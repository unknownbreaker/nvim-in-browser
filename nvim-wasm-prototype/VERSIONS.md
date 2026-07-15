# VERSIONS

Pinned versions and SHA-256 digests for every toolchain, source tarball, and
dependency this prototype builds against. Print-then-pin discipline:
`scripts/fetch-toolchain.sh --print-hashes` downloads and prints the digest
for a given asset without trusting any prior pin; the printed digest is
pasted here by hand, and normal (non-print-hashes) runs verify downloads
against these pins before extracting.

## Toolchains

### wasi-sdk

- version: `wasi-sdk-33` (release `wasi-sdk-33`, package version `33.0`)
- asset: `wasi-sdk-33.0-arm64-macos.tar.gz`
- url: https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-arm64-macos.tar.gz
- sha256: `85c997a2665ead91673b5bb88b7d0df3fc8900df3bfa244f720d478187bbdc78`

### binaryen

- version: `version_130`
- asset: `binaryen-version_130-arm64-macos.tar.gz`
- url: https://github.com/WebAssembly/binaryen/releases/download/version_130/binaryen-version_130-arm64-macos.tar.gz
- sha256: `79d3ab9f417d9e215f15f598f523d001a7d9ac1e59367e5c869fbdabd1cba72e`

## Neovim + dependencies

Dep list, versions, and sha256 digests below (except neovim itself and
`lua`, see their entries) come directly from Neovim's own
`cmake.deps/deps.txt` inside the pinned Neovim release tarball — this
project does not choose dependency versions independently of upstream
Neovim. See `scripts/fetch-sources.sh` for the fetch/verify/extract logic
and the `SKIP_DEPS` list (with rationale) of manifest entries deliberately
*not* fetched (LuaJIT, wasmtime, gettext, libiconv, win32yank, uncrustify).
See `STATUS.md` for the full discovery log.

### neovim

- version: `v0.12.4` (latest stable per `gh release list --repo neovim/neovim`
  at implementation time — the "Latest"-tagged non-prerelease entry; "stable"
  and "nightly" in that listing are floating tags, not fit for pinning)
- asset: `neovim-0.12.4.tar.gz`
- url: https://github.com/neovim/neovim/archive/refs/tags/v0.12.4.tar.gz
- sha256: `2727da95d2b8b809bc7c71e085452e47dfe1d8aa7cfaa15c68004e23f6f0a6dd`

### lua (PUC Lua 5.1, per design decision to avoid LuaJIT's lack of wasm support)

- version: `5.1.5`
- asset: `lua-5.1.5.tar.gz`
- url: https://www.lua.org/ftp/lua-5.1.5.tar.gz
- sha256: `2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333`
- note: this is also the exact `LUA_URL`/`LUA_SHA256` pair in Neovim's own
  deps.txt — the well-known upstream digest and Neovim's manifest digest
  agree byte-for-byte.

### libuv (clean-room shim layer against upstream API; upstream referenced for interface facts only)

- version: `v1.52.1`
- asset: `libuv-v1.52.1.tar.gz`
- url: https://github.com/libuv/libuv/archive/v1.52.1.tar.gz
- sha256: `478baf2599bfbc882c355288c9cb6f92e0e7dda435fa04031fa5b607cf3f414c`

### luv

- version: `1.52.1-0`
- asset: `luv-1.52.1-0.tar.gz`
- url: https://github.com/luvit/luv/archive/1.52.1-0.tar.gz
- sha256: `e8b8774b31d24be4fcf2b021b90599ecccc8e476c61efcc59c3c10cab813a885`

### lpeg

- version: `1.1.0`
- asset: `lpeg-lpeg-1.1.0.tar.gz`
- url: https://github.com/neovim/deps/raw/d495ee6f79e7962a53ad79670cb92488abe0b9b4/opt/lpeg-1.1.0.tar.gz
- sha256: `4b155d67d2246c1ffa7ad7bc466c1ea899bbc40fef0257cc9c03cecbaed4352a`

### lua-compat53

- version: `v0.13`
- asset: `lua-compat53-v0.13.tar.gz`
- url: https://github.com/lunarmodules/lua-compat-5.3/archive/v0.13.tar.gz
- sha256: `f5dc30e7b1fda856ee4d392be457642c1f0c259264a9b9bfbcb680302ce88fc2`

### tree-sitter (runtime library)

- version: `v0.26.7`
- asset: `treesitter-v0.26.7.tar.gz`
- url: https://github.com/tree-sitter/tree-sitter/archive/v0.26.7.tar.gz
- sha256: `4343107ad1097a35e106092b79e5dd87027142c6fba5e4486b1d1d44d5499f84`

### tree-sitter-c (parser)

- version: `v0.24.1`
- asset: `treesitter-c-v0.24.1.tar.gz`
- url: https://github.com/tree-sitter/tree-sitter-c/archive/v0.24.1.tar.gz
- sha256: `25dd4bb3dec770769a407e0fc803f424ce02c494a56ce95fedc525316dcf9b48`

### tree-sitter-lua (parser)

- version: `v0.5.0`
- asset: `treesitter-lua-v0.5.0.tar.gz`
- url: https://github.com/tree-sitter-grammars/tree-sitter-lua/archive/v0.5.0.tar.gz
- sha256: `cf01b93f4b61b96a6d27942cf28eeda4cbce7d503c3bef773a8930b3d778a2d9`

### tree-sitter-vim (parser)

- version: `v0.8.1`
- asset: `treesitter-vim-v0.8.1.tar.gz`
- url: https://github.com/tree-sitter-grammars/tree-sitter-vim/archive/v0.8.1.tar.gz
- sha256: `93cafb9a0269420362454ace725a118ff1c3e08dcdfdc228aa86334b54d53c2a`

### tree-sitter-vimdoc (parser)

- version: `v4.1.0`
- asset: `treesitter-vimdoc-v4.1.0.tar.gz`
- url: https://github.com/neovim/tree-sitter-vimdoc/archive/v4.1.0.tar.gz
- sha256: `020e8f117f648c8697fca967995c342e92dbd81dab137a115cc7555207fbc84f`

### tree-sitter-query (parser)

- version: `v0.8.0`
- asset: `treesitter-query-v0.8.0.tar.gz`
- url: https://github.com/tree-sitter-grammars/tree-sitter-query/archive/v0.8.0.tar.gz
- sha256: `c2b23b9a54cffcc999ded4a5d3949daf338bebb7945dece229f832332e6e6a7d`

### tree-sitter-markdown (parser)

- version: `v0.5.3`
- asset: `treesitter-markdown-v0.5.3.tar.gz`
- url: https://github.com/tree-sitter-grammars/tree-sitter-markdown/archive/v0.5.3.tar.gz
- sha256: `df845b1ab7c7c163ec57d7fa17170c92b04be199bddab02523636efec5224ab6`

### utf8proc

- version: `v2.11.3`
- asset: `utf8proc-v2.11.3.tar.gz`
- url: https://github.com/juliastrings/utf8proc/archive/v2.11.3.tar.gz
- sha256: `abfed50b6d4da51345713661370290f4f4747263ee73dc90356299dfc7990c78`

### unibilium (REMOVED — no longer built or linked; LGPL-3.0)

- version: `v2.1.2`
- asset: `unibilium-v2.1.2.tar.gz`
- url: https://github.com/neovim/unibilium/archive/v2.1.2.tar.gz
- sha256: `370ecb07fbbc20d91d1b350c55f1c806b06bf86797e164081ccc977fc9b3af7a`
- **status: REMOVED from the default build (2026-07-15).** unibilium is
  **LGPL-3.0** and is used only by `src/nvim/tui/`, which our `--embed`
  headless engine never runs; all its call sites fall back to Neovim's
  in-tree BSD-licensed built-in terminfo tables under `#else` when
  `HAVE_UNIBILIUM` is undefined. `build-nvim.sh` now configures nvim with
  `-DENABLE_UNIBILIUM=OFF` and `build-deps.sh` no longer builds
  `libunibilium.a` (dropped from `ALL_DEPS`; `build_unibilium()` deleted).
  The pin is retained here only because `fetch-sources.sh` still fetches the
  source from Neovim's own manifest; nothing compiles it. Dropping it makes
  the produced binary cleanly permissive-licensed (no LGPL). See `STATUS.md`
  (2026-07-15 Licensing Task entry).

### Manifest entries intentionally not fetched (see `SKIP_DEPS` in `scripts/fetch-sources.sh`)

Not pinned/downloaded — recorded here only so it's clear these were seen
and deliberately excluded, not missed:

- **luajit** — `LUAJIT_URL` in deps.txt (Neovim's default Lua runtime);
  excluded because LuaJIT has no wasm32 target. PUC Lua 5.1 (above) is used
  instead, per this prototype's design decision.
- **wasmtime** — optional (`ENABLE_WASMTIME` defaults `OFF`); wasm support
  for tree-sitter parsers, not needed to build Neovim itself.
- **gettext**, **libiconv** — bundled only when `USE_BUNDLED AND MSVC`
  (Windows/MSVC-only in Neovim's own build config); not applicable here.
- **win32yank** — a prebuilt Windows clipboard *binary* release asset, not
  a source archive; Windows-only.
- **uncrustify** — a C code formatter invoked only from Neovim's own dev
  scripts (`scripts/vim-patch.sh`, `scripts/bump_deps.lua`), not part of
  the CMake build graph.

### libvterm

Not present in this Neovim release's dependency manifest at all — modern
Neovim does not depend on external libvterm (or libtermkey, or msgpack-c;
neither appears in `cmake.deps/deps.txt` either). Recorded here as a
discovery note for whatever implements terminal-buffer support later; see
`STATUS.md` for the full note.
