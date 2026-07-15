# Engine Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Chrome extension ships our clean-room engine (nvim-wasm-prototype/dist artifacts) instead of the vendored unlicensed nvim-wasm binary — proven by the full browser smoke suite (rung 9), then released as v0.3.0.

**Architecture:** The engine host already speaks stock msgpack-RPC + Asyncify ABI, and the parity work proved artifact-level compatibility (same argv/env/exports; parity gate green under the same host code). The swap is therefore build-pipeline wiring: `scripts/build.mjs` sources the engine from `nvim-wasm-prototype/dist/` (built locally by the prototype pipeline) instead of `vendor/nvim-wasm/` (fetched from the unlicensed repo). The vendored path remains as an explicit opt-in fallback (`NVIM_ENGINE=vendored`) until the clean-room engine has real-world mileage, then can be deleted.

**Tech Stack:** existing build (esbuild script), prototype build pipeline, puppeteer smokes.

## Global Constraints

- Engine source of truth: `nvim-wasm-prototype/dist/nvim-asyncify.wasm` + `nvim-runtime.tar.gz`. Build fails loudly with build instructions if missing (mirror the existing missing-vendor error style).
- `NVIM_ENGINE=vendored npm run build` keeps the old path working (vendor/ fetch + copy). Default is clean-room. Log which engine was bundled and its byte size.
- The host code (src/engine/*) must NOT need changes — the parity gate proved compatibility. If a browser smoke failure suggests otherwise, STOP and report (that's a compatibility bug to fix in the prototype, not the host).
- ALL existing gates green: npm test, typecheck, node scripts/smoke-nvim.mjs (vendored default — unchanged), browser-smoke.mjs and overlay-smoke.mjs against the NEW dist (these are the rung-9 gate).
- Idle-CPU expectation: with our engine, the host's adaptive backoff should never engage (stdin fd_read subscription); browser smoke idle sample should be ≤1/s and is asserted at the existing ≤5/s gate.
- Docs: root README "Third-party engine" section rewritten (engine is now first-party; nvim-wasm fetch is legacy fallback); release script's ALLOW_UNLICENSED_ENGINE guard becomes conditional — refuse only when the VENDORED engine is being packaged (check which engine landed in dist, e.g. via a build-emitted marker file dist/chromium/engine-info.json {source, sha256, bytes}); spec Milestone notes updated.
- Branch `feat/engine-swap`. Conventional commits. Shell rule (hook-enforced): one command per Bash tool call.

---

### Task 1: Build wiring + rung 9 browser verification

**Files:**
- Modify: `scripts/build.mjs` (engine selection, engine-info.json marker), `README.md` (usage note)
- Verify: `scripts/browser-smoke.mjs`, `scripts/overlay-smoke.mjs` unchanged but run against the new dist

- [ ] **Step 1:** Ensure prototype dist exists/fresh: `bash nvim-wasm-prototype/scripts/smoke.sh` (rebuild via prototype scripts if missing) — SMOKE+PARITY green baseline.
- [ ] **Step 2:** build.mjs: engine selection block — default `cleanroom`: copy from `nvim-wasm-prototype/dist/`; `NVIM_ENGINE=vendored`: existing vendor/ path. Write `dist/chromium/engine-info.json` with `{ source: "cleanroom"|"vendored", bytes, sha256 }` for each of the two engine files. Loud error if the chosen engine's files are missing (with the exact command to produce them).
- [ ] **Step 3:** `npm run build` → confirm dist/chromium contains the 10,825,005-byte wasm and engine-info.json says cleanroom. `NVIM_ENGINE=vendored npm run build` → 8,386,869-byte wasm, marker says vendored. Rebuild default afterward.
- [ ] **Step 4 (rung 9 gate):** `node scripts/browser-smoke.mjs` (scratch page boots OUR engine in Chrome; idle gate) and `node scripts/overlay-smoke.mjs` (full overlay loop incl. :q final sync, password no-op, prod dead-code check — note overlay-smoke rebuilds internally: verify it inherits/sets the default engine correctly, adjust its internal build calls if they need NVIM_ENGINE passthrough). Both PASS.
- [ ] **Step 5:** Parent regressions: `npm test`, `npm run typecheck`, `node scripts/smoke-nvim.mjs` (still vendored-default paths — unchanged and green).
- [ ] **Step 6:** Commit `feat: extension ships the clean-room engine by default`.

### Task 2: Docs, release guard, v0.3.0

**Files:**
- Modify: `README.md` (Third-party engine section rewrite), `scripts/release.sh` (conditional guard via engine-info.json), `docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md` (Milestone-1 implementation notes: engine now first-party), `nvim-wasm-prototype/STATUS.md` (rung 9 checked), journal.

- [ ] **Step 1:** release.sh: replace the unconditional ALLOW_UNLICENSED_ENGINE guard with a post-build check of `dist/chromium/engine-info.json` — if `source == "vendored"`, keep the refusal (env override still honored); if `cleanroom`, proceed (log "first-party engine, no license gate"). `bash -n` + a `--dry-run` both ways (vendored dry-run WITH the env var, cleanroom dry-run without).
- [ ] **Step 2:** README: "Third-party engine" → "Engine" (first-party clean-room build; how to build it; vendored fallback documented as legacy + still-unlicensed caveat). STATUS.md: check rung 9 with the browser-smoke evidence. Spec: one-paragraph update.
- [ ] **Step 3:** All gates once more (test, typecheck, both browser smokes on a fresh default build).
- [ ] **Step 4:** Commit docs, push branch, PR, merge (stop if branch protection blocks).
- [ ] **Step 5:** On merged main: `scripts/release.sh minor` (v0.3.0 — no ALLOW_UNLICENSED_ENGINE needed anymore). Verify release assets contain the clean-room engine via engine-info.json inside the zips.

---

## Self-review notes
- Repo-private caveat remains until upstream-licensing posture is re-evaluated (vendored fallback still fetchable) — release stays private-repo; no publicity change in this plan.
- Type consistency: engine-info.json shape `{source, bytes, sha256}` used by build.mjs (writer) and release.sh (reader).
