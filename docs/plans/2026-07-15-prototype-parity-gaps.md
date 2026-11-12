# Prototype Parity Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three documented parity gaps blocking an engine swap: user-Lua `io.write()` corrupting the RPC stream, tree-sitter parsers built but not linked, and `uv_exepath` ENOSYS — each proven closed by a new RPC-driven parity gate.

**Architecture:** All work in `nvim-wasm-prototype/` on the established shim/patch machinery. A new `test/parity-check.mjs` (RPC-driven, reusing the run pattern of the parent smoke) becomes the acceptance gate for all three gaps and a permanent regression test alongside `scripts/smoke.sh`.

**Tech Stack:** Existing prototype toolchain (wasi-sdk 33, binaryen 130), C shims, Lua, Node test runner.

## Global Constraints

- **STRICT CLEAN-ROOM (unchanged, binding on every task):** NEVER read, fetch, or consult MuNeNICK/nvim-wasm or MuNeNICK/monaco-neovim-wasm in any form. Allowed references ONLY: neovim/neovim source (src-cache/neovim), wasi-libc/wasi-sdk, Binaryen, WASI preview1 spec, libuv upstream, lua.org, tree-sitter upstream, Emscripten docs, general non-excluded references. New shims/patches carry WHAT/WHY/CLEAN-ROOM-PROVENANCE headers.
- Patch discipline: prefer shims and CMake wiring over Neovim source patches; a new source patch is acceptable only when no shim-level path exists (precedent: neovim-embed-stdio.patch), minimal, provenance-headed.
- Every existing gate must stay green: `bash nvim-wasm-prototype/test/uv-smoke.sh`, `bash nvim-wasm-prototype/scripts/smoke.sh` (SMOKE PASS incl. idle ≤5/s), parent `npm test`, `npm run typecheck`, vendored-default `node scripts/smoke-nvim.mjs`.
- Build hygiene: `.toolchain/ build/ src-cache/ dist/` never committed; scripts idempotent; STATUS.md updated per task (close the open item, note the mechanism).
- Branch: `prototype/parity-gaps` off main. Conventional commits.
- Shell rule (hook-enforced, Bash TOOL calls): one command per call; `;` `&&` `||` `|` `$(` backticks `>>` `<<` blocked (fine inside committed files).
- Full rebuild flow if needed: `bash scripts/build-nvim.sh` → `bash scripts/asyncify.sh` → `bash scripts/smoke.sh` (all under nvim-wasm-prototype/, each sources scripts/env.sh itself).

---

### Task 1: Parity gate harness + uv_exepath

**Files:**
- Create: `nvim-wasm-prototype/test/parity-check.mjs`
- Modify: `nvim-wasm-prototype/shims/uv-wasi-platform.c` (or wherever `uv_exepath` currently returns ENOSYS — grep the shims), `nvim-wasm-prototype/STATUS.md`

**Interfaces:**
- Produces: `node test/parity-check.mjs <wasm> <runtime-tarball>` — boots nvim `--embed` under the same WASI arrangement as the parent host (reuse the boot approach of `scripts/smoke-nvim.mjs` in the PARENT repo — read it; the prototype may import nothing from it but may mirror the pattern), then runs named checks and prints `PARITY PASS`/`FAIL` with per-check lines, exit nonzero on failure. Checks land in Tasks 1–3; the harness runs whatever checks exist.
- Produces: `uv_exepath` returns a synthetic stable path.

- [ ] **Step 1 (failing test first):** Write `test/parity-check.mjs` with check 1: `progpath` — `nvim_eval("v:progpath")` must be a non-empty string ending in `nvim`. Run against current `dist/` artifacts: expected FAIL (empty string) — record the observed value in the report.
- [ ] **Step 2:** Implement `uv_exepath` in the shim: fill the buffer with `/nvim/bin/nvim` (a path consistent with the host's `/nvim` preopen; document choice in the shim header comment), respecting libuv's `uv_exepath(char* buffer, size_t* size)` contract (size in/out, NUL-termination, UV_EINVAL on null/zero). Update the fixups/stub inventory comment if one lists exepath as ENOSYS.
- [ ] **Step 3:** Rebuild (`build-nvim.sh` — shim change relinks; then `asyncify.sh`), run `node test/parity-check.mjs dist/nvim-asyncify.wasm dist/nvim-runtime.tar.gz`: progpath check PASS.
- [ ] **Step 4:** Full regression: `bash scripts/smoke.sh` SMOKE PASS. STATUS.md: close the uv_exepath open item (note the synthetic path). Commit `feat: parity gate harness + synthetic uv_exepath`.

### Task 2: io.write / io.stdout RPC-corruption fix

**Files:**
- Modify: whichever mechanism is chosen — candidates: extend `nvim-wasm-prototype/patches/neovim-embed-stdio.patch` region, a new `patches/neovim-*.patch`, or (preferred if viable) a C-level fix in `shims/` — see Step 1 investigation. Plus `test/parity-check.mjs`, `STATUS.md`, and the patch header + `README.md` "What an engine swap would take" paragraph (limitation resolved).

**Interfaces:**
- Consumes: parity harness from Task 1.
- Produces: user Lua writing via `io.write()` / `io.stdout:write()` cannot corrupt the msgpack stream; the bytes land on stderr instead.

- [ ] **Step 1 (investigate, then decide — document in STATUS.md):** Two candidate mechanisms; pick the one that works, in this order of preference:
  (a) **C stdio retarget:** nvim's RPC writes to fd 1 via uv raw fd writes; Lua's `io` library writes through C `FILE* stdout`. If, in the embedded `__wasi__` path, C `stdout` is retargeted to fd 2 (e.g. `freopen` is unavailable — but wasi-libc is musl-derived: check whether reassigning `stdout` to `stderr` (`stdout = stderr;` — musl exposes them as mutable pointers? verify in wasi-libc headers) or an fflush+internal-fd swap is possible without touching musl internals), then ALL C-level stdout writers (Lua io included) divert to stderr while RPC keeps raw fd 1. Try a 10-line wasm test program first (printf to stdout after retarget → must appear on fd 2).
  (b) **Lua-level redirect:** run, right after Lua state init in embedded mode, a chunk equivalent to: `io.stdout = io.stderr; io.write = function(...) return io.stderr:write(...) end`. Injection point without a big patch: Neovim runs `runtime/lua/vim/_init_packages.lua` etc. from OUR packaged runtime tarball — but modifying packaged runtime files diverges from pinned upstream; better is a tiny C patch calling `nlua_exec` (or equivalent) in the same channel.c `__wasi__` block the embed-stdio patch already owns... investigate whether the Lua state exists at that point; if not, find the earliest post-init hook (e.g. `main.c` after `nlua_init`) and extend/add a patch there.
  Whichever lands: provenance-headed, minimal, and the OLD misleading options removed from docs.
- [ ] **Step 2 (failing test first):** Add parity check 2: `io_write_safe` — send `nvim_exec_lua("io.write(string.char(0xdc,0x00,0x10)) return 1", [])` (the exact 3-byte sequence the Task-7 reviewer proved fatal), then immediately `nvim_eval("1+1")` with a 2s timeout. Current build: expected FAIL (second request times out). Record it.
- [ ] **Step 3:** Implement the chosen mechanism; rebuild; parity check 2 PASS (exec_lua returns 1, follow-up eval returns 2, and — if capturable — the junk bytes observed on stderr, not stdout).
- [ ] **Step 4:** Also verify `print("hello")` still works (routes through nvim's message system, not fd 1) via check `print_safe`: `nvim_exec_lua("print('x') return 2", [])` then `nvim_eval("2+2")` — both answer.
- [ ] **Step 5:** Full regression (`smoke.sh`); update patch header/README/STATUS (limitation → resolved, mechanism named). Commit `feat: divert Lua stdio writes off the RPC fd`.

### Task 3: Statically linked tree-sitter parsers

**Files:**
- Modify: `nvim-wasm-prototype/scripts/build-nvim.sh` (link the 6 parser archives), likely a new `nvim-wasm-prototype/shims/nvim-wasi-treesitter.c` (registration) and/or a `patches/neovim-ts-static.patch`; `test/parity-check.mjs`; `STATUS.md`; `README.md`.

**Interfaces:**
- Consumes: parser archives from rung 2: `build/deps/lib/libtree-sitter-{c,lua,vim,vimdoc,query,markdown}.a` exporting `tree_sitter_<lang>()` (markdown archive exports both `tree_sitter_markdown` and `tree_sitter_markdown_inline`).
- Produces: `vim.treesitter.language.add('<lang>')` succeeds for c, lua, vim, vimdoc, query, markdown, markdown_inline WITHOUT dlopen; `vim.treesitter.get_parser` can parse a buffer.

- [ ] **Step 1 (investigate):** Read src-cache/neovim/src/nvim/lua/treesitter.c and runtime/lua/vim/treesitter/language.lua for v0.12's parser-loading path (`language.add` → C `ts_lua` register via dlopen of `parser/<lang>.so`). Neovim has no built-in static-parser registry (verify — if v0.12 DOES have one, e.g. for the wasmtime path or bundled parsers, use it and skip the shim). Document findings in STATUS.md before coding.
- [ ] **Step 2 (failing test first):** Parity check 3: `treesitter` — `nvim_exec_lua("local ok = pcall(vim.treesitter.language.add, 'c'); if not ok then return 'no-c' end local p = vim.treesitter.get_string_parser('int x;', 'c'); p:parse(); return 'parsed'", [])` expecting `'parsed'`; plus a loop asserting all 7 grammars register. Current build: expected FAIL (`no-c`). Record.
- [ ] **Step 3 (implement):** The likely shape (adjust to Step-1 findings): a shim TU with a table `{name, fn}` of the 7 `extern TSLanguage* tree_sitter_*()` symbols and a registration function invoked from Lua via a patched-or-shimmed hook — options: (i) patch `language.add`'s C fallback to consult the static table before dlopen (small patch to src/nvim/lua/treesitter.c guarded `#ifdef __wasi__`), (ii) if nvim's `vim._ts_add_language_from_object`-style API can accept a function pointer via lightuserdata pushed from a registered C function, prefer pure-shim. Link `-Wl,--whole-archive`-equivalent not needed if the shim TU references all 7 symbols directly (forces archive extraction). Wire the 6 archives into the `build-nvim.sh` link line.
- [ ] **Step 4:** Rebuild, parity check 3 PASS for all 7 grammars. Record binary-size delta in STATUS.md (parsers will add ~1-2MB — note actual).
- [ ] **Step 5:** Full regression (`smoke.sh` — idle gate must still hold). Update README parity paragraph + STATUS open items. Commit `feat: statically linked tree-sitter parsers`.

### Task 4: Wrap-up — parity gate in smoke.sh, docs, merge

**Files:**
- Modify: `nvim-wasm-prototype/scripts/smoke.sh` (run parity-check.mjs after the parent smoke, so the rung-8 gate now includes parity), `README.md` (Results + engine-swap paragraph rewritten: gaps closed, what remains before a swap decision), `STATUS.md` (ladder: mark rung 9 progress), parent `memory/journal/2026-07-15.md`.

- [ ] **Step 1:** smoke.sh addition + one full run: SMOKE PASS + PARITY PASS.
- [ ] **Step 2:** Docs: README engine-swap paragraph now states the three gaps are closed (name mechanisms); remaining pre-swap items are product decisions (threaded build, tarball pruning, asyncify stack assert) not correctness gaps. STATUS ladder + open items updated.
- [ ] **Step 3:** Parent gates: `npm test`, `npm run typecheck`, vendored `node scripts/smoke-nvim.mjs`.
- [ ] **Step 4:** Commit docs; push branch; PR; merge (standing authorization; stop only if branch protection blocks).

---

## Self-review notes

- Coverage: three gaps ↔ Tasks 1-3, each with a failing-first RPC-driven check in a permanent harness; Task 4 folds the harness into the standing gate and merges.
- Exploration latitude: Tasks 2/3 have investigate-first steps with decision documentation required (mechanism choice is the implementer's, bounded by patch discipline).
- Consistency: check names (`progpath`, `io_write_safe`, `print_safe`, `treesitter`) and harness invocation identical across tasks; archive names match rung-2 outputs (verify `libtree-sitter-markdown.a` bundling of both grammars per Task-4 review notes).
