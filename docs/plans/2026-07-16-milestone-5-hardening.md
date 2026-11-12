# Milestone 5: Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Prove the clean-room engine behaves like real Neovim (differential fidelity suite), enforce performance budgets, and reclaim resources on idle — the robustness/quality layer.

**Scope (user-chosen: full hardening pass, both repos).** Already done opportunistically: boot watchdog (M1), safe mode (M4), idle-CPU gate (all along). This milestone adds: (A) a **fidelity suite** in nvim-wasi — differential testing vs desktop `nvim --headless` as oracle; (B) **performance gates** (boot-time + input-latency budgets) in the extension smokes; (C) **resource lifecycle** — idle-instance teardown + memory watchdog in the extension.

**Architecture:** Phase A is nvim-wasi (engine repo) test infrastructure — reuses `test/parity-check.mjs`'s boot. Phases B/C are extension host-side (engine untouched). Cross-repo: Phase A merges/tags in nvim-wasi; Phases B/C merge + release in nvim-in-browser.

## Global Constraints
- Engine (nvim-wasi .wasm/API) NOT modified by any task — Phase A only ADDS test infra to the nvim-wasi repo; Phases B/C are extension host-side.
- No regression: all existing gates stay green (nvim-wasi smoke.sh; extension npm test / smoke-nvim / browser-smoke / overlay-smoke). Extension browser smokes run SEQUENTIALLY (each rebuilds dist).
- Fidelity oracle: system `nvim` (v0.12.2) vs the wasm engine (v0.12.4). The corpus MUST stick to core editing behavior stable across patch versions (motions, operators, text objects, registers, macros, :s, :g, undo, visual, counts) — no version-sensitive edge cases. Any case that legitimately differs by nvim version is excluded with a comment, not asserted.
- Conventional commits. Shell rule: one command per Bash tool call.

---

## Phase A — Fidelity suite (repo: ~/Repos/Personal/nvim-wasi)

### Task A1: Differential fidelity harness + corpus
**Repo:** `/Users/robertyang/Repos/Personal/nvim-wasi`, branch `feat/fidelity-suite`.
**Files:** Create `test/fidelity-cases.mjs`, `test/fidelity.mjs`, `test/nvim-host.mjs` (extracted reusable boot — see step 1); modify `package.json` (`fidelity` script), `README.md`, `STATUS.md`.

**Interfaces:**
- `test/fidelity-cases.mjs`: `export const CASES = [{ name, category, initial: string[], keys: string }...]` — `keys` in nvim `nvim_input` notation (e.g. `"wdw"`, `"ciwnew<Esc>"`, `"qaddq3@a"`).
- `test/nvim-host.mjs`: extract the wasm-boot + RPC helpers from `test/parity-check.mjs` into a reusable module (`bootEngine(wasmPath, runtimePath): Promise<{ request, input, dispose }>`) so both parity-check and fidelity use one boot. (parity-check.mjs re-imports it; keep its behavior identical.)

- [ ] **Step 1: Extract the reusable boot.** Move parity-check.mjs's inline WASI+Asyncify boot + RPC into `test/nvim-host.mjs` exporting `bootEngine(...)` (request/input/dispose). Refactor parity-check.mjs to import it; re-run `bash scripts/smoke.sh` → still PARITY PASS (proves the extraction didn't change behavior).
- [ ] **Step 2: Corpus.** Write `test/fidelity-cases.mjs` with ~30-40 cases across categories, each a small buffer + a key sequence with a deterministic result. Cover: **motions** (w b e ge 0 $ ^ gg G f t % { }), **operators×motions** (dw cw de d$ c0 yy+p dd cc D C x X r~ J gU~), **text objects** (diw daw ci( ca" di{ dit-ish→skip if fragile), **registers** ("ayy "ap 0p yaw"0p), **macros** (qa...q @a 3@a), **:s** (:s/a/b/ :%s/a/b/g :s/\\v.../), **:g** (:g/foo/d :v/foo/d), **undo/redo** (edit u, edit u C-r), **visual** (viwd Vd vjd v$y), **counts** (3dd 2cw 3x d3w). Keep results 1-line-ish where possible for easy diffing. Header-comment the oracle-version caveat.
- [ ] **Step 3: Oracle helper.** A function that, for one case, runs desktop nvim headless deterministically and returns the final buffer lines. Use: write a tiny `test/oracle.lua` that reads the case (initial lines + keys, passed via a temp JSON file path in an env var), does `nvim_buf_set_lines`, `feedkeys(nvim_replace_termcodes(keys, true, false, true), "nx")`, then prints `nvim_buf_get_lines` as JSON to stdout; invoke `nvim --headless -u NORC --noplugin -n -i NONE --clean -l test/oracle.lua` capturing stdout. (`--clean` for reproducibility.) Parse the JSON. Handle nvim exit.
- [ ] **Step 4: fidelity.mjs.** For each case: get oracle lines (Step 3) + wasm lines (bootEngine → `nvim_buf_set_lines(0,0,-1,false,initial)` → `nvim_input(keys)` → a sync flush via `nvim_eval("1")` → `nvim_buf_get_lines(0,0,-1,false)`); assert deep-equal. Print `PASS/FAIL <category> <name>` (on FAIL show oracle vs wasm), a summary `N/M passed`, and exit nonzero on any mismatch. Boot the engine ONCE and reuse across cases (reset the buffer per case with `enew!`/`%d` + set_lines) for speed — but ensure clean per-case state (fresh buffer, registers may carry — reset registers if a case depends on it, or `:let @a=''` between; simplest: `enew!` gives a fresh buffer, and clear the relevant registers at case start). Document the reset approach.
- [ ] **Step 5: Wire + run.** `package.json`: `"fidelity": "node test/fidelity.mjs"`. Run it — iterate the corpus until all cases pass OR a case legitimately differs by version (then exclude it with a comment explaining why). Add `bash scripts/smoke.sh` (parity) still green. Record results + the oracle/wasm versions in STATUS.md; note fidelity in README.
- [ ] **Step 6: Commit** `test: differential fidelity suite vs desktop nvim oracle`. (nvim-wasi repo.) Controller merges + optionally tags.

---

## Phase B — Performance gates (repo: nvim-in-browser)

### Task B1: Boot-time + input-latency budgets in the browser smoke
**Repo:** nvim-in-browser, branch `feat/milestone-5` (create from main after Phase A merges).
**Files:** Modify `scripts/browser-smoke.mjs`.

- [ ] **Step 1: Boot-time gate.** In the scratch-boot phase, measure `Date.now()` from just before `page.reload`/first load to `__nvim.ready === true`. Assert < a generous cold budget (BOOT_BUDGET_MS = 6000 — first load compiles ~11MB wasm; document it's cold-compile-inclusive). Log the measured value.
- [ ] **Step 2: Input-latency gate.** After boot + idle, drive ~40 round-trips: for each, `t0 = Date.now(); await __nvim.request("nvim_eval", ["1"]); record Date.now()-t0`. Compute p95. Assert p95 < LATENCY_BUDGET_MS = 75 (headless slack; real is ~3ms). Log measured p50/p95. (Use nvim_eval as a minimal RPC round-trip proxy for input responsiveness.)
- [ ] **Step 3: Verify.** `node scripts/browser-smoke.mjs` → all phases incl. the new gates pass; log the measured boot + latency numbers. `node scripts/overlay-smoke.mjs` still green. Commit `test: performance gates (boot-time + input-latency budgets)`.

---

## Phase C — Resource lifecycle (repo: nvim-in-browser, branch feat/milestone-5)

### Task C1: Idle-instance teardown + memory watchdog (scratch page)
**Files:** Modify `src/engine-frame/engine-frame.ts` (full/scratch mode), possibly `src/engine/nvim-host.ts` + `worker.ts` (report memory in the stat message — host-side, allowed).

- [ ] **Step 1: Memory in the stat channel.** In nvim-host.ts, include the current wasm memory bytes (`memory.buffer.byteLength`) in the periodic `onStat` payload (extend to `{ wakeupsPerSecond, memoryBytes }`); worker.ts + client.ts thread it; engine-frame's onStat records `debug.memoryBytes`. Default-boot behavior otherwise unchanged.
- [ ] **Step 2: Memory watchdog.** In the frame, if `memoryBytes` exceeds MEM_CAP (e.g. 700MB) — a runaway config/plugin — dispose the worker, show a notice ("editor used too much memory and was stopped"), and do NOT auto-respawn (avoid a crash loop). Test-observable via `debug.memoryCapped`.
- [ ] **Step 3: Idle-instance teardown (scratch full mode only).** After IDLE_TEARDOWN_MS (5 min) with no keydown, save the buffer (reuse the scratch-store save), dispose the worker, and show a lightweight "💤 sleeping — press any key to resume" overlay div. On the next keydown/click, respawn (fresh client + wireClient + bootWithSafeMode) and restore the saved draft, hide the sleeping overlay. Reset the idle timer on any input. Expose `debug.sleeping` for the smoke. Do NOT apply to embed/overlay mode (it's already transient — torn down on deactivate).
  - Careful: the teardown/respawn must re-run the full scratch init (installBufferHooks, restore, save wiring, clipboard sync, ime focus) via the existing startScratch path — factor so respawn reuses it.
- [ ] **Step 4: Verify.** `npm run typecheck`; `npm run build`; `node scripts/smoke-nvim.mjs`. (Real idle/respawn proof is Task C2's smoke.) Commit `feat: idle-instance teardown and memory watchdog`.

### Task C2: Verify (smoke) + docs
**Files:** Modify `scripts/browser-smoke.mjs`, `README.md`, spec.

- [ ] **Step 1: Idle-teardown smoke.** Make IDLE_TEARDOWN_MS overridable (e.g. via a `window.__nvimIdleMs` the smoke sets, or a small test hook) so the smoke doesn't wait 5 min. Set it to ~2s, type a draft, wait for `debug.sleeping === true` (worker torn down), assert a sleeping overlay is visible; then dispatch a keydown, wait for `__nvim.ready` again + `debug.sleeping === false`, and assert the draft restored (buffer contains the text). Proves teardown→respawn→restore.
- [ ] **Step 2: Full gate (sequential).** `npm test`; `npm run typecheck`; `node scripts/smoke-nvim.mjs`; `node scripts/browser-smoke.mjs` (persistence + clipboard + config + safe-mode + perf gates + idle-teardown all pass); `node scripts/overlay-smoke.mjs`.
- [ ] **Step 3: Docs.** README: hardening notes (idle sleep/resume, memory guard, perf budgets; fidelity suite lives in nvim-wasi). Spec: mark Milestone 5 done, listing what each hardening item delivered.
- [ ] **Step 4: Commit** `test: idle-teardown smoke; docs: milestone 5 done`.

---

## Self-review notes
- Engine untouched: Phase A adds test infra to nvim-wasi only (no .wasm change); B/C are extension host-side (nvim-host stat extension is host-layer, default behavior preserved).
- Idle-teardown respawn reuses the startScratch path (no duplicated init); the idle timer is scoped to full/scratch mode only.
- Deferred/documented: threaded build + JSPI (engine track, not this milestone); background-tab full suspend (rAF already throttles + idle 0%, so minimal); fidelity oracle version mismatch (0.12.2 vs 0.12.4) mitigated by a version-stable corpus.
- Interface consistency: `bootEngine`, `CASES`, stat `{wakeupsPerSecond, memoryBytes}`, `debug.{memoryBytes,memoryCapped,sleeping}`, `__nvimIdleMs` names consistent across tasks.
