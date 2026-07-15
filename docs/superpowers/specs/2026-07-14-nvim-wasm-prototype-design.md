# nvim-wasm-prototype — Design Spec

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Parent project:** nvim-in-browser (see 2026-07-14-nvim-in-browser-design.md)

## Overview

A self-contained subproject at `nvim-wasm-prototype/` that attempts a
**from-scratch, strict clean-room build of Neovim to WebAssembly** — no code,
patches, build scripts, or knowledge derived from the MuNeNICK/nvim-wasm
project. Success = our binary passes the parent project's existing smoke
harness (`scripts/smoke-nvim.mjs`): boots under our engine host, answers
msgpack-RPC, performs a buffer edit, and meets the idle-wakeups gate.

Purpose: (1) exploration/learning; (2) if it succeeds, an unambiguously
Apache-2.0-clean engine binary that can replace the vendored one, dissolving
the upstream licensing problem; (3) findings that could feed Neovim's official
WASM effort (tracking issue neovim/neovim#35567, GSoC 2026).

## Hard constraints

- **Strict clean-room:** never read, fetch, or consult MuNeNICK/nvim-wasm or
  monaco-neovim-wasm code, patches, Makefiles, or docs. Allowed references
  (whitelist): neovim/neovim source + docs, wasi-libc/wasi-sdk, Binaryen,
  libuv upstream, WASI preview1 spec, Emscripten docs, general web references
  that are not the excluded projects. Already-known **interface facts** are
  usable (public API/ABI knowledge in the parent spec: nvim argv, Asyncify
  ABI export names, WASI preview1 struct layouts) — facts, not expression.
  Executing agents receive this exclusion list verbatim.
- **Success bar (user-set): iterate until it boots** — the loop continues
  until `smoke-nvim.mjs` passes against our binary, or a blocker requires a
  user decision (e.g. pivot to Emscripten, upstream patch needed). No silent
  downgrade to "best effort."
- **Toolchains:** project-local under gitignored `nvim-wasm-prototype/.toolchain/`
  (wasi-sdk, binaryen — pinned versions, SHA-checked downloads); cmake/ninja
  via Homebrew if absent. Nothing else global.
- **Everything ours is Apache-2.0-compatible:** shims and patches carry our
  copyright; patches apply to Apache-2.0 Neovim/deps, which is legal and
  clean.

## Approach (selected: wasi-sdk + our libuv shim + Binaryen Asyncify)

Compile Neovim and its dependency stack with wasi-sdk (clang, wasm32-wasi
target), then post-process with `wasm-opt --asyncify` (asyncified import:
`wasi_snapshot_preview1.poll_oneoff`) so the binary suspends instead of
blocking. Target ABI is identical to the vendored binary: WASI preview1
imports, `_start`, standard Asyncify exports — so the parent repo's engine
host and smoke harness validate it **unchanged** (host's asyncify scratch
region: use its documented fallback or export equivalently named helpers from
our own code).

**Pivot clause:** if wasi-libc gaps prove fatal (candidate risks: setjmp/
longjmp support, missing POSIX surface too large to stub), the documented
fallback is Emscripten (`-sASYNCIFY`), accepting a new host-glue layer. This
pivot is a STATUS.md decision point surfaced to the user, not made silently.

### Known dragons (attack in this order)

1. **libuv has no WASI port.** Neovim's event loop is libuv; libuv's Unix
   core needs epoll/kqueue, pthreads, signals, fork — absent in WASI. Ours to
   solve with a clean-room shim layer (`shims/`): compile the portable parts
   of libuv where possible; replace the polling core with a
   `poll_oneoff`-backed single-threaded implementation; stub threads (nvim
   main loop only), signals, process spawning (fail cleanly), PTY. Cover only
   the libuv API surface Neovim exercises — discovered empirically from
   linker errors and runtime behavior.
2. **LuaJIT does not target wasm.** Build against PUC Lua 5.1 instead.
   Checkpoint early whether current Neovim still builds against PUC Lua
   (historical `PREFER_LUA` support); if removed, restoring it is a
   build-system patch on our side.
3. **wasi-libc gaps:** setjmp/longjmp (wasm exception handling in recent
   wasi-sdk), termios/PTY (stub — nvim runs `--embed`, no TUI), locale/iconv
   (disable `ENABLE_LIBICONV`/`LIBINTL` equivalents), mmap oddities.
4. **Neovim's other deps** (libvterm, treesitter, utf8proc, unibilium/termkey
   as versioned by Neovim's own deps manifest): expected to be mostly-portable
   C; treesitter and utf8proc are easy; libvterm may need PTY-adjacent stubs.

## Structure

```
nvim-wasm-prototype/
  README.md            # what this is + clean-room provenance statement
  STATUS.md            # living findings log: ladder progress, blockers,
                       #   decisions, measurements — updated every session
  VERSIONS.md          # single place pinning: neovim release, wasi-sdk,
                       #   binaryen, dep versions, all SHA-pinned
  scripts/
    fetch-toolchain.sh # wasi-sdk + binaryen → .toolchain/ (pinned, SHA-checked)
    fetch-sources.sh   # neovim release tarball + deps → src-cache/
    build-deps.sh      # each dep → build/deps (independent, resumable)
    build-nvim.sh      # cmake configure + build → build/nvim
    asyncify.sh        # wasm-opt pass → dist/nvim-asyncify.wasm
    package-runtime.sh # runtime/ tree → dist/nvim-runtime.tar.gz
    smoke.sh           # runs parent scripts/smoke-nvim.mjs against dist/
  shims/               # our clean-room C (libuv-wasi backend, stubs)
  patches/             # our patches to neovim/deps build systems (ours, minimal)
  .toolchain/ build/ src-cache/ dist/   # all gitignored
```

The prototype never touches parent-project source; the only coupling is
read-only reuse of `scripts/smoke-nvim.mjs` (parameterized by env vars for
wasm/runtime paths — a small, separately reviewed parent tweak if needed).

## Validation ladder (each rung = STATUS.md checkpoint)

1. Toolchain fetch + hello-world C compiles to wasm32-wasi and runs in Node.
2. Leaf deps compile (utf8proc, treesitter, lua 5.1, libvterm, …).
3. libuv compiles against our shim layer (links, symbols resolved).
4. Neovim objects compile; binary links.
5. `_start` reaches first `poll_oneoff` under the parent engine host.
6. `--embed` handshake: answers `nvim_ui_attach`.
7. Buffer edit round-trip via RPC.
8. Full `smoke-nvim.mjs` PASS including idle-wakeups gate. **(Definition of done)**
9. Stretch: overlay/browser smokes against our binary; compare binary size
   and boot time vs vendored.

## Execution shape

Checkpoint loop, not a fixed task list: long-running build/debug agents work
the ladder rung by rung under the clean-room whitelist; the controller
reviews between rungs; STATUS.md is the durable state across sessions and
compactions. Blockers that need user decisions (Emscripten pivot, upstream
patching, giving up a rung) stop the loop and surface.

## Error handling / hygiene

- Every script: strict bash, idempotent/resumable, pinned versions, fails
  loudly with the failing step named.
- Build artifacts never committed (gitignore: `.toolchain/`, `build/`,
  `src-cache/`, `dist/`).
- Root repo changes limited to: `.gitignore` entries, one README pointer
  line, optional env-var parameterization of `smoke-nvim.mjs`.
- STATUS.md is append-mostly; failed experiments get recorded, not erased.

## Testing

The parent smoke harness IS the test (ladder rungs 5–8). Shim C code gets
unit-style validation where cheap (tiny WASI test programs per shim area
before wiring into libuv). No new test framework.

## Risks

- This is genuinely hard; the open-ended success bar means significant time
  and token spend across sessions. Mitigation: ladder checkpoints make
  progress durable and resumable; STATUS.md prevents re-derivation.
- PUC-Lua support may be gone from current Neovim → our patch burden grows.
- The Asyncify pass on an 80MB+ unoptimized binary can be slow/memory-hungry;
  mitigate with `-O2` before asyncify and asyncify-import scoping.
- Clean-room discipline is one careless fetch away from taint — hence the
  whitelist embedded in every agent dispatch and the provenance statement.
