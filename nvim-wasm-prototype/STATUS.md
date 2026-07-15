# STATUS

Living findings log for the nvim-wasm-prototype clean-room build. Append-mostly:
failed experiments get recorded, not erased.

## Validation ladder

- [x] 1. Toolchain fetch + hello-world C compiles to wasm32-wasi and runs in Node.
- [x] 2. Leaf deps compile (utf8proc, treesitter, lua 5.1, …). Host lua/luac built.
- [x] 3. libuv compiles against our shim layer (links, symbols resolved).
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
