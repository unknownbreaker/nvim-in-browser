# nvim-wasm-prototype

## Clean-room provenance statement

This subproject is a **strict clean-room** attempt to build Neovim to
WebAssembly. At no point — in any session, by any agent working on this
code — has `MuNeNICK/nvim-wasm` or `MuNeNICK/monaco-neovim-wasm` been read,
fetched, cloned, or otherwise consulted, in any form: source code, patches,
Makefiles, READMEs, demos, npm packages, or the deployed site. No code,
patch, build script, or design decision in this subproject is derived from
either project.

The only sources consulted while building this subproject are drawn from the
following whitelist:

- [neovim/neovim](https://github.com/neovim/neovim) (source and docs)
- [wasi-libc](https://github.com/WebAssembly/wasi-libc)
- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk)
- [Binaryen](https://github.com/WebAssembly/binaryen)
- the WASI preview1 spec
- [libuv](https://github.com/libuv/libuv) upstream
- Emscripten docs
- [lua.org](https://www.lua.org/)
- upstream repositories of Neovim's other dependencies (e.g. libvterm,
  tree-sitter, utf8proc, unibilium, libtermkey, msgpack-c)
- general, non-excluded web references (e.g. WASM/WASI tutorials, blog posts,
  Node.js docs) that are not the excluded projects above

## What this is

An experimental, from-scratch build of Neovim targeting `wasm32-wasi`,
compiled with wasi-sdk and post-processed with Binaryen's `wasm-opt
--asyncify` so the resulting binary can suspend on I/O instead of blocking.
The goal is a binary that passes the parent repo's existing smoke harness
(`scripts/smoke-nvim.mjs`) — booting, answering msgpack-RPC, and performing a
buffer edit — using an unambiguously Apache-2.0-clean toolchain and shim
layer instead of a vendored, unlicensed binary. Progress is tracked rung by
rung against a validation ladder in `STATUS.md`; toolchain and dependency
versions are pinned with SHA-256 hashes in `VERSIONS.md`. This project never
reads or modifies the parent repo's source, aside from a pointer line in its
README and gitignore entries.

## Layout

```
nvim-wasm-prototype/
  README.md            # this file
  STATUS.md            # living findings log: ladder progress, blockers, decisions
  VERSIONS.md          # pinned versions + sha256 for toolchains, neovim, deps
  scripts/
    fetch-toolchain.sh # wasi-sdk + binaryen -> .toolchain/ (pinned, SHA-checked)
    env.sh             # sourceable env exporting PROTO_ROOT, WASI_SDK, WASM_OPT
  test/
    hello.c            # rung-1 smoke test: wasm32-wasi hello world
    run-wasi.mjs        # Node runner for .wasm binaries via node:wasi
  .toolchain/ build/ src-cache/ dist/   # all gitignored, produced by scripts
```

## Usage

```sh
source scripts/env.sh
scripts/fetch-toolchain.sh
"$WASI_SDK/bin/clang" --target=wasm32-wasi -O2 -o build/hello.wasm test/hello.c
node test/run-wasi.mjs build/hello.wasm
```
