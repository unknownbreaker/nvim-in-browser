# STATUS

Living findings log for the nvim-wasm-prototype clean-room build. Append-mostly:
failed experiments get recorded, not erased.

## Validation ladder

- [x] 1. Toolchain fetch + hello-world C compiles to wasm32-wasi and runs in Node.
- [x] 2. Leaf deps compile (utf8proc, treesitter, lua 5.1, …). Host lua/luac built.
- [x] 3. libuv compiles against our shim layer (links, symbols resolved).
- [x] 4. Neovim objects compile; binary links.
- [x] 5. `_start` reaches first `poll_oneoff` under the parent engine host.
- [x] 6. `--embed` handshake: answers `nvim_ui_attach`.
- [x] 7. Buffer edit round-trip via RPC.
- [x] 8. Full `smoke-nvim.mjs` PASS including idle-wakeups gate. **(Definition of done)**
- [ ] 9. Stretch: overlay/browser smokes against our binary; compare binary
      size and boot time vs vendored.
      **Progress (2026-07-15, parity-gaps Task 4):** the three parity gaps
      (progpath, io.write RPC safety, static tree-sitter) are closed and
      `scripts/smoke.sh` now runs `test/parity-check.mjs` immediately after
      the parent smoke harness passes, so PARITY PASS is part of the
      standing rung-8+ gate, not a separate manual step. Browser/overlay
      smokes against our binary (and the size/boot-time comparison) remain
      the only unchecked stretch item.

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

### 2026-07-15 — Task 5: libuv on wasm32-wasi via clean-room shim layer (rung 3)

**Gate green:** `bash test/uv-smoke.sh` — compiles `test/uv-smoke.c` against
`build/deps/lib/libuv.a`, runs under `node test/run-wasi.mjs` with piped
stdin, PASSES both cases: (A) stdin data already buffered, (B) data arriving
300ms in (proves a *blocked* loop wakes on fd readiness). 10ms timer fired at
12ms; line echoed verbatim fd0→fd1 via `uv_pipe`/`uv_read_start`/`uv_write`;
`uv_run` drained to 0; `uv_loop_close` returned 0. `build-deps.sh` re-run is
an all-"skipping" no-op (idempotent).

**De-risking probes (ran these FIRST, before any design commitment):**

- **poll_oneoff via wasi-libc `poll()` works under Node 24 `node:wasi`**:
  pure clock subscription blocks accurately (50ms asked → 52ms measured);
  `fd_read` subscription on piped stdin *blocks and wakes* when data arrives
  later (300ms delayed write → poll returned at ~230ms after loop entry with
  `POLLIN`); writer close surfaces as `POLLIN|POLLHUP` (wasi-libc POLLHUP is
  0x2000). This was the riskiest assumption of the whole rung; it held.
- **`fcntl(F_SETFL, O_NONBLOCK)` on fd 0 works under Node WASI** (uvwasi
  honors `fd_fdstat_set_flags`): `read()` on a drained-but-open pipe returns
  EAGAIN in 0ms instead of blocking. Consequence: upstream `stream.c` /
  `pipe.c` read/write machinery works *unmodified* — no read-wrapper layer
  needed.

**Architecture decision — hybrid of the two candidate shapes.** Considered
(a) compile libuv portable/unix sources + custom platform polling core vs
(b) reimplement the public uv_* API by hand. Chose (a) with targeted hand
shims where WASI genuinely lacks the substrate. Compiled UNMODIFIED from
upstream: `fs-poll, idna, inet, random, strscpy, strtok, timer, uv-common,
uv-data-getter-setters, version` + unix `core, dl, fs, getaddrinfo,
getnameinfo, loop-watcher, loop, no-fsevents, no-proctitle, pipe, poll,
posix-hrtime, stream, tcp`. Replaced with shims (`shims/uv-wasi-*.c`, each
header-commented): the platform poll core, async, threads, threadpool,
signal, process, tty, udp, platform-misc, plus `wasi-libc-missing.c`
(POSIX symbols wasi-libc declares-or-omits but never defines) and
`shims/include/` headers wasi-libc lacks (`termios.h`, `pwd.h`, `grp.h`,
`netdb.h`, `net/if.h`, `sys/statfs.h`). `shims/uv-wasi-fixups.h` is
force-included (`-include`) into every libuv TU to re-declare the POSIX
surface wasi-libc hides behind `__wasilibc_unmodified_upstream` (sockets,
sigmask, rlimit/priority/sched, `sockaddr_un.sun_path` via tag-rename,
SO_*/CMSG_* constants). `patches/libuv-wasi.patch` is deliberately tiny —
3 hunks: `uv/unix.h` gains a `__wasi__` platform-include (uv/posix.h loop
fields), `random.c` gains a `__wasi__` dispatch branch (getentropy), and
`core.c`'s rusage field-copy guard adds `!defined(__wasi__)` (wasi-libc's
emulated rusage has only utime/stime).

**Polling core (`shims/uv-wasi-poll.c`)** — modeled on upstream
`posix-poll.c` (MIT, in-tree), two deliberate deviations:

1. **nfds==0 sleeps instead of returning.** Upstream returns immediately
   when no fds are watched — safe there only because every loop owns an
   async-wakeup fd (so nfds ≥ 1 always). Our async shim is fd-less, so a
   timer-only loop really can reach nfds==0; returning would busy-spin
   uv_run until the timer expires. We sleep the full backend timeout on a
   pure clock subscription (`poll(NULL, 0, timeout)`). Verified: a 2s
   timer-only program consumes 0.02s user CPU over 2.04s wall — the loop
   genuinely parks in `poll_oneoff`. **This is the rung-8 idle-wakeups
   property, designed in now: no busy-wait paths exist.**
2. No SIGPROF masking (`UV_LOOP_BLOCK_SIGPROF` accepted, ignored — WASI
   has no signal delivery), and no `signal_io_watcher` special case.

**Async without an fd (`shims/uv-wasi-async.c`)**: single thread ⇒
`uv_async_send` can only run from loop callbacks, never concurrently with a
blocked poll. Send = set handle pending + `uv__io_feed(loop's fd-less
async_io_watcher)`. Upstream machinery does the rest: non-empty
pending_queue forces `uv_backend_timeout()==0` (next poll can't block),
`uv__run_pending` dispatches `UV__ASYNC_IO` → our `uv__async_io` drains
`loop->async_handles` exactly like upstream. No spinning, correct uv_run
phase ordering, zero new loop-state invariants.

**Threadpool inline (`shims/uv-wasi-threadpool.c`)**: `uv__work_submit`
runs the work callback synchronously at submit, then posts completion
through `loop->wq` + `uv_async_send(&loop->wq_async)` — done callbacks
still fire asynchronously on the next loop turn (upstream contract kept);
`uv_cancel` always UV_EBUSY (work has always already run).

**What's real / stubbed / ENOSYS:**

| surface | status |
| --- | --- |
| loop, timers, idle/prepare/check, pending queue | real (upstream code) |
| uv_pipe_open + stream read/write on existing fds | real (upstream stream.c/pipe.c over our poll core) |
| uv_fs_* | real via wasi-libc (sync syscalls; async runs inline-at-submit, cb on next tick); mkdtemp/mkstemp implemented in shim (getentropy+mkdir/open); statfs mapped onto statvfs; chown/link-perms fail ENOSYS |
| uv_async | real (fd-less pending-flag design above) |
| uv_random / uv_hrtime / uv_now / uv_sleep / uv_clock_gettime | real (WASI random_get / clock_gettime) |
| uv_mutex/rwlock/sem/cond/once/key | no-op-correct for single thread; blocking waits (`sem_wait` on 0, `cond_wait`) abort loudly = deadlock made visible |
| uv_thread_create | UV_ENOSYS (honest; no threads target) |
| uv_signal_* | register-and-never-fire (start succeeds, cb never runs — WASI has no signal delivery) |
| uv_spawn / uv_kill / uv_pipe(2fds) | UV_ENOSYS (no processes/pipes in preview1) |
| uv_tty_* | TTY-as-stream: init=stream over fd, set_mode=no-op success, get_winsize=UV_ENOTSUP |
| uv_tcp_* | compiles from upstream; every socket op fails ENOSYS at runtime via libc stubs |
| uv_udp_* | hand shim: init/close coherent, everything else UV_ENOSYS (upstream udp.c needs multicast surface WASI lacks) |
| uv_getaddrinfo/getnameinfo | upstream code; libc stub returns EAI_FAIL → UV_EAI_FAIL (honest) |
| uv_exepath / uv_cpu_info / uv_interface_addresses | UV_ENOSYS |
| uv_get_total/free_memory, uv_resident_set_memory, uv_uptime, uv_loadavg | coarse-but-real (wasm linear memory size, monotonic clock) |
| fs events (uv_fs_event_*) | UV_ENOSYS (upstream no-fsevents.c) |

**Risks / carry-forwards for rung 4+:**

- **Neovim's TUI runs on a `uv_thread`** (and clipboard/job control spawn
  processes). `uv_thread_create`=ENOSYS means the wasm build must stay on
  the `--embed` headless path (which is the plan); expect rung-4/6 link or
  runtime probes to confirm nothing else insists on a real thread. nvim's
  `uv_cond`/`uv_sem` uses (if any hot ones exist) will abort loudly by
  design — better than silent hangs; revisit per-callsite if hit.
- **`uv_exepath` = ENOSYS** → `v:progpath` empty; nvim runtime-path
  discovery may need a synthetic exepath under the wasm host (rung 6).
- **`uv_tty_get_winsize` = ENOTSUP** → embedder must drive UI size over
  RPC (`nvim_ui_attach` does exactly this).
- **luv (rung 4) links the whole public uv surface** — that's why tcp/udp/
  getaddrinfo stubs exist as linkable, honest-failing symbols rather than
  being dropped.
- wasi-libc `poll()` quirk noted for later: POLLPRI-only subscriptions
  return ENOSYS; our poll core never requests POLLPRI (UV__POLLPRI is 0 on
  this target). UV__POLLRDHUP (0x2000 fallback) numerically equals wasi
  POLLHUP — coincidentally correct semantics (both mean hangup).
- `test/uv-smoke.sh` is the reusable gate harness; `test/run-wasi.mjs`
  untouched (stdin piping happens in the shell harness, not the runner).

### 2026-07-15 — Task 5 review hardening (rung 3 findings fixed)

A review of the rung-3 libuv port surfaced four findings, all now fixed:

- **Duplicate strong symbol (Important):** `shims/uv-wasi-platform.c` also
  defined `uv_free_interface_addresses`, which upstream `src/uv-common.c`
  already defines (compiled unmodified into `libuv.a`). `ar` doesn't dedupe
  symbols across archive members, so this only failed at final-link time,
  and only for a consumer whose symbol needs pulled in *both* objects —
  `test/uv-smoke.c` never did, so rung 3's own gate missed it. Fixed by
  deleting the shim's definition (upstream's no-op is correct: our
  `uv_interface_addresses` always returns `UV_ENOSYS` and never allocates).
  **New gate added to close this whole class of bug:** `test/uv-linkall.c`
  — a TU that takes the address of one exported symbol from every
  `shims/uv-wasi-*.c` object plus a dozen upstream-heavy symbols
  (`uv_strerror`, `uv_loop_init`, `uv_tcp_init`, `uv_udp_init`,
  `uv_getaddrinfo`, `uv_fs_open`, `uv_random`, `uv_hrtime`, …), compiled and
  *linked* (never run) as the first step of `test/uv-smoke.sh` ("link-all
  check"). Verified it reproduces the exact `wasm-ld: error: duplicate
  symbol: uv_free_interface_addresses` failure against the pre-fix shim,
  and passes clean after.
- **Busy-wait/silent-failure risk (Important):** `uv__wasi_sleep()` in
  `shims/uv-wasi-poll.c` ignored `poll()`'s return value entirely. On a
  host whose `poll_oneoff` ever rejected a clock-only subscription, the
  infinite-timeout branch would busy-spin (tight retry loop, no actual
  sleep) and the finite branch would return "elapsed" immediately with no
  time having passed — both violate this port's core no-busy-wait
  invariant (see rung-3's own poll-core notes above). Fixed: check `rc`,
  loop past `EINTR` (recompute and continue — genuinely nothing to report),
  abort loudly (`fprintf` naming `uv__wasi_sleep` + `errno`, then `abort()`)
  on anything else, consistent with `uv__io_poll`'s own
  abort-on-unexpected-errno handling a few lines down.
- **Patch provenance header (Minor):** `patches/libuv-wasi.patch` lacked
  the WHAT/WHY/CLEAN-ROOM-PROVENANCE header comment block that
  `patches/lua51-wasi.patch` established as this project's patch-file
  convention. Added; verified both `patch -p1` and `git apply --check`
  still accept the file with the header prepended (leading `#`-comment
  lines before the first `---`/`diff` hunk are tolerated by both tools),
  and a from-scratch `build-deps.sh` rebuild (which applies it via
  `patch -p1 -d`) still succeeds.
- **Silent re-entrant `uv_once` (Minor):** `shims/uv-wasi-threads.c`'s
  `uv_once()` only checked `*guard == 0`, so a re-entrant call made while
  the guarded callback is still running (`*guard == 1`) fell through and
  returned as if already-initialized — a silent partial-init hazard on a
  single-threaded target where this can only ever be a genuine
  self-deadlock, never a real "someone else already finished it" race.
  Fixed: `*guard == 1` now calls the file's existing loud-deadlock helper
  (`uv__wasi_deadlock`), matching the abort-on-deadlock style already used
  by `uv_sem_wait`/`uv_cond_wait` in the same file.

**Verification:** deleted `build/deps/lib/libuv.a`, confirmed
`bash test/uv-smoke.sh`'s new link-all step FAILED with the exact
duplicate-symbol error above against the unfixed shim; re-ran
`bash scripts/build-deps.sh` (full, from scratch) and `bash test/uv-smoke.sh`
after all four fixes — link-all check, case A-immediate, and case B-delayed
all green, exit 0.

### 2026-07-15 — Task 6: Neovim v0.12.4 compiles and LINKS for wasm32-wasi (rung 4)

**Gate green:** `scripts/build-nvim.sh` produces
`build/nvim/bin/nvim` = **5,983,467 bytes** (wasm32 module, pre-asyncify,
pre-wasm-opt). `llvm-objdump --file-headers` prints `file format wasm`
(note: llvm-objdump then exits nonzero on ANY *linked* wasm module — it
deep-dumps only wasm object files; it does the same on rung 1's known-good
hello.wasm, so the verify step asserts on the format line and defers real
validation to Node). `node test/check-module.mjs build/nvim/bin/nvim`:
`WebAssembly.compile` OK, exports = `_start` (function) + `memory` — PASS.
Re-run of `build-nvim.sh` is an all-"skipping" no-op (idempotent; the ninja
step resumes mid-build after a fixed error, which is exactly how the
compile-error grind was iterated).

**Bonus curiosity run (single, rung 5 unchanged):**
`node test/run-wasi.mjs build/nvim/bin/nvim -- --version` prints
`NVIM v0.12.4 / Build type: Release / Lua 5.1` and exits 0 under Node 24's
WASI. Full startup (`--embed`) is rung 5's job.

**PUC-Lua checkpoint (resolved, no patches):** v0.12.4 retains first-class
PUC Lua support: `PREFER_LUA=ON` selects `find_package(Lua 5.1 EXACT)`,
defines `NVIM_VENDOR_BIT`, and compiles the vendored `src/bit.c` into the
binary (registered by `lua/stdlib.c`); LuaJIT is then only wanted for unit
tests, which auto-skip. lpeg and luv are statically linked and registered
by direct `luaopen_lpeg`/`luaopen_luv` calls in upstream code — nvim's own
design, no preload patching needed (this closes the rung-2 "static lpeg"
carry-forward; tree-sitter *parser* archives are a different story, below).

**Patch inventory: ZERO patches to Neovim source or build system.** The
entire port landed via shims, headers, and CMake cache variables:

| piece | what/why (one line each) |
| --- | --- |
| `scripts/build-nvim.sh` (new) | steps host-nlua0 → shim → configure → build → verify; resumable, per-step skip |
| `shims/nvim-wasi-fixups.h` (new) | force-included into every nvim TU: declares the fork/exec/pty/sigmask surface wasi-libc hides (`dup`/`dup2`, `F_DUPFD_CLOEXEC`, `umask`, `execvp`, `setsid`, `kill`, `pthread_exit`, `ptsname`, `killpg`, `sigemptyset`&co, `SIG_SETMASK`) |
| `shims/nvim-wasi-stubs.c` → `libnvim-wasi-shim.a` | honest-failure definitions: `openpty`/`forkpty`/`setsid`/`execvp`/`kill`/`wait`/`waitpid`/`ptsname`/`killpg` (ENOSYS/ECHILD), `pthread_exit` (loud abort; only reachable from a luv thread that can never exist), `umask` (no-op 022), `tmpfile` (NULL), `system` (NULL→0 "no shell", else ENOSYS) |
| `shims/include/sys/ioctl.h` (new) | shadows wasi-libc's: keeps its FIONREAD/FIONBIO values, adds `struct winsize` + TIOCSWINSZ/TIOCSCTTY (PtyProc embeds winsize by value) |
| `shims/include/sys/wait.h` (new) | wasi-libc ships none; waitpid + W* status macros for pty_proc_unix.c |
| `shims/include/pty.h` (new) | forkpty/openpty prototypes (nvim's platform-header `#else` branch lands here) |
| `shims/include/netdb.h` (extended) | + `struct protoent`, `getprotobyname`/`getprotobynumber` (luv's constants.c) |
| `shims/uv-wasi-fixups.h` (extended) | + `setuid`/`setgid` declarations (luv's misc.c) |
| `shims/wasi-libc-missing.c` (extended) | + `setuid`/`setgid` (EPERM), `getprotoby*` (NULL), `getifaddrs`/`freeifaddrs` (ENOSYS; declared by wasi-libc's own ifaddrs.h but absent from libc.a — libuv tcp.c's IPv6 scope-id lookup) |
| `scripts/build-deps.sh` (extended) | `lua-host` now built with `-DLUA_USE_POSIX -DLUA_USE_DLOPEN` (generators dlopen nlua0.so; marker file forces one-time rebuild); new `luv` target (single-TU `src/luv.c` vs staged lua+uv headers + compat-5.3, sjlj flag) |
| `test/check-module.mjs` (new) | rung-4 gate: WebAssembly.compile + `_start`/memory export assertions |

**CMake option set used** (see `configure_nvim` in build-nvim.sh):
`CMAKE_TOOLCHAIN_FILE=wasi-toolchain.cmake`, `CMAKE_BUILD_TYPE=Release`,
`PREFER_LUA=ON`, `COMPILE_LUA=OFF`, `ENABLE_LIBINTL=OFF`, `ENABLE_LTO=OFF`
(wasmtime/translations already default-OFF, unibilium default-ON),
`DEPS_PREFIX=build/deps` + `CMAKE_FIND_ROOT_PATH=build/deps`, every dep
pinned via `<DEP>_LIBRARY`/`<DEP>_INCLUDE_DIR` cache vars,
`LUA_PRG=LUA_GEN_PRG=build/host/bin/lua`,
`NLUA0_HOST_PRG=build/host/lib/nlua0.so`,
`CMAKE_C_FLAGS` = emulation defines + `-mllvm -wasm-enable-sjlj` +
`-isystem shims/include` + `-include shims/nvim-wasi-fixups.h`,
`CMAKE_EXE_LINKER_FLAGS=-Wl,-z,stack-size=8388608` (8 MiB),
`CMAKE_C_STANDARD_LIBRARIES` = `-lwasi-emulated-* -lsetjmp` +
`libluacompat53.a` + `libnvim-wasi-shim.a`. Build target is `nvim_bin`
only (never `nvim`/`all` — runtime/doc targets want to RUN the binary).

**Discoveries / surprises:**

- **Cross-codegen is a supported upstream path.** With
  `CMAKE_CROSSCOMPILING` + `NLUA0_HOST_PRG`, src/nvim/CMakeLists.txt runs
  all generators as `host-lua preload_nlua.lua <src> <nlua0.so> <bin>`.
  We assemble nlua0.so ourselves from nvim's own sources
  (nlua0.c + mpack/*.c + bit.c) + pinned lpeg, as a macOS bundle with
  `-undefined dynamic_lookup` (host lua exports the Lua API); an EMPTY
  `auto/config.h` satisfies lmpack.c's include. `require 'bit'` also
  resolves from the same .so because the literal cpath entry has no `?` —
  Lua's C loader then probes it for `luaopen_bit`.
- **`COMPILE_LUA=OFF` is mandatory, not a nicety:** PUC Lua bytecode
  embeds sizeof(size_t); the 64-bit host lua's `string.dump` output would
  not load in the 32-bit wasm Lua. Runtime modules stay embedded as source.
- **iconv came for free:** v0.12 requires iconv unconditionally (no
  HAVE_ICONV gate), but wasi-libc ships musl's real built-in iconv
  (UTF-8/UTF-16/latin1 &co) in libc.a — `ICONV_INCLUDE_DIR` points at the
  wasi sysroot and no stub was needed.
- **wasm-ld's default `--gc-sections` had been masking dead undefined
  refs:** rung 3's link-all gate passed while `tcp.o` referenced
  `getifaddrs` because nothing live reached it; nvim's channel.c makes
  uv_tcp_connect live and surfaced it. Same for Lua's `os.execute` →
  `system`. Lesson recorded: a link-all TU only proves symbols it makes
  REACHABLE.
- **Link-order gotcha:** libs in `CMAKE_EXE_LINKER_FLAGS(_INIT)` land
  BEFORE the object files on the link line, so wasm-ld (strict
  left-to-right archive scan) contributes nothing from them — the
  emulated/setjmp/shim archives had to go in `CMAKE_C_STANDARD_LIBRARIES`
  (appended at the END). The toolchain file's `_INIT` copies are inert for
  executables but kept for compatibility.
- **TUI compiles wholesale.** v0.12 has no TUI_ENABLE switch; tui/, vterm/
  and tui/termkey/ all compiled cleanly against the shim termios/ioctl
  headers and are linked in (inert until something starts the TUI, which
  would die on uv_thread_create ENOSYS — the wasm build must stay
  `--embed`-headless, as planned).
- cmake.config hardcodes `HAVE_FORKPTY=1` on non-SunOS — irrelevant since
  our forkpty stub exists either way. `HAVE_DIRFD_AND_FLOCK` and
  `HAVE_PWD_FUNCS` came out 0 (flock/getpwent unresolvable at
  check-link time), which conveniently compiles out two more POSIX paths.
- ccache was picked up automatically by nvim's own Deps.cmake logic and
  transparently cached the wasi clang invocations.
- libuv.a was rebuilt twice during this rung (new stubs); `test/uv-smoke.sh`
  re-ran green after each rebuild.

**Open risks / carry-forwards for rung 5:**

- **channel.c embedded-mode stdio redirect is the #1 rung-5 risk:** on
  `--embed`, nvim dups stdin/stdout away via `fcntl(F_DUPFD_CLOEXEC)`
  (wasi-libc fcntl → EINVAL, returns -1) and `dup2(STDERR→stdin/stdout)`
  (our stub → ENOSYS). The RPC channel would then be initialized with
  fd -1. Likely fix: implement real F_DUPFD/dup2 semantics in a shim
  (uvwasi honors `fd_renumber`; renumbering to a FRESH fd needs care) or a
  tiny `__wasi__` guard in channel.c skipping the redirect (first actual
  nvim patch, if so).
- `uv_exepath` ENOSYS → `v:progpath` empty; runtime files (`$VIMRUNTIME`)
  must come via preopens + env under the wasm host.
- **Tree-sitter parser archives are built but NOT linked.** Upstream loads
  parsers via dlopen at runtime (no static-parser mechanism exists in
  nvim's CMake). nvim boots without them; wiring
  `libtree-sitter-{c,lua,vim,vimdoc,query,markdown}.a` in (symbol
  registration + `--whole-archive`-style linking or a small patch) is a
  rung-6+ task if `vim.treesitter` is needed in the prototype.
- Binary is pre-asyncify: 5,983,467 bytes at `-O3`; expect growth from
  asyncify (rung 5+ decision) and shrink from wasm-opt.
- The `-mllvm -wasm-enable-sjlj` flag is compile-time codegen only; the
  LINK line warns "argument unused" (harmless). `-lsetjmp` supplies
  `__wasm_setjmp`/`__wasm_longjmp`; Node 24's V8 compiles and instantiates
  the EH instructions fine (proven by the gate + the --version run).
  Whether the sjlj paths *behave* under load is first exercised when real
  Lua/pcall traffic runs — rung 5+.

### 2026-07-15 — Task 7: rungs 5–8 — SMOKE PASS (definition of done)

**Gate green:** `bash scripts/smoke.sh` (wraps the PARENT repo's real
`scripts/smoke-nvim.mjs` with `NVIM_WASM_PATH`/`NVIM_RUNTIME_PATH` pointing
at our `dist/` artifacts) prints **SMOKE PASS**: boots, `nvim_ui_attach` →
null (success), `ihello` → buffer `["hello"]`, idle-wakeups assertion
passes, post-idle `oworld` → `["hello","world"]`. All four rungs cleared
on the FIRST full smoke run — the rung-4 risk list turned out to be the
complete list of real blockers, and all were fixed before first boot.

**Metrics (vs vendored engine):**

| metric | ours | vendored |
| --- | --- | --- |
| asyncified wasm | 8,040,769 B | 8,386,869 B (ours 4.1% smaller) |
| pre-asyncify link | 5,983,520 B (-O3, was 5,983,467 before the asyncify-scratch exports) | n/a |
| runtime tarball | 5,742,514 B (2,186 entries, full runtime/ tree) | 5,613,852 B |
| boot ("loaded wasm" → "nvim booted") | not instrumented — `smoke-nvim.mjs` logs no timestamp on either line; both engines feel sub-second in manual testing but there is no logged number to report | not instrumented |
| idle wake-ups | 2 over 10 s = **0.20/s**; final 5s stat sample **0.00/s** (gate ≤5/s) | ~1/s (needs the host's adaptive backoff) |
| post-idle input latency | 2–15 ms per `nvim_input` round-trip | ~ms (comparable) |
| total wake-ups boot→post-edit→idle | 6 | — |

**The idle number is the designed-in rung-3 result confirmed:** our libuv
poll core subscribes `fd_read` on stdin, so idle nvim parks in
`poll_oneoff` on an fd subscription with NO repeating clock churn — the
parent host's `waitFor` sees `hasFdSub` and never even engages its
adaptive backoff (that backoff exists solely because the vendored build
busy-polls stdin with ~1ms clock-only subscriptions). Genuinely
event-driven idle: 0 wakeups in the final 5-second window.

**What each rung needed:**

- **Rung 5 blocker #1 (predicted): parent host asyncify-scratch discovery.**
  The task brief said the host falls back to `memory.grow`; reading
  `src/engine/nvim-host.ts` (ours, allowed) showed otherwise — it
  *unconditionally* calls `nvim_asyncify_get_data_ptr()` /
  `_get_stack_start()` / `_get_stack_end()` at boot. New
  `shims/nvim-wasi-asyncify.c`: 8-byte [current,end] descriptor + 4 MiB
  .bss unwind stack, three `__attribute__((export_name))` getters. Linked
  as a BARE OBJECT via `CMAKE_C_STANDARD_LIBRARIES` (an archive member
  nothing references would be silently dropped and the exports would
  vanish).
- **Rung 5/6 blocker #2 (predicted, THE rung-4 carry-forward): channel.c
  --embed stdio redirect.** `fcntl(F_DUPFD_CLOEXEC)` has no WASI
  implementation (preview1 `fd_renumber` MOVES, nothing dups), so the RPC
  channel got fd −1. Fix: **the port's first genuine Neovim patch**,
  `patches/neovim-embed-stdio.patch` — a new `#elif defined(__wasi__)`
  branch in `channel_from_stdio()` that keeps fds 0/1 directly, because
  preview1 has no fd-duplication primitive at all — the redirect cannot be
  implemented, so this is the only option, not a judgment call. **This is
  NOT a free lunch, and the patch header previously overclaimed that it
  was:** of the redirect's two upstream purposes, hiding RPC fds from child
  processes is genuinely moot (preview1 has none), but shielding the RPC
  stream from stray stdout writers is NOT moot — it was empirically
  disproved. A user Lua `io.write()` call writes straight to fd 1; 3 bytes
  of `io.write()` output permanently desynced the msgpack-RPC framing and
  killed the RPC session in testing. The gap is acceptable for the current
  gate only because it runs `nvim -u NORC --noplugin` (no user Lua ever
  executes). See the open-items list below — this must be closed (a
  Lua-level redirect of `io.write`/`io.stdout` to stderr or a host sink)
  before any milestone that runs user configs. Honest-shim alternatives to
  the patch itself were examined and rejected: faking dup would require
  intercepting every subsequent fd op at the libc boundary. Applied by a
  new idempotent `patch` step in build-nvim.sh (grep-guarded, in-place on
  src-cache/neovim).
- **Rung 5 asyncify itself:** `scripts/asyncify.sh` = `wasm-opt -O2
  --asyncify --pass-arg=asyncify-imports@wasi_snapshot_preview1.poll_oneoff`
  (flags verified against binaryen-130 `--help`). **The feared
  sjlj/EH-vs-asyncify wall never materialized:** binaryen 130 read the
  module's own target_features section (exception handling included),
  instrumented, and finished in ~6 s wall / 42 s CPU with no explicit
  `--enable-*` flags. Gate: `test/check-asyncify.mjs` asserts the full
  export surface the host dereferences (asyncify ABI ×5 + scratch helpers
  ×3 + _start + memory).
- **Rungs 6–8 runtime packaging:** `scripts/package-runtime.sh` tars the
  pinned source `runtime/` tree (26 MB, no symlinks, nothing build-time
  generated is needed for the embedded RPC path). Layout verified against
  the parent's OWN code: nvim-host.ts mounts tarball entries at the "/"
  preopen and sets `VIMRUNTIME=/runtime` (NOT `/nvim/runtime` as the task
  brief claimed) → tarball has one top-level `runtime/` dir. Parent's
  untar.ts skips pax/GNU-longname records, so `tar --format=ustar` (plain
  ustar; errors loudly if a path can't be represented) +
  `COPYFILE_DISABLE=1` (no macOS AppleDouble entries) + `.DS_Store`
  excluded; verify step asserts every entry starts with `runtime/`.
- **build-nvim.sh staleness fixes (iteration ergonomics):** configure now
  re-runs when build-nvim.sh itself is newer than build.ninja; build now
  force-relinks when any build/deps/lib archive/object is newer than
  bin/nvim (ninja doesn't track CMAKE_C_STANDARD_LIBRARIES inputs), then
  always runs ninja (no-op when clean). Closes the rung-4 "stale-binary
  skip if shims edited" carry-forward.

**Incidental discoveries:**

- The host presents stdio as FILETYPE_CHARACTER_DEVICE with
  FDFLAGS_NONBLOCK already set and read-only/write-only rights, so
  wasi-libc `isatty(0)` is true → nvim's `stream_init` takes the
  `uv_pipe_open` path (non-MSWIN treats UV_TTY the same as pipe) and
  upstream `uv__nonblock_fcntl` sees O_NONBLOCK already set — no
  `fd_fdstat_set_flags` support needed from the host shim.
- asyncify growth: 5,983,520 → 8,040,769 B (+34%), still under the
  vendored binary. `-O2` (before --asyncify, per command-line pass order)
  is doing real work here.
- The smoke harness runs the engine over `@bjorn3/browser_wasi_shim`, not
  `node:wasi` — rungs 1–4 proved the binary under uvwasi, rung 5+ under
  the browser shim; both substrates now boot the same module.

**Still open (rung 9 / stretch, unchanged):** tree-sitter parser archives
built but not linked (upstream dlopens; `vim.treesitter` parsers absent);
`uv_exepath` ENOSYS → `v:progpath` empty (harmless for the smoke path);
browser/overlay smokes against our binary not yet run.

- **KNOWN LIMITATION — user Lua `io.write()`/`io.stdout` corrupts the RPC
  stream.** `patches/neovim-embed-stdio.patch` keeps fds 0/1 as the RPC
  channel endpoints because preview1 has no fd-duplication primitive to do
  otherwise. Acceptable for the current gate (`nvim -u NORC --noplugin`,
  no user Lua runs), but a real gap, not a moot one: a user `io.write()`
  call writes directly to fd 1 and permanently desyncs msgpack-RPC framing
  (empirically verified — 3 bytes of `io.write()` output killed the RPC
  session). Must be fixed — a Lua-level redirect of `io.write`/`io.stdout`
  (and `print`) to stderr or a host-provided sink — before any milestone
  that runs user configs.
- The asyncify unwind stack is a fixed 4 MiB `.bss` buffer with no overflow
  assertion compiled in (binaryen's `asyncify-asserts` pass-arg exists if
  overflow is ever suspected; deepest observed unwind chains are far below
  4 MiB, but nothing currently catches an overrun).
- The packaged runtime tarball is unpruned: it ships the full source
  `runtime/` tree (docs, tutor, etc.), ~2.3% larger than the vendored
  engine's tarball. Pruning unused subtrees is an easy size win for later.

### 2026-07-15 — Parity Task 1: parity gate harness + synthetic uv_exepath

**Gate green:** `node test/parity-check.mjs dist/nvim-asyncify.wasm
dist/nvim-runtime.tar.gz` prints `PASS progpath: v:progpath =
"/nvim/bin/nvim"` then **PARITY PASS** (exit 0). `bash scripts/smoke.sh`
still **SMOKE PASS**; `bash test/uv-smoke.sh` still green (link-all +
case A/B).

**New harness — `test/parity-check.mjs`** (added to the test inventory):
a STANDALONE parity gate that boots our `--embed` nvim under the same WASI +
Asyncify arrangement as the parent host and drives it over msgpack-RPC to
assert observable behaviours a native nvim exhibits. Usage:
`node test/parity-check.mjs <wasm> <runtime-tarball>`; prints a PASS/FAIL
line per check plus `PARITY PASS`/`PARITY FAIL`; exits nonzero on any
failure. Checks live in a `CHECKS = [{ name, fn(rpc) }]` array so later
parity tasks append entries; the runner runs whatever checks exist. It
imports NOTHING from the parent `src/engine/*` — it re-implements inline the
small pieces it needs (the poll_oneoff Asyncify driver, a ustar reader, and
msgpack-RPC framing), mirroring the parent's boot pattern per the clean-room
standalone constraint. Its only third-party imports are
`@bjorn3/browser_wasi_shim` and `@msgpack/msgpack`, both resolved from the
parent repo's `node_modules` via normal upward module resolution (works from
any cwd).

**Check 1 — `progpath`:** asserts `nvim_eval("v:progpath")` is a non-empty
ABSOLUTE path ending in `nvim`.

- **Failing-first observed value was NOT the empty string the brief
  predicted — it was the bare `"nvim"`.** With `uv_exepath` returning
  ENOSYS, neovim's `init_path()` (`main.c`) falls back to
  `path_guess_exepath()` (`path.c`), which — because the sandbox has no
  `$PATH` env — copies `argv[0]` ("nvim") verbatim. So a mere "non-empty,
  ends-in-nvim" check would have passed against the bug. The check therefore
  additionally requires an **absolute** path, which is the real parity
  property (a native nvim exposes the absolute exe path) and the whole point
  of a synthetic exepath. Pre-fix: `FAIL progpath: v:progpath is not an
  absolute path: "nvim"` (exit 1). Post-fix: `PASS ... "/nvim/bin/nvim"`.

**Fix — `uv_exepath` in `shims/uv-wasi-platform.c`:** was
`if (bad args) UV_EINVAL; else UV_ENOSYS;`. Now returns a **stable synthetic
path `"/nvim/bin/nvim"`**, honoring libuv's contract (`*size` in/out: in =
buffer capacity, out = bytes written excluding NUL; NUL-terminates; copies
only what fits leaving room for the NUL; `UV_EINVAL` on NULL buffer/size or
zero capacity). The path is chosen to be consistent with the host's `/nvim`
preopen convention; it need not name a real file — nvim only needs an
absolute, nvim-tailed string for `v:progpath`/`v:progname`. The file's WHY
header comment was updated to document the choice and drop exepath from the
ENOSYS list. **This closes the rung-4/5 carry-forward "`uv_exepath` ENOSYS →
`v:progpath` empty".**

**Rebuild mechanics:** `uv_exepath` lives in a libuv shim compiled into
`libuv.a` by `build-deps.sh`, whose `build_libuv()` skips when `libuv.a`
already exists (no shim-change detection). So the rebuild path is: delete
`build/deps/lib/libuv.a` → `bash scripts/build-deps.sh libuv` (re-applies
`libuv-wasi.patch` idempotently on a fresh extract) → `bash
scripts/build-nvim.sh` (force-relinks because the archive is newer than
`bin/nvim`; ninja compile is otherwise a no-op) → `bash scripts/asyncify.sh`.
Relinked `bin/nvim` = 5,983,592 B; asyncified `dist/nvim-asyncify.wasm` =
8,040,838 B.

**Still open (unchanged):** the user-Lua `io.write` RPC-corruption known
limitation above; tree-sitter parser archives built but not linked;
browser/overlay smokes not yet run.

### 2026-07-15 — Parity Task 2: user Lua io.write()/io.stdout diverted off the RPC fd

**Mechanism decision (investigated BEFORE coding, per the task brief):**

Two candidate mechanisms, in the brief's preference order:

- **(a) C stdio retarget — REJECTED as unviable.** The idea: RPC writes go
  to fd 1 as *raw uv fd writes* (`uv__io_poll`/`uv_write` on a `uv_pipe`
  wrapping fd 1) while Lua's `io` library writes through C stdio
  `FILE *stdout` — so retargeting the `FILE` to fd 2 early in embedded
  startup would divert every C-stdio stdout writer (Lua io included)
  without touching the RPC path. Investigation against the pinned
  wasi-sdk-33 sysroot killed every variant:
  - `stdout = stderr;` — impossible: wasi-libc's `stdio.h` declares
    `extern FILE *const stdout;` (const *pointer*; reassignment is a
    compile error).
  - Poking the FILE's internal fd field — impossible without internal
    headers: on WASI, `FILE` is deliberately an **incomplete type**
    (the sysroot `stdio.h` only defines `struct _IO_FILE` under
    `__wasilibc_unmodified_upstream`, which is never set for consumers),
    and musl's internal `stdio_impl.h` is **not shipped anywhere** in the
    SDK (verified: `find .toolchain/wasi-sdk -name stdio_impl.h` → no
    matches). Replicating musl's private FILE layout in our own code
    would couple us to an unversioned internal ABI — rejected as fragile.
  - `freopen(path, "w", stdout)` — needs a *path*; the sandbox has no
    `/dev/stderr`/`/dev/fd/2`, so the best it could do is divert stdout
    into a preopen *file* nobody watches, not stderr.
  - `fd_renumber` tricks — a non-starter: preview1 `fd_renumber` MOVES an
    fd (would tear down the RPC channel's fd 1), it cannot alias one.
- **(b) Lua-level redirect at init — CHOSEN.** New minimal patch
  `patches/neovim-lua-stdio.patch`: in `nlua_init()`
  (`src/nvim/lua/executor.c`), immediately after `luaL_openlibs()`, run
  (under `#ifdef __wasi__`) the chunk
  `io.output(io.stderr) io.stdout = io.stderr`, and `os_exit(1)` loudly if
  that chunk somehow fails. Why this exact chunk (verified against pinned
  Lua 5.1.5 `liolib.c`):
  - `io.write` is `g_write(L, getiofile(L, IO_OUTPUT))` — it writes to the
    **default output**, not to the `io.stdout` field; `io.output(io.stderr)`
    is the documented API for retargeting the default output, so it fixes
    `io.write(...)` outright.
  - `io.stdout = io.stderr` additionally catches explicit
    `io.stdout:write(...)` (the field is just a table slot).
  - The brief's suggested extra `io.write = function(...) return
    io.stderr:write(...) end` wrapper was deliberately **dropped**: it
    would pin `io.write` to stderr forever, silently breaking the
    legitimate pattern `io.output(somefile); io.write(...)` that plugins
    use to write files. With the default output already retargeted, the
    wrapper adds no protection (the only stdout-reaching route left would
    be the real stdout FILE handle, which is no longer reachable from user
    Lua: `io.stdout` now names stderr and WASI has no `/dev/stdout` to
    reopen).
  - Injection point rationale: `nlua_init()` is the constructor of the
    single embedded main-thread Lua state, and `luaL_openlibs()` is where
    the `io` table is born — no user Lua (or runtime Lua) can run before
    this point. Thread states (`nlua_init_state`) are unreachable under
    WASI (`uv_thread_create` = ENOSYS), and `nvim -l` script states are
    not the embedded RPC path, so patching `nlua_init` alone is both
    sufficient and minimal.
  - `print()` needs no fix: nvim replaces the global `print` with
    `nlua_print` (routes through the message system, never fd 1) —
    verified in `executor.c` and covered by the new `print_safe` baseline
    parity check.

**Failing-first evidence (checks added BEFORE the fix, run against the
then-current dist):** two new checks appended to `test/parity-check.mjs`
(which also grew a `ctx` second argument for checks: a per-request timeout
helper + captured-stderr access, and the runner now records nvim's stderr):

- `print_safe` (baseline): `nvim_exec_lua("print('x') return 2")` then
  `nvim_eval("2+2")`, each under a 2 s timeout — **PASSed pre-fix**, as
  predicted (print never touches fd 1).
- `io_write_safe`: `nvim_exec_lua("io.write(string.char(0xdc,0x00,0x10))
  return 1")` (the exact 3-byte sequence proven fatal in Task 7 — a bare
  msgpack array16 header) then `nvim_eval("1+1")` under a 2 s timeout.
  Pre-fix: `FAIL io_write_safe: RPC stream dead after 3 bytes of
  io.write(): timeout after 2000ms waiting for nvim_eval("1+1") after
  io.write` → `PARITY FAIL` exit 1, with the harness reporting the timeout
  gracefully instead of hanging. The check is deliberately LAST in the
  CHECKS array: against an unfixed build it kills the RPC session, so
  anything after it would fail spuriously. It also asserts (post-fix) that
  the three junk bytes actually LANDED on stderr — diverted, not
  swallowed — and it fires the exec_lua without awaiting it first, since on
  an unfixed build even that response is eaten by the desynced framing.

**Post-fix result:** `patches/neovim-lua-stdio.patch` applied by a new
per-patch guard loop in `build-nvim.sh` (`apply_one_patch`, grep-guarded
and idempotent like before); rebuild + `asyncify.sh` → relinked `bin/nvim`
5,983,839 B, `dist/nvim-asyncify.wasm` 8,041,186 B. Parity run: all three
checks PASS (`io.write junk diverted to stderr; RPC intact (exec_lua -> 1,
eval 1+1 -> 2)`; the 0xdc 0x00 0x10 bytes visibly arrive on the stderr
capture) → **PARITY PASS**. Full regression: `bash scripts/smoke.sh` →
**SMOKE PASS** (idle wake-ups 0.00/s, post-idle edit OK); `bash
test/uv-smoke.sh` → link-all + case A/B green. Docs updated:
`neovim-embed-stdio.patch` header (limitation → resolved, pointing at the
companion patch) plus the in-tree channel.c comment re-synced, README patch
inventory + engine-swap paragraph (io.write gap closed, progpath gap from
Parity Task 1 also reflected). **This closes the Task-7 "KNOWN LIMITATION —
user Lua io.write()/io.stdout corrupts the RPC stream" open item.** The
remaining theoretical hole — a non-Lua C-level stdout writer inside nvim —
is documented in the patch header; nothing in the embedded headless path
writes to C stdout.

**Still open (unchanged):** tree-sitter parser archives built but not
linked; browser/overlay smokes not yet run.

### 2026-07-15 — Parity Task 3: statically linked tree-sitter parsers

**Step-1 investigation (v0.12.4 parser-loading path, documented before
coding):**

- **Lua side (`runtime/lua/vim/treesitter/language.lua`):**
  `vim.treesitter.language.add(lang)` first calls
  `vim._ts_has_language(lang)` and returns `true` immediately if the
  language is already registered — BEFORE any runtime-path lookup. Only on
  a miss does it call `api.nvim_get_runtime_file('parser/<lang>.*')` (and
  returns `nil, 'No parser for language …'` if no file exists) and then
  `vim._ts_add_language_from_object(path, lang, symbol)`. Note `add`
  reports "no parser" as a `nil` RETURN, not an error — a bare
  `pcall(add, lang)` returns `true, nil` on a missing parser, so parity
  checks must assert the returned value, not just pcall success.
- **C side (`src/nvim/lua/treesitter.c`):** all registered languages live
  in a file-static process-global map `static PMap(cstr_t) langs`;
  `vim._ts_has_language` is `map_has` on it. `add_language()` (behind
  `_ts_add_language_from_object`) resolves parsers exclusively via
  `uv_dlopen(path)` + `uv_dlsym("tree_sitter_<symbol>")`
  (`load_language_from_object`), ABI-checks the result
  (`TREE_SITTER_MIN_COMPATIBLE_LANGUAGE_VERSION` ..
  `TREE_SITTER_LANGUAGE_VERSION`), then `pmap_put`s it. Under WASI
  `uv_dlopen` can never succeed (no dynamic loading exists).
- **No static-registration hook exists in v0.12.4** (verified, per the
  brief's instruction to check before shimming): the only other load path
  is `HAVE_WASMTIME`'s `_ts_add_language_from_wasm`, which READS A .wasm
  FILE from disk into wasmtime (`ts_wasm_store_load_language`) — it is
  file/path-based too, is OFF in our build (`ENABLE_WASMTIME` defaults
  off; wasmtime was never fetched), and registers a *wasm-store* language,
  not a native `TSLanguage*`. There is no API anywhere that accepts an
  in-process `TSLanguage*` (no lightuserdata entry point), so the "pure
  shim, no patch" shape is impossible: the `langs` map is file-static and
  only reachable through dlopen-shaped code.
- **Mechanism chosen (smallest honest patch):** pre-register all 7
  statically linked grammars into the `langs` map at `tslua_init()` time
  under `#ifdef __wasi__`, from a table exported by a new shim TU
  (`shims/nvim-wasi-treesitter.c`) that references all 7
  `tree_sitter_*()` constructors (which also forces wasm-ld to extract
  the parser archive members at link time — no whole-archive tricks
  needed). With the map pre-populated, `language.add('<lang>')` hits the
  `_ts_has_language` fast path and returns `true` without ever consulting
  the runtime path or dlopen — zero runtime-Lua modification, exactly the
  upstream fast path. The patch mirrors `add_language()`'s ABI-range
  check (skip + loud stderr line on mismatch, which parity would then
  catch as a missing grammar). Registration cost is 7 map inserts at Lua
  state init; parser constructors just return pointers to static tables —
  no timers, no fds, idle gate unaffected.
- Baseline sizes before the change: `build/nvim/bin/nvim` = 5,983,839 B;
  `dist/nvim-asyncify.wasm` = 8,041,186 B.

**Failing-first surprise — a SECOND, unplanned blocker found by the new
check:** the failing-first run did not fail with the predicted `no-c`; it
failed with `module 'vim.treesitter' not found`. Probe-driven diagnosis
(temporary harness fork, since deleted):

- `require('vim.treesitter')` fails even though the tarball ships
  `runtime/lua/vim/treesitter.lua`, `&rtp` contains `/runtime`,
  `nvim_get_runtime_file('lua/vim/treesitter.lua')` FINDS the file,
  `loadfile('/runtime/lua/vim/treesitter.lua')` works, and
  `vim._load_package` IS installed at `package.loaders[2]`.
- The break is one level down: `vim._load_package` uses
  `vim.api.nvim__get_runtime(paths, false, {is_lua=true})`
  (`runtime/lua/vim/_init_packages.lua`), and `runtime_get_named_common()`
  (`src/nvim/runtime.c`) accepts a hit only if `os_file_is_readable()` —
  libuv `uv_fs_access(..., R_OK)` — succeeds. `vim.fn.filereadable()` of
  the same path returned 0: **`access(R_OK)` always fails under
  `@bjorn3/browser_wasi_shim`.** (`nvim_get_runtime_file` takes the
  glob/scandir path instead, which never calls `access` — that's why it
  disagreed.)
- Root cause, empirically confirmed with a 20-line wasm C probe run under
  the same shim arrangement: the shim's `OpenDirectory.fd_fdstat_get()`
  reports `fs_rights_base = fs_rights_inheriting = 0`, and wasi-libc's
  `faccessat()` implements `access(amode != F_OK)` as a check of the
  requested rights against the directory fd's `fs_rights_inheriting` →
  0 rights means every `R_OK`/`W_OK`/`X_OK` probe fails `EACCES`
  ("Permission denied"), while `stat()` and `F_OK` succeed. The parent
  host (`src/engine/nvim-host.ts`) uses the same stock `PreopenDirectory`,
  so this affects the real engine-swap environment, not just the parity
  harness; Node's uvwasi (rungs 1–4) reports full rights, which is why no
  earlier rung ever tripped it. The smoke path never requires runtime Lua
  modules, which is why rung 8 passed.
- Consequence: EVERY runtime-Lua `require` (vim.treesitter, vim.fs users,
  anything not embedded in the binary) was broken under the browser-shim
  host — a parity gap much wider than tree-sitter; the new check just
  happened to be the first to require a runtime module.
- Fix (shim-side, not harness-side, so the binary is robust under any
  rights-agnostic host and the parity harness keeps mirroring the parent
  host faithfully): a stat-based `access()` replacement — existence via
  `stat()` grants `F_OK`/`R_OK`/`W_OK` (preview1 filestat carries no
  permission bits; actual open can still fail honestly), `X_OK` granted
  for directories only (nothing is executable under WASI — keeps
  `os_can_exe()` honest).
  - **First attempt FAILED, recorded per append-mostly convention:**
    defining a strong `access` symbol in `wasi-libc-missing.c` to shadow
    wasi-libc's, on the theory that libc's member would never be
    extracted. The rung-3 link-all gate (`test/uv-linkall.c`) immediately
    caught it: wasi-libc defines `access` in its MONOLITHIC
    `posix.c.obj`, which the link extracts anyway for other symbols →
    guaranteed duplicate-symbol error. (That gate earning its keep,
    second time.)
  - Landed shape: the function is named `uv__wasi_access_shim`
    (`shims/wasi-libc-missing.c`), and `shims/uv-wasi-fixups.h`
    (force-included into every libuv TU) `#define`s `access` to it —
    compile-time routing of both `access()` call sites in the link: libuv
    fs.c's `uv_fs_access` and unix/core.c's `uv__search_path` (verified —
    `uv__search_path` also calls `access(X_OK)`; no direct calls in Neovim
    or PUC Lua sources). Both call sites are libuv TUs compiled with the
    same fixups header, so this is compile-time routing, not two separate
    fixes — no behavior change. No symbol conflict is possible.

**Failing-first evidence:** new `treesitter` parity check appended to
`test/parity-check.mjs` (placed BEFORE `io_write_safe`, which must stay
last): asserts all 7 grammars register (`pcall(language.add, lang)` AND
truthy return AND `vim._ts_has_language(lang)` — the return-value check
matters, see above) and that
`get_string_parser('int x;','c'):parse()[1]:root():type()` is
`translation_unit` (a real parse, not just registration). Against the
pre-fix dist: `FAIL treesitter: ... module 'vim.treesitter' not found` →
`PARITY FAIL` exit 1 (the access() gap masked the predicted `no-c`
failure mode — the check never got as far as language.add).

**Implementation (rest of the mechanism, as chosen in Step 1):**

- `shims/nvim-wasi-treesitter.c` (new): `{name, constructor}` table of all
  7 grammars, referencing the 7 `tree_sitter_*()` symbols — this is what
  forces wasm-ld to extract the parser archive members (no whole-archive
  needed; treesitter.c references the table, the table references the
  parsers). Compiled into `libnvim-wasi-shim.a` (safe as an archive
  member — unlike the asyncify object, it IS referenced).
- `patches/neovim-ts-static.patch` (nvim patch #3): `__wasi__`-guarded
  hunk in `tslua_init()` walking the table into the `langs` map, with
  `add_language()`'s ABI-range validation (skip + loud stderr on
  mismatch) and a `map_has` guard for idempotent re-init.
- `scripts/build-nvim.sh`: applies the patch (same grep-guarded
  `apply_one_patch` flow), compiles the new shim TU into the shim
  archive, and appends the 6 parser archives to
  `CMAKE_C_STANDARD_LIBRARIES` AFTER `libnvim-wasi-shim.a` (wasm-ld
  scans archives left-to-right; the registry member's references are
  what pull the parsers in).

**Gate results (all green):**

- `node test/parity-check.mjs dist/...` → 4/4 checks:
  `PASS treesitter: all 7 grammars registered; get_string_parser('int
  x;','c') parsed (root: translation_unit)` → **PARITY PASS**; the three
  prior checks stayed green.
- `bash scripts/smoke.sh` → **SMOKE PASS**; idle gate holds (2 wake-ups
  over 10 s, final 5 s sample 0.00/s ≤ 5/s) — parser registration adds
  no timers/fds, as designed.
- `bash test/uv-smoke.sh` → link-all + case A/B green (this gate is also
  what caught the failed access()-override attempt above).

**Size delta (parsers + access shim):**

| artifact | before | after | delta |
| --- | --- | --- | --- |
| `build/nvim/bin/nvim` (pre-asyncify) | 5,983,839 B | 9,168,111 B | +3,184,272 B (+53%) |
| `dist/nvim-asyncify.wasm` | 8,041,186 B | 10,825,005 B | +2,783,819 B (+35%) |

Above the brief's ~1–2 MB estimate: the 6 archives total ~3.3 MB of wasm
objects (vim 1.5 MB, markdown 877 KB, c 662 KB, vimdoc 276 KB, lua 67 KB,
query 23 KB) and parser tables are pure data — nothing for `-O2`/asyncify
to shrink. The asyncified binary is now ~29% LARGER than the vendored
engine's 8,386,869 B (it was 4.1% smaller before this task) — the honest
cost of embedding 7 grammars. **This closes the "tree-sitter parser
archives built but not linked" open item.**

**Still open:**

- Browser/overlay smokes against our binary not yet run (rung-9 stretch).
- Future TUs calling `access()` directly (outside libuv's fixups-header
  coverage) silently get wasi-libc's broken rights-based `access()` — the
  fix is scoped to libuv TUs via `shims/uv-wasi-fixups.h`'s force-include,
  not a link-wide symbol override (a genuine link-wide override is
  impossible — see the header's own comment on the duplicate-symbol
  failure this would cause).
- Tree-sitter grammars are always-linked (+2.8MB asyncified, binary now
  +29% vs vendored); make them build-time opt-in if size matters.
