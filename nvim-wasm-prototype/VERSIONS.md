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

## Neovim + dependencies (not yet pinned — ladder rung 2+)

### neovim

- version: `UNPINNED`
- sha256: `UNPINNED`

### lua (PUC Lua 5.1, per design decision to avoid LuaJIT's lack of wasm support)

- version: `UNPINNED`
- sha256: `UNPINNED`

### libuv (clean-room shim layer against upstream API; upstream referenced for interface facts only)

- version: `UNPINNED`
- sha256: `UNPINNED`

### libvterm

- version: `UNPINNED`
- sha256: `UNPINNED`

### tree-sitter

- version: `UNPINNED`
- sha256: `UNPINNED`

### utf8proc

- version: `UNPINNED`
- sha256: `UNPINNED`

### unibilium

- version: `UNPINNED`
- sha256: `UNPINNED`

### libtermkey

- version: `UNPINNED`
- sha256: `UNPINNED`

### msgpack-c

- version: `UNPINNED`
- sha256: `UNPINNED`
