# STATUS

Living findings log for the nvim-wasm-prototype clean-room build. Append-mostly:
failed experiments get recorded, not erased.

## Validation ladder

- [x] 1. Toolchain fetch + hello-world C compiles to wasm32-wasi and runs in Node.
- [x] 2. Leaf deps compile (utf8proc, treesitter, lua 5.1, …). Host lua/luac built.
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

### 2026-07-14 — Task 3: pinned neovim + dependency sources

- Picked the latest **stable** Neovim release at implementation time via
  `gh release list --repo neovim/neovim`: `v0.12.4`, tagged "Latest". The
  listing also shows `stable` and `nightly` entries, but those are floating
  tags (repointed on every release/nightly build) and unsuitable for
  pinning, so the versioned tag was used instead.
- Wrote `scripts/fetch-sources.sh`: downloads+verifies+extracts the Neovim
  source tarball (print-then-pin discipline, same as
  `fetch-toolchain.sh` — sha256 printed via `--print-hashes`, hand-pasted
  into `VERSIONS.md`), then parses the **extracted tree's own**
  `cmake.deps/deps.txt` for `<NAME>_URL`/`<NAME>_SHA256` pairs and
  downloads+verifies+extracts every entry it finds (except a documented
  `SKIP_DEPS` list), plus PUC Lua 5.1.5 from lua.org.
- **Discovery — full manifest as shipped in `cmake.deps/deps.txt` for
  v0.12.4** (20 entries): `LIBUV`, `LUAJIT`, `LUA`, `UNIBILIUM`, `LUV`,
  `LPEG`, `LUA_COMPAT53`, `WIN32YANK_X86_64`, `GETTEXT`, `LIBICONV`,
  `UTF8PROC`, `TREESITTER_C`, `TREESITTER_LUA`, `TREESITTER_VIM`,
  `TREESITTER_VIMDOC`, `TREESITTER_QUERY`, `TREESITTER_MARKDOWN`,
  `TREESITTER` (core runtime), `WASMTIME`, `UNCRUSTIFY`. This is the
  authoritative discovery data for whatever task builds these next — the
  full list came from Neovim's own manifest, not chosen independently.
- **Manifest surprises:**
  - `libvterm`, `libtermkey`, and `msgpack-c` — all three had `UNPINNED`
    placeholder entries in `VERSIONS.md` from the Task 1 scaffold, on the
    assumption Neovim still depends on them externally. **None appear in
    `cmake.deps/deps.txt` at all.** Modern Neovim apparently no longer
    depends on any of the three as external libraries (msgpack encoding and
    terminal/unibilium-based terminfo handling must be internal or covered
    by `unibilium` alone now). Left as a discovery note in `VERSIONS.md`
    under a `### libvterm` heading for whichever task implements
    terminal-buffer support to investigate further — this script fetches
    nothing for them since there is nothing upstream to fetch.
  - `LUA_URL` in deps.txt already points at the *exact* URL the brief asked
    for (`https://www.lua.org/ftp/lua-5.1.5.tar.gz`), and its
    `LUA_SHA256` matches the well-known digest
    (`2640fc56...` per the brief) byte-for-byte. So "Neovim's manifest
    already has PUC Lua" and "fetch lua-5.1.5.tar.gz separately" turned out
    to be the same requirement, not two — the script fetches it once via a
    dedicated `fetch_lua()` step (which also cross-checks the well-known
    hash) and excludes `LUA` from the generic manifest loop to avoid
    double-fetching the identical file under two asset names.
  - Neovim's own `cmake.deps/CMakeLists.txt` comments PUC Lua as "only used
    for tests, unless explicitly requested" — Neovim's default build uses
    LuaJIT (`USE_BUNDLED_LUAJIT` ON by default) and building against PUC
    Lua instead requires explicitly setting `USE_BUNDLED_LUA=ON`. Noted for
    whichever task configures the actual Neovim CMake build (it must pass
    that flag, or the build will pull in LuaJIT despite the sources not
    being fetched here).
  - Six manifest entries were deliberately **not** fetched (documented as
    `SKIP_DEPS` in the script and mirrored in `VERSIONS.md`): `LUAJIT`
    (explicitly excluded per the brief — no wasm32 target), `WASMTIME`
    (opt-in tree-sitter wasm-parser support, `ENABLE_WASMTIME` defaults
    OFF in Neovim's own CMake config), `GETTEXT`/`LIBICONV` (bundled only
    under `USE_BUNDLED AND MSVC` — Windows-only in Neovim's own build
    logic), `WIN32YANK_X86_64` (a prebuilt Windows clipboard *binary*
    release asset, not a source archive), and `UNCRUSTIFY` (a C code
    formatter invoked only from Neovim's dev scripts, not the CMake build
    graph). This is a judgment call beyond the brief's literal "exclude
    luajit only" — flagged clearly here and in `VERSIONS.md` so it's easy
    to revisit if a later task needs one of these after all.
- Verified both the `LIBUV`/`UNIBILIUM`/etc. GitHub-archive tarballs and
  the two `neovim/deps`-mirrored ones (`LPEG`, and `GETTEXT`/`LIBICONV`
  before excluding them) extract to a single top-level directory, same as
  the pinned toolchain assets, so `--strip-components=1` extraction works
  uniformly for every source in this pipeline (including lua.org's tarball).
- Ran `scripts/fetch-sources.sh` end-to-end: Neovim tarball + 13 manifest
  deps + PUC Lua all downloaded, sha256-verified against `VERSIONS.md`
  pins, and extracted to `src-cache/<dep>/` (`src-cache/` total ~118 MB,
  gitignored). Ran it again immediately after: every download and
  extraction step reported "skipping" (cache/sha256 hit, directory already
  populated) — confirms idempotency.
- Pinned all 15 sources (Neovim + 13 deps + lua) into `VERSIONS.md` with
  version, asset filename, url, and sha256 for each.

### 2026-07-14 — Task 4: leaf deps compile to wasm32-wasi (rung 2)

- Added `scripts/build-deps.sh` (per-dep, resumable, `bash scripts/build-deps.sh
  [dep...]`), `scripts/wasi-toolchain.cmake` (CMake cross-compile file:
  `CMAKE_SYSTEM_NAME=WASI`, wasm32-wasi target, compiler/AR from `$WASI_SDK`,
  the four wasi-libc `-D_WASI_EMULATED_*` defines + matching
  `-lwasi-emulated-*` link flags), and `patches/lua51-wasi.patch`.
- Gate green: `bash scripts/build-deps.sh` exits 0; produces 12 wasm32-wasi
  `.a` archives in `build/deps/lib/` + staged headers in `build/deps/include/`;
  host `build/host/bin/lua -v` and `luac -v` both print `Lua 5.1.5`. Re-run is
  an all-"skipping" no-op (idempotent).
- Archives verified as real wasm objects: `llvm-objdump --file-headers` reports
  `file format wasm`; `libtree-sitter-c.a` exports `T tree_sitter_c`;
  `liblua.a` exports the full `lua_*`/`luaL_*` API. wasm objects show the
  expected undefined `__stack_pointer` / `__indirect_function_table`.

**Per-dep outcome table:**

| dep | build path | outcome | notes |
| --- | --- | --- | --- |
| lua (host) | native `make generic` (system clang) | clean | for Neovim's build-time Lua->C codegen; `generic` platform needs no readline/posix extras |
| lua (wasm) | direct clang → `liblua.a` | **patched** | (1) `lua51-wasi.patch`: WASI has no `tmpnam`/`L_tmpnam`; (2) needs `-mllvm -wasm-enable-sjlj` because wasi-libc `<setjmp.h>` hard-errors without WebAssembly EH (Lua error handling is setjmp/longjmp) |
| utf8proc | CMake + `wasi-toolchain.cmake` → `libutf8proc.a` | clean | its own `CMakeLists` builds a static lib cleanly |
| tree-sitter core | CMake + `wasi-toolchain.cmake` → `libtree-sitter.a` | clean | `TREE_SITTER_FEATURE_WASM=OFF` (no wasmtime); its `CMakeLists` sets `_POSIX_C_SOURCE`/`_DEFAULT_SOURCE`, which is what makes `parser.c`'s `fdopen()` (debug dot-graph path) declare cleanly |
| lpeg | direct clang → `liblpeg.a` | clean | compiled against our staged Lua headers |
| unibilium | direct clang → `libunibilium.a` | clean | plain C; `-DTERMINFO_DIRS=...` supplied (matches its CMake default); runtime terminfo lookup is inert in the sandbox |
| lua-compat53 | direct clang → `libluacompat53.a` | clean | header/source dep (luv consumes `LUA_COMPAT53_DIR` as source in Task 5/6); we compile `c-api/compat-5.3.c` as a wasm compile-proof and stage `compat-5.3.h` |
| tree-sitter-c/lua/vim/vimdoc/query/markdown | direct clang → 6× `libtree-sitter-<lang>.a` | clean | generated `parser.c` (+ `scanner.c` where present); markdown bundles both block+inline grammars with prefixed object names |

**Surprises / notes for later tasks:**

- **SjLj is load-bearing for the whole Neovim link.** Neovim's own error
  handling is longjmp-based, and it links against `liblua.a` built with
  `-mllvm -wasm-enable-sjlj`. The Neovim object compile AND the final
  executable link (rung 3/4) must use this same flag and an engine that
  implements the WebAssembly exception-handling proposal (Node 24's WASI does).
- **`io.tmpfile` / `fdopen` are compile-clean but may be link-unresolved.**
  `liolib.c` (`io.tmpfile`) and tree-sitter `parser.c` (`fdopen`, dot-graph
  debug) reference symbols wasi-libc declares-but-may-not-define. They compile
  (warnings only) into the archives; if the final Neovim link fails on
  undefined `tmpfile`/`fdopen`, stub them or dead-strip those code paths. Both
  are non-essential (temp files / parser debug tracing).
- **lpeg is a STATIC archive, no dynamic loading.** Under WASI there is no
  `dlopen`; Neovim must register lpeg via `luaL_requiref`/preload of
  `luaopen_lpeg` and link `liblpeg.a` statically (flagged for the Task 6 Lua
  wiring). Same applies to the tree-sitter parser archives (loaded by symbol,
  not `dlopen`).
- **CMake 4.3 ships a builtin `Platform/WASI.cmake`**, so `wasi-toolchain.cmake`
  did not need to inject the SDK's own cmake module path.
- No dependency versions were overridden — all pins in `VERSIONS.md` stand.
  `libvterm`/`libtermkey`/`msgpack-c` remain absent from the manifest (Task 3
  finding); nothing to build for them here.
