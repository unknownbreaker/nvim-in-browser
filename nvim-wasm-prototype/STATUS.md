# STATUS

Living findings log for the nvim-wasm-prototype clean-room build. Append-mostly:
failed experiments get recorded, not erased.

## Validation ladder

- [x] 1. Toolchain fetch + hello-world C compiles to wasm32-wasi and runs in Node.
- [ ] 2. Leaf deps compile (utf8proc, treesitter, lua 5.1, libvterm, …).
- [ ] 3. libuv compiles against our shim layer (links, symbols resolved).
- [ ] 4. Neovim objects compile; binary links.
- [ ] 5. `_start` reaches first `poll_oneoff` under the parent engine host.
- [ ] 6. `--embed` handshake: answers `nvim_ui_attach`.
- [ ] 7. Buffer edit round-trip via RPC.
- [ ] 8. Full `smoke-nvim.mjs` PASS including idle-wakeups gate. **(Definition of done)**
- [ ] 9. Stretch: overlay/browser smokes against our binary; compare binary
      size and boot time vs vendored.

## Log

### 2026-07-14 — Task 1: scaffold + toolchain + rung 1

- Scaffolded `nvim-wasm-prototype/` (README, STATUS, VERSIONS, scripts/, test/).
- Picked latest stable releases at implementation time (checked
  `WebAssembly/wasi-sdk` and `WebAssembly/binaryen` release listings via
  `gh release list`, both whitelisted repos):
  - wasi-sdk-33 (asset `wasi-sdk-33.0-arm64-macos.tar.gz`)
  - binaryen version_130 (asset `binaryen-version_130-arm64-macos.tar.gz`)
- Downloaded both, printed SHA-256 digests with
  `scripts/fetch-toolchain.sh --print-hashes`, and pinned them into
  `VERSIONS.md`.
- `cmake` and `ninja` were already present via Homebrew (arm64 macOS host);
  no install needed.
- Rung 1 ✅: `test/hello.c` compiled with
  `.toolchain/wasi-sdk/bin/clang --target=wasm32-wasi -O2 -o build/hello.wasm test/hello.c`
  (clang emits a deprecation warning suggesting `wasm32-wasip1`, expected —
  the brief's exact invocation was kept) and run via
  `node test/run-wasi.mjs build/hello.wasm` (Node v24.13.0, `node:wasi`
  preview1) printed `hello wasi` and exited 0.
- Toolchain versions this session: wasi-sdk 33.0 (`clang version
  22.1.0-wasi-sdk`, target `wasm32-unknown-wasip1`), binaryen version_130
  (`wasm-opt version 130`), Node v24.13.0, host macOS arm64.
- Decision: `scripts/env.sh` has a bash shebang but must also work when
  `source`d from an interactive zsh shell (the operator's default shell).
  Bash's `BASH_SOURCE[0]` is unset in that case, so the script falls back to
  zsh's `${(%):-%N}` self-path expansion, and finally to `$0`. Verified
  sourcing from both a real `bash` script and directly in zsh.
- Neovim source and remaining dependency versions are not yet chosen — see
  `VERSIONS.md` (`UNPINNED`); that happens starting with ladder rung 2.
