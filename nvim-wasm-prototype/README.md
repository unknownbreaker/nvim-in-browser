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
    fetch-sources.sh   # neovim + dep sources -> src-cache/ (pinned, SHA-checked)
    build-deps.sh      # dep archives -> build/deps/lib + host lua -> build/host
    build-nvim.sh      # patch + configure + link nvim -> build/nvim/bin/nvim
    asyncify.sh        # wasm-opt --asyncify -> dist/nvim-asyncify.wasm
    package-runtime.sh # runtime/ tree -> dist/nvim-runtime.tar.gz (plain ustar)
    smoke.sh           # rung-8 gate: parent smoke harness vs dist/ artifacts
    wasi-toolchain.cmake
  shims/               # clean-room libuv/nvim WASI shim layer (see STATUS.md)
  patches/             # provenance-headered patches (lua, libuv, 3x nvim)
  test/
    hello.c            # rung-1 smoke test: wasm32-wasi hello world
    run-wasi.mjs       # Node runner for .wasm binaries via node:wasi
    uv-smoke.{c,sh} uv-linkall.c   # rung-3 libuv gate
    check-module.mjs   # rung-4 gate: module compiles, _start+memory exported
    check-asyncify.mjs # rung-5 gate: asyncify ABI + scratch-helper exports
    parity-check.mjs   # parity gate: progpath, print/io.write safety, treesitter
  .toolchain/ build/ src-cache/ dist/   # all gitignored, produced by scripts
```

## Usage

Full pipeline (each script is idempotent/resumable):

```sh
bash scripts/fetch-toolchain.sh    # wasi-sdk 33 + binaryen 130
bash scripts/fetch-sources.sh     # neovim v0.12.4 + pinned deps
bash scripts/build-deps.sh        # 13 wasm archives + host lua
bash scripts/build-nvim.sh        # build/nvim/bin/nvim (wasm32-wasi)
bash scripts/asyncify.sh          # dist/nvim-asyncify.wasm
bash scripts/package-runtime.sh   # dist/nvim-runtime.tar.gz
bash scripts/smoke.sh             # rung-8+ gate: parent smoke-nvim.mjs -> SMOKE PASS, then parity-check.mjs -> PARITY PASS
```

`scripts/smoke.sh` points the parent repo's real harness
(`../scripts/smoke-nvim.mjs`) at the two `dist/` artifacts via
`NVIM_WASM_PATH`/`NVIM_RUNTIME_PATH`; PASS includes the idle-wakeups
assertion (final sample ≤5/s; this build measures ~0/s idle). Once the
parent smoke passes, `scripts/smoke.sh` also runs `test/parity-check.mjs`
against the same two artifacts, so a single invocation gives both
`SMOKE PASS` and `PARITY PASS`.

## Results (2026-07-15)

**The ladder was climbed to rung 8: the clean-room binary passes the parent
repo's full smoke harness** — boots under the unmodified engine host, answers
`nvim_ui_attach`, round-trips buffer edits over msgpack-RPC, and beats the
idle-CPU gate.

| Metric | Clean-room build | Vendored (nvim-wasm) |
|---|---|---|
| Asyncified binary | 10,825,005 B (incl. 7 statically linked tree-sitter grammars; 8,041,186 B before them — 417 B above the original rung-8 baseline of 8,040,769 B, the cumulative effect of two prior rebuilds, the `uv_exepath` synthetic-path shim (+69 B) and the Lua-stdio patch (+348 B), not measurement error; see `STATUS.md`) | 8,386,869 B |
| Runtime tarball | 5,742,514 B | 5,613,852 B |
| Idle poll wakeups (final 5s sample) | 0.00/s | 1/s (needs host backoff) |

Boot feel: both engines boot and answer `nvim_ui_attach` in well under a
second in manual testing, but `scripts/smoke-nvim.mjs` logs no timestamp
between "loaded wasm" and "nvim booted" (its only `ms` timings are the
post-idle `nvim_input` round-trips below), so there is no instrumented
boot-time comparison to report here.

Notably, idle is *better* than the vendored engine: our libuv shim subscribes
`fd_read` on stdin in `poll_oneoff`, so the host's adaptive-backoff workaround
never engages — idle is genuinely event-driven.

**Patch inventory** (everything else is unmodified upstream source):

- `patches/lua51-wasi.patch` — Lua 5.1 `luaconf.h` tmpnam guard for wasi-libc
- `patches/libuv-wasi.patch` — 3 build-system hunks; the real work is the
  clean-room shim layer in `shims/` (poll_oneoff-backed `uv__io_poll`,
  fd-less `uv_async`, inline threadpool, honest ENOSYS stubs)
- `patches/neovim-embed-stdio.patch` — `#elif defined(__wasi__)` keeps RPC
  on fds 0/1 (preview1 has no dup)
- `patches/neovim-lua-stdio.patch` — companion to the above: `nlua_init()`
  diverts Lua's default io output + `io.stdout` to stderr under `__wasi__`,
  so user Lua `io.write()`/`io.stdout:write()` cannot corrupt the RPC
  stream on fd 1
- `patches/neovim-ts-static.patch` — `tslua_init()` pre-registers the 7
  statically linked tree-sitter grammars (table in
  `shims/nvim-wasi-treesitter.c`) under `__wasi__`, so
  `vim.treesitter.language.add()` succeeds via the `_ts_has_language`
  fast path — WASI has no dlopen for `parser/<lang>.so`

**What an engine swap would take:** the parent host runs this binary
unchanged (same argv/env/preopens/Asyncify ABI, incl. the
`nvim_asyncify_get_*` scratch exports). **All three parity gaps that would
have blocked a swap are now closed**, each proven by a permanent check in
`test/parity-check.mjs` — folded into `scripts/smoke.sh`'s standing gate
(`bash scripts/smoke.sh` now prints `SMOKE PASS` then `PARITY PASS`), not a
one-off manual run:

- **`v:progpath` empty:** `uv_exepath` returns a synthetic absolute path
  (`/nvim/bin/nvim`) instead of `ENOSYS` (`progpath` check).
- **`io.write()`/`io.stdout` corrupting the RPC stream:** `nlua_init()`
  diverts Lua's default io output and `io.stdout` to stderr under
  `__wasi__`, since upstream's own stdio-redirect mechanism is
  unimplementable under preview1 (no fd-duplication primitive) —
  `io_write_safe`/`print_safe` checks.
- **`vim.treesitter` needing dlopen:** all 7 pinned grammars (c, lua, vim,
  vimdoc, query, markdown, markdown_inline) are statically linked and
  pre-registered at `tslua_init()` time; fixing this also un-broke every
  runtime-Lua `require` under zero-rights hosts like the browser shim
  (wasi-libc's rights-based `access()` was routed to a stat-based shim for
  both of libuv's `access()` call sites) — `treesitter` check.

What remains before an engine-swap decision is made is **product
decisions, not correctness gaps**:

- **Binary size:** the asyncified binary is ~29% larger than the vendored
  engine's 8,386,869 B, entirely the cost of the 7 embedded tree-sitter
  grammars (+2.8 MB) — making them build-time opt-in would recover the
  size for callers that don't need in-wasm `vim.treesitter`.
- **Tarball pruning:** the packaged runtime tarball ships the full source
  `runtime/` tree (docs, tutor, etc.), ~2.3% larger than the vendored
  engine's tarball; pruning unused subtrees is a straightforward size win.
- **Asyncify-stack overflow assert:** the 4 MiB `.bss` unwind stack has no
  overflow assertion compiled in (binaryen's `asyncify-asserts` pass-arg
  exists if this is ever suspected as the cause of a corruption bug).
- **Threaded build:** `uv_thread_create` is an honest `ENOSYS`, so the wasm
  build must stay on the `--embed` headless path; a real threaded build is
  a separate, larger undertaking, not part of this parity work.

Full open-items list in `STATUS.md`.
