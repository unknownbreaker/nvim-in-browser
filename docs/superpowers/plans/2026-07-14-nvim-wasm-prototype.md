# nvim-wasm-prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A strict clean-room build of Neovim to wasm32-wasi that passes the parent repo's `scripts/smoke-nvim.mjs` (boot, RPC edit, idle gate) — no nvim-wasm-derived code.

**Architecture:** wasi-sdk (clang → wasm32-wasi) compiles Neovim + deps; our own `shims/` C layer replaces libuv's polling core (poll_oneoff-backed, single-threaded) and stubs threads/signals/processes/PTY; `wasm-opt --asyncify` (import `wasi_snapshot_preview1.poll_oneoff`) makes blocking suspendable; the parent engine host validates the result unchanged.

**Tech Stack:** wasi-sdk, Binaryen (wasm-opt), CMake+Ninja, PUC Lua 5.1 (LuaJIT can't target wasm), bash scripts, Node (validation host).

## Global Constraints

- **STRICT CLEAN-ROOM (binding on every task):** NEVER read, fetch, clone, or consult MuNeNICK/nvim-wasm or MuNeNICK/monaco-neovim-wasm — no code, patches, Makefiles, README, demos, npm packages, or the deployed site. Allowed references ONLY: neovim/neovim source+docs, wasi-libc, wasi-sdk, Binaryen, libuv upstream, WASI preview1 spec, Emscripten docs, Lua/lua.org, dep upstreams (utf8proc, tree-sitter, libvterm, luv, lpeg…), and general non-excluded web references. Public interface facts already in the parent spec are usable: nvim argv `["nvim","--embed","-u","NORC","--noplugin","-i","NONE","-n"]`, Binaryen Asyncify ABI (`asyncify_start_unwind/stop_unwind/start_rewind/stop_rewind/get_state`), WASI preview1 struct layouts (subscription stride 48, event stride 32).
- **Success bar:** iterate until rung 8 (smoke PASS). Do not stop at "best effort". Blockers requiring a user decision (Emscripten pivot, upstream-source patching beyond build-system scope) stop the loop and surface — via BLOCKED status, never silent scope-cut.
- All work under `nvim-wasm-prototype/`; parent-repo changes limited to `.gitignore`, one README pointer line, and env-var parameterization of `scripts/smoke-nvim.mjs` (Task 2 only).
- Toolchains project-local in gitignored `nvim-wasm-prototype/.toolchain/`; downloads SHA-256-pinned in `VERSIONS.md` (print-then-pin, same pattern as `scripts/fetch-nvim-wasm.mjs`); cmake/ninja via brew only if absent.
- `.toolchain/ build/ src-cache/ dist/` gitignored. STATUS.md updated at every rung transition (append-mostly; record failures too).
- Scripts: `set -Eeuo pipefail`, idempotent/resumable, fail loudly naming the failing step.
- Branch: `prototype/clean-room-build` off main. Conventional commits.
- Shell rule (hook-enforced, applies to Bash TOOL calls, not script contents): one command per call; `;` `&&` `||` `|` `$(` backticks `>>` `<<` blocked in tool calls. Inside committed `.sh` files, normal shell syntax is fine.

**Ladder (from spec — STATUS.md tracks the current rung):**
1 toolchain hello-world → 2 leaf deps → 3 libuv+shims → 4 nvim links → 5 reaches first poll_oneoff under parent host → 6 answers `nvim_ui_attach` → 7 buffer-edit round-trip → 8 `smoke-nvim.mjs` PASS incl. idle gate (**done**) → 9 stretch: browser smokes, size/boot comparisons.

---

### Task 1: Scaffold + toolchain + rung 1

**Files:**
- Create: `nvim-wasm-prototype/README.md`, `STATUS.md`, `VERSIONS.md`, `scripts/fetch-toolchain.sh`, `scripts/env.sh`, `test/hello.c`
- Modify: root `.gitignore`, root `README.md` (one pointer line)

**Interfaces:**
- Produces: `.toolchain/wasi-sdk/` (clang at `bin/clang`), `.toolchain/binaryen/` (`bin/wasm-opt`); `scripts/env.sh` exporting `WASI_SDK`, `WASM_OPT`, `PROTO_ROOT` for later scripts to `source`.

- [ ] **Step 1: Scaffold docs.** `README.md` opens with the clean-room provenance statement (sources consulted whitelist verbatim from Global Constraints; explicit statement that no nvim-wasm code was consulted at any point) plus a 5-line "what this is". `STATUS.md` starts with the ladder as a checklist and a dated log section. `VERSIONS.md` lists components (wasi-sdk, binaryen, neovim, each dep) with `version:` and `sha256:` fields, initially `UNPINNED`.
- [ ] **Step 2: Root repo edits.** Append to root `.gitignore`: `nvim-wasm-prototype/.toolchain/`, `nvim-wasm-prototype/build/`, `nvim-wasm-prototype/src-cache/`, `nvim-wasm-prototype/dist/`. Append to root README under "Third-party engine": one line: `An experimental clean-room WASM build of Neovim lives in nvim-wasm-prototype/ (see its README).`
- [ ] **Step 3: Write `scripts/fetch-toolchain.sh`.** Defensive bash. Downloads (macOS arm64 assets) from official GitHub releases: wasi-sdk (`https://github.com/WebAssembly/wasi-sdk/releases`) and Binaryen (`https://github.com/WebAssembly/binaryen/releases`) — pick the latest stable release of each at implementation time, record exact version+sha256 in VERSIONS.md via `--print-hashes` mode, then pin. Extract into `.toolchain/wasi-sdk/` and `.toolchain/binaryen/` (strip version dirs). Idempotent: skip download when present and hash-valid. Verify `cmake` and `ninja` exist (`command -v`), else print the exact brew command and exit 1 (installing via brew is allowed if absent).
- [ ] **Step 4: Rung 1 check.** `test/hello.c`: prints "hello wasi" and exits 0. Compile: `.toolchain/wasi-sdk/bin/clang --target=wasm32-wasi -O2 -o build/hello.wasm test/hello.c`. Run in Node ≥20 with `node --experimental-wasi-unstable-preview1` or a 10-line runner using `node:wasi`. Expected output: `hello wasi`. Record rung 1 ✅ + toolchain versions in STATUS.md.
- [ ] **Step 5: Commit** (`feat: prototype scaffold, pinned wasi toolchain, rung 1`). Verify `git status` shows no `.toolchain/` or `build/` files staged.

### Task 2: Parameterize the parent smoke harness

**Files:**
- Modify: `scripts/smoke-nvim.mjs` (parent repo)

**Interfaces:**
- Produces: env vars `NVIM_WASM_PATH` and `NVIM_RUNTIME_PATH` override the two asset paths (defaults unchanged: `vendor/nvim-wasm/nvim-asyncify.wasm`, `vendor/nvim-wasm/nvim-runtime.tar.gz`). Print which paths are in use at startup.

- [ ] **Step 1:** Add at the top where paths are resolved: `const WASM_PATH = process.env.NVIM_WASM_PATH ?? <existing default>;` and same for runtime; log both.
- [ ] **Step 2: Regression check.** Run `node scripts/smoke-nvim.mjs` with no env vars — must PASS unchanged (this is the guard that the tweak broke nothing).
- [ ] **Step 3:** Run `env NVIM_WASM_PATH=/nonexistent node scripts/smoke-nvim.mjs` — must fail loudly mentioning the bad path (proves the override is live).
- [ ] **Step 4: Commit** (`feat: smoke harness accepts engine paths via env vars`).

### Task 3: Sources + version pinning

**Files:**
- Create: `nvim-wasm-prototype/scripts/fetch-sources.sh`
- Modify: `VERSIONS.md`, `STATUS.md`

**Interfaces:**
- Produces: `src-cache/neovim/` (extracted pinned release tarball), `src-cache/<dep>/` for each dep; VERSIONS.md fully pinned. Dep list and versions come from **Neovim's own** `cmake.deps/deps.txt` (or equivalent manifest in the pinned release) — read it after extracting and fetch the URLs it names (excluding LuaJIT; add `lua-5.1.5` from lua.org instead).

- [ ] **Step 1:** Write `fetch-sources.sh`: fetch the latest **stable** Neovim release tarball (not nightly) from github.com/neovim/neovim/releases; extract; parse its deps manifest; download each dep source archive it references (libuv, luv, lpeg, tree-sitter + parsers, utf8proc, libvterm, unibilium if referenced — whatever the manifest actually lists), plus `https://www.lua.org/ftp/lua-5.1.5.tar.gz`. Same print-then-pin SHA discipline. Idempotent.
- [ ] **Step 2:** Run it; pin everything in VERSIONS.md; note in STATUS.md which deps the manifest listed (this is discovery — record the actual list).
- [ ] **Step 3: Commit** (`feat: pinned neovim + dependency sources`).

### Task 4: Rung 2 — leaf dependencies compile

**Files:**
- Create: `scripts/build-deps.sh`, `scripts/wasi-toolchain.cmake`, per-dep patch files under `patches/` as needed
- Modify: `STATUS.md`, `VERSIONS.md` (note any dep version overrides)

**Interfaces:**
- Produces: static libs in `build/deps/lib/` + headers in `build/deps/include/` for: **lua-5.1** (host+wasm builds — a HOST lua/luac is also needed for Neovim's build-time codegen), **utf8proc**, **tree-sitter (libtree-sitter)**, **lpeg**, **libvterm**, plus any others the manifest demands. `wasi-toolchain.cmake`: CMake toolchain file setting `CMAKE_SYSTEM_NAME=WASI`, compiler paths from `env.sh`, `--target=wasm32-wasi`, and a common flags block (`-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID` with matching `-lwasi-emulated-*` link flags — wasi-libc's documented emulation layers).

**This is an exploration task.** The acceptance gate, not prescribed code, defines done: `bash scripts/build-deps.sh` exits 0 with every listed artifact present. Known first moves: lua 5.1 builds with `make generic CC=<wasi clang> AR=... RANLIB=...` after disabling `readline`/`system`-dependent bits (`luaconf.h` tweaks via `patches/lua51-wasi.patch` — ours); utf8proc and libtree-sitter are plain C, expected near-clean; lpeg compiles against lua headers; libvterm is plain C99 (its `pangoterm` bits aren't built). Every patch goes in `patches/` with a header comment saying what and why. Iterate per-dep; record each dep's outcome (clean / patched / notes) in STATUS.md.

- [ ] Rung-2 gate: `build-deps.sh` green; artifacts listed above exist; STATUS.md updated; commit (`feat: leaf deps compile to wasm32-wasi`).

### Task 5: Rung 3 — libuv against our shim layer

**Files:**
- Create: `shims/` (C sources + headers, e.g. `uv_wasi_core.c`, `pthread_stubs.c`, `signal_stubs.c`, `process_stubs.c`, `pty_stubs.c` — actual decomposition is the implementer's), `patches/libuv-*.patch` (build-system-level), extend `scripts/build-deps.sh`
- Modify: `STATUS.md`

**Interfaces:**
- Produces: `build/deps/lib/libuv.a` linking cleanly into a wasm test program that: creates a loop, runs a 10ms `uv_timer`, reads a line from stdin via `uv_pipe`/`uv_stream` on fd 0, writes to fd 1, exits. Test program at `test/uv-smoke.c`, run under Node WASI (rung-3 gate).

**Exploration task — the core inventive work.** Strategy (from spec): compile libuv's portable/unix sources where they compile; replace the platform polling layer with our own `poll_oneoff`-backed single-threaded implementation of the io-watcher/timer core; stub `uv_thread_*`/mutexes (single thread: mutexes are no-ops), `uv_signal_*` (register-and-never-fire), `uv_spawn` (fail with `UV_ENOSYS`), TTY as plain pipes. The libuv API surface that must WORK (not just link) is what Neovim's `src/nvim/event/*` uses: loop init/run/stop, timers, `uv_pipe_t`/`uv_stream_t` read/write on stdio, `uv_async` (single-thread: immediate-callback or pending-flag), fs ops (sync paths via wasi-libc are fine), `uv_idle`/`uv_prepare`/`uv_check`. Everything else: honest `UV_ENOSYS` stubs. Discover the true surface from Neovim's linker errors in Task 6 and iterate back here as needed.

- [ ] Rung-3 gate: `test/uv-smoke.c` passes under Node WASI (timer fires, stdin line echoes); STATUS.md documents the shim design (what's real, what's stubbed, what's ENOSYS); commit (`feat: libuv wasi shim layer, rung 3`).

### Task 6: Rung 4 — Neovim compiles and links

**Files:**
- Create: `scripts/build-nvim.sh`, `patches/neovim-*.patch` (build-system + minimal source guards), extend shims as linker errors demand
- Modify: `STATUS.md`

**Interfaces:**
- Produces: `build/nvim/bin/nvim` (wasm32-wasi module, pre-asyncify). Build wiring: Neovim's CMake with `-DCMAKE_TOOLCHAIN_FILE=wasi-toolchain.cmake`, deps pointed at `build/deps` (`DEPS_PREFIX` or the release's equivalent), host `lua`/`luac` for codegen steps, `PREFER_LUA`-style PUC-Lua selection — **checkpoint: if the pinned Neovim no longer supports PUC Lua, restoring it via `patches/` is in scope (build-system + luajit-compat shims like `bit` library); document the choice in STATUS.md.** luv builds here too (needs libuv + lua).
- Expected fight areas (attack via compile/link errors, never via the excluded repo): `os/pty_process_unix`, `os/signal`, `os/process` (guard with our stubs), `msgpack` (bundled), `iconv/intl` (disable), `setjmp/longjmp` in regexp/lua glue (wasi-sdk sjlj support — add the documented flags if needed), `gettimeofday/clock_gettime` (wasi-libc has them).

- [ ] Rung-4 gate: `nvim` wasm binary exists; `wasm-objdump`/`WebAssembly.Module.exports` in Node shows `_start` and memory; STATUS.md updated (list of patches with one-line rationale each); commit (`feat: neovim links for wasm32-wasi, rung 4`).

### Task 7: Rungs 5–8 — asyncify, runtime, boot loop until smoke PASS

**Files:**
- Create: `scripts/asyncify.sh` (`wasm-opt -O2 --asyncify --pass-arg=asyncify-imports@wasi_snapshot_preview1.poll_oneoff <in> -o dist/nvim-asyncify.wasm` — exact flags verified against installed Binaryen's `--help`), `scripts/package-runtime.sh` (neovim `runtime/` tree → `dist/nvim-runtime.tar.gz`, layout discovered by what `$VIMRUNTIME` needs), `scripts/smoke.sh` (runs parent harness: `env NVIM_WASM_PATH=$PROTO_ROOT/dist/nvim-asyncify.wasm NVIM_RUNTIME_PATH=$PROTO_ROOT/dist/nvim-runtime.tar.gz node <parent>/scripts/smoke-nvim.mjs`)
- Modify: `STATUS.md`, possibly parent-host compatibility notes

**Interfaces:**
- Consumes: parent host expectations (documented in parent spec/impl notes): WASI preview1 imports only (plus possibly `env.*` helpers — if our binary needs none, better), `_start`, Asyncify ABI exports. The parent host's asyncify scratch discovery: it prefers exported region helpers, else grows memory itself — our binary needs no special export if memory-grow fallback works; verify against `src/engine/nvim-host.ts` (OUR code — allowed and required reading).
- Produces: `dist/nvim-asyncify.wasm` + `dist/nvim-runtime.tar.gz` passing rungs 5→8.

**Exploration loop.** Climb: (5) `_start` reaches first `poll_oneoff` under the parent host without trapping — debug via host `fatal` messages and targeted `fprintf(stderr,…)` patches; (6) `--embed` handshake: `nvim_ui_attach` gets a response; (7) `nvim_input("ihello")` → `nvim_buf_get_lines` returns it; (8) full `scripts/smoke.sh` PASS **including the idle-wakeups assertion** — and since our shim controls polling, implement stdin subscription properly (fd_read subscription that actually blocks until data) so the parent's backoff never engages; idle should be genuinely event-driven. Each rung: STATUS.md entry with what broke and what fixed it.

- [ ] Rung-8 gate: `bash scripts/smoke.sh` prints SMOKE PASS with idle assertion; STATUS.md final entry with binary size + boot time vs vendored (vendored: 8,386,869 bytes; measure ours); commit (`feat: clean-room nvim wasm passes smoke, rung 8`).

### Task 8: Wrap-up — docs, merge

**Files:**
- Modify: `nvim-wasm-prototype/README.md` (results section), `STATUS.md`, parent spec (one line under Milestone notes pointing at the prototype outcome), `memory/journal/` entry
- No release (the prototype does not ship in dist/chromium; the vendored engine remains the extension's engine until a deliberate swap decision).

- [ ] **Step 1:** README results section: what was achieved, binary size/boot comparison, patch inventory, what an engine swap would take.
- [ ] **Step 2:** Full parent gates still green: `npm run typecheck`, `npm test`, `node scripts/smoke-nvim.mjs` (default vendored paths — proves Task 2's override didn't regress).
- [ ] **Step 3:** Commit docs; push branch; PR to main; merge (standing authorization; stop if branch protection blocks).

---

## Self-review notes

- Spec coverage: structure/scripts (T1,3–7), clean-room whitelist (Global Constraints, embedded in every dispatch), pivot clause (BLOCKED-and-surface rule), ladder rungs 1(T1) 2(T4) 3(T5) 4(T6) 5–8(T7) 9-stretch (optional, post-T8), parent-coupling limits (T2 + T1 step 2), provenance statement (T1), hygiene rules (Global Constraints).
- Exploration tasks (4–7) intentionally define acceptance gates + first moves rather than complete code — the spec's "checkpoint loop, not a fixed task list" execution shape. Scaffold/harness tasks (1–3, 8) are fully specified.
- Interface consistency: `env.sh` vars (T1) used by T4–7 scripts; `NVIM_WASM_PATH`/`NVIM_RUNTIME_PATH` (T2) consumed by T7 `smoke.sh`; `build/deps` layout (T4) consumed by T5/T6; ladder numbering matches spec.
