# nvim-wasi as a Consumable Engine API

> Two-repo plan. REQUIRED SUB-SKILL: subagent-driven-development. Steps use `- [ ]`.

**Goal:** `nvim-wasi` becomes a self-contained, versioned engine API — publishing SHA-pinned artifacts + a documented ABI/protocol contract — and `nvim-in-browser` consumes it as its sole engine source (fetched, not built-in-repo). All engine-creation lives in `nvim-wasi`; the extension holds no build machinery for it.

**Repos:** `~/Repos/Personal/nvim-wasi` (provider, private, Apache-2.0) and `~/Repos/Personal/nvim-in-browser` (consumer, private).

## Global Constraints
- Ordering: Part A (nvim-wasi publishes v0.1.0) MUST complete before Part B (extension fetches it).
- nvim-wasi stays clean-room (no MuNeNICK); its gate (`scripts/smoke.sh` → parity-check) must stay green.
- The extension ends with ONE engine source: fetched nvim-wasi release artifacts, SHA-pinned. The vendored MuNeNICK path (`fetch-nvim-wasm.mjs`, `NVIM_ENGINE=vendored`, `ALLOW_UNLICENSED_ENGINE` gate) is REMOVED — the clean engine is now the reference, and keeping an unlicensed-upstream fetch is pure liability.
- Both private, so the extension fetches via `gh release download --repo unknownbreaker/nvim-wasi` (uses the user's gh auth), SHA-pinned after download.
- Conventional commits; shell rule (one command per Bash tool call).

---

## Part A — nvim-wasi becomes an artifact + contract provider

### Task A1: Release pipeline + checksums (in ~/Repos/Personal/nvim-wasi)
**Files:** create `scripts/release.sh`, `scripts/package-release.sh` (or fold into release.sh); modify `package.json` (release script), `STATUS.md`.
- `scripts/release.sh <patch|minor|major|X.Y.Z> [--dry-run]`: (1) run the gate (`bash scripts/smoke.sh`) — refuse to release if it fails; (2) verify `dist/nvim-asyncify.wasm` + `dist/nvim-runtime.tar.gz` exist (built via the pipeline); (3) write `dist/SHA256SUMS` over the two artifacts; (4) bump `package.json` version; (5) tag `vX.Y.Z`, push tag; (6) `gh release create vX.Y.Z` attaching the two artifacts + `SHA256SUMS` + a generated release note. `--dry-run` stops after packaging. Fail loudly if the gate fails or artifacts are missing (with the build command chain).
- Follows defensive-bash norms; idempotent-ish; leaves the tree clean on dry-run.

### Task A2: Engine API / consumer contract doc (in nvim-wasi)
**Files:** create `ENGINE-API.md`; modify `README.md` (add "Consuming the engine" section linking it).
- Document the CONTRACT a host must satisfy to run the engine, language-agnostic:
  - The two artifacts and what they are (asyncified wasm module; runtime tarball mounted at `/runtime`).
  - WASI preview1 boot arrangement: argv `["nvim","--embed","-u","NORC","--noplugin","-i","NONE","-n"]`, env (`HOME=/home`, `VIMRUNTIME=/runtime`, `TMPDIR=/tmp`, `NVIM_LOG_FILE=/tmp/nvim.log`, XDG_* ), preopens (`/` root, `/home`, `/tmp`, runtime tree).
  - Asyncify ABI: the module exports `nvim_asyncify_get_data_ptr/stack_start/stack_end`; the host must run an Asyncify driver that suspends on `poll_oneoff` and provides the unwind stack region. Explain the suspend/rewind loop at a high level.
  - The syscall shim expectation: `poll_oneoff` with a real fd_read subscription on stdin makes idle event-driven (no busy-wait); document that a host that supplies fewer capabilities still works but may need backoff.
  - The transport: msgpack-RPC over stdio (stdin/stdout). Point to Neovim's `--embed` API docs for the RPC surface.
  - Reference consumer: `test/parity-check.mjs` is a complete standalone JS host — point readers there as the worked example.
  - Fetching: how to download a pinned release (`gh release download` / release asset URLs) and verify against `SHA256SUMS`.

### Task A3: Cut v0.1.0 release (controller-run)
- Run `scripts/release.sh minor` (0.1.0 → or set 0.1.0 explicitly). Verify the GitHub release has the 3 assets and SHA256SUMS matches local.

---

## Part B — extension consumes the nvim-wasi API (in ~/Repos/Personal/nvim-in-browser)

### Task B1: Fetch engine from nvim-wasi release
**Files:** create `scripts/fetch-engine.mjs` (replaces `fetch-nvim-wasm.mjs`); modify `package.json` (`fetch-assets` → fetches nvim-wasi), a pinned-version file (`engine.lock.json` with `{repo, tag, files:[{name,sha256}]}`).
- `fetch-engine.mjs`: `gh release download <tag> --repo unknownbreaker/nvim-wasi --pattern nvim-asyncify.wasm --pattern nvim-runtime.tar.gz` into `vendor/nvim-wasi/`, verify each against `engine.lock.json` sha256 (fail loudly on mismatch), idempotent (skip if present + hash-valid). Tag + hashes pinned in `engine.lock.json` (populated from the A3 release).

### Task B2: build.mjs points at fetched engine; drop vendored path
**Files:** modify `scripts/build.mjs` (single engine source = `vendor/nvim-wasi/`; drop the `NVIM_ENGINE` switch and the `nvim-wasm-prototype/dist` path); `engine-info.json` marker keeps `{source:"nvim-wasi", tag, bytes, sha256}`.
- Loud error if `vendor/nvim-wasi/` missing → "run npm run fetch-assets".

### Task B3: Remove nvim-wasm-prototype/ and vendored MuNeNICK path
**Files:** delete `nvim-wasm-prototype/` (whole dir), `scripts/fetch-nvim-wasm.mjs`, `vendor/nvim-wasm/` references; modify `.gitignore` (drop prototype ignores, keep `vendor/`), `scripts/release.sh` (drop `ALLOW_UNLICENSED_ENGINE` gate entirely — sole engine is clean; or replace with an assertion that engine-info source is nvim-wasi), README + spec (engine is built in the separate nvim-wasi repo; link it), `vitest.config.ts` (drop the prototype src-cache exclusion if now unneeded — verify), `smoke-nvim.mjs`/`overlay`/`browser` smokes (default engine path now `vendor/nvim-wasi/`).

### Task B4: Verify + release v0.4.0
- `npm run fetch-assets` (pulls v0.1.0 engine), `npm run build` (marker source nvim-wasi), `npm test`, `npm run typecheck`, `node scripts/browser-smoke.mjs`, `node scripts/overlay-smoke.mjs`, `node scripts/smoke-nvim.mjs` (now points at fetched engine — note smoke-nvim bundles src/engine host + fetched artifacts).
- PR, merge, `scripts/release.sh minor` → v0.4.0 (no ALLOW_UNLICENSED needed; ideally the gate is gone).

---

## Self-review notes
- After this, the extension contains zero engine-build machinery and zero unlicensed references; nvim-wasi is the single source of the engine, versioned and contract-documented.
- Risk: nvim-wasi private → fetch needs gh auth. Acceptable (both repos private, user-built). If nvim-wasi later goes public, fetch can use plain release URLs.
- `smoke-nvim.mjs` still bundles the extension's own TS engine HOST (src/engine/*) — that stays (it's the browser host, the consumer side), only the engine ARTIFACT source changes.
