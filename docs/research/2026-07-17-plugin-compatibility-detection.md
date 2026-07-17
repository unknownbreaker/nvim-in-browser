# Determining Plugin Compatibility with the WASM Sandbox — Research Synthesis

*2026-07-17. Synthesizes three parallel research efforts: (A) the incompatibility
taxonomy + declared-requirement signals, (B) detection techniques + reliability, (C)
codebase-grounded runtime behavior + a dynamic-test feasibility study. Feeds the
marketplace discovery engine (`src/plugins/marketplace-discovery.ts`).*

---

## 0. Executive summary

- **The compatibility boundary is precise and static-detectable at the coarse ends.**
  A plugin is incompatible iff it needs one of: a **child process**, a **host socket**,
  **native code** (FFI / `.so` / dlopen), a **compiled tree-sitter grammar it must
  install**, an **external binary**, or a **remote-plugin host** (python/node). Each has
  concrete source + repo-tree + declared-requirement signals.
- **Our current heuristics are a solid cheap first pass but have real gaps** — and one
  outright **false positive**: we blanket-reject `vim.treesitter`, yet the engine ships
  **7 statically-linked grammars** (`c, lua, vim, vimdoc, query, markdown,
  markdown_inline`) that work with no dlopen. We wrongly exclude plugins that only use
  those.
- **The single biggest upgrade is a dynamic load-test**, and it's highly feasible with
  our *existing* engine — because unsupported syscalls are compiled to **clean-fail
  stubs** (they return catchable Lua errors, they don't trap the module). Inject a Lua
  recording prelude over the existing RPC channel, `packadd` the candidate under `opt/`,
  and read back exactly what it *tried* to do. This is ground truth and defeats the
  aliasing/optional-path problems that cap static analysis.
- **No automated method can be 100% correct** (Rice's theorem; the `if executable('rg')
  then jobstart(...)` optional-path pattern is two-sided). The honest design is **tiered
  verdicts with reasons + community reporting**, not a binary.

Recommended architecture: **Tier 0 metadata → Tier 1 tree scan → Tier 2 improved regex
(bulk, in the options page) → Tier 3 on-demand AST + dynamic load-test (Install/Verify).**

---

## 1. The incompatibility taxonomy (what to detect)

The sandbox = clean-room Neovim → `wasm32-wasi` in a Web Worker: no `fork`/`exec`/spawn,
no POSIX sockets, no native-code loading, no external binaries, PUC Lua 5.1 (no LuaJIT →
no `ffi`). Six incompatibility classes, each with its detection signals:

### 1.1 Process spawning (#1 killer)
Lua: `jobstart`, `vim.fn.jobstart`, `vim.fn.system`/`systemlist`, `termopen`,
`vim.system(` (0.10+), `os.execute`, `io.popen`, `vim.loop.spawn`/`vim.uv.spawn`/`uv.spawn`,
`vim.fn.serverstart`. Vimscript: `system(`, `systemlist(`, `termopen(`, `jobstart(`,
`job_start(`/`ch_open(`/`ch_sendraw(` (Vim channel APIs). Note `io.open` to a real file is
**fine** (WASI has a filesystem) — don't blanket-ban it.

### 1.2 Host networking
libuv sockets: `new_tcp`/`new_udp`/`tcp_connect`/`:connect(`/`getaddrinfo`/`getnameinfo`/
`:bind(`/`:listen(` on `vim.uv`/`vim.loop`/`uv`. `vim.fn.sockconnect`, `serverstart`,
channels. LuaSocket (`require('socket')`, `socket.http`, `require('ssl')`). `plenary.curl`
+ `plenary.job` (both shell out → also class 1.1/1.5). **LSP** (`vim.lsp.start`/
`start_client`, 0.11 `vim.lsp.config`/`enable`, `require('lspconfig')`, `mason`) — needs a
server process + socket.

### 1.3 Native code / FFI
`require('ffi')` (all quoting + paren-less forms), `ffi.load`/`ffi.cdef`/`ffi.C.`,
`package.loadlib(`, `package.cpath` mutation, C-extension `require`s (`cjson`, `socket`,
`posix`, native rocks).

### 1.4 Tree-sitter — **nuanced (see §3.1)**
`:TSInstall`/`:TSUpdate`, `require('nvim-treesitter'...)`, `ensure_installed`,
`vim.treesitter.language.add('<non-bundled>')`, a `parser/*.so` in the tree. **But**
bare `vim.treesitter.*` restricted to the 7 bundled grammars **works** — do NOT reject it.

### 1.5 External binary dependencies
Shell-outs to `rg`/`fd`/`fzf`/`git`/`make`/`cargo`/`node`/`curl`/`lazygit`. Static tells:
tool names as string literals in job calls; `vim.fn.executable('rg')`/`exepath(...)`
guards; `health.lua` files asserting binaries. (Telescope needs ripgrep + plenary; the
canonical example.)

### 1.6 Remote-plugin hosts
`rplugin/` directory (python3/node/ruby) — **definitive structural signal**;
`:UpdateRemotePlugins`; provider gates `has('python3'|'node'|'ruby')`,
`g:*_host_prog`, `pynvim`. NB: `has('nvim'|'nvim-0.10')` is **benign** version-gating —
do not treat as a disqualifier.

### 1.7 Repo-tree / build artifacts (cheapest, near-zero false-positive)
Reject on: `Cargo.toml`/`*.rs`/`build.rs`, `CMakeLists.txt`/`Makefile`/`*.c`/`*.cpp`,
`package.json`/`*.ts`/`node_modules/`, `*.so`/`*.dll`/`*.dylib`/`*.a`/`*.node`/`*.exe`,
`parser/*.so` + `tree-sitter-*/`, `*.rockspec` (native), `setup.py`/`pyproject.toml`/`*.py`,
`rplugin/`. Plus the installing user's spec: `build = 'make'|'cargo ...'|'npm ...'` (a
non-nvim-command `build` ≈ native/external artifact).

### Declared-requirement signals (most reliable — plugins document for humans)
- **Plugin-manager specs in the README**: lazy.nvim `dependencies = {...}` / packer
  `requires`, `build = ...`. Resolve deps transitively against a known-bad list
  (telescope/mason/lspconfig/nvim-dap/null-ls/gitsigns/…); plenary/nui are *yellow*
  (pure-Lua unless job/curl used). `cmd`/`ft`/`event`/`keys` lazy keys are **benign**.
- **README "Requirements/Prerequisites" prose**: "requires ripgrep/a C compiler/Node/…".
  Whitelist "requires a Nerd Font" (cosmetic, NOT incompatibility) and Neovim version
  gates.
- **`health.lua`**: `executable(...)`/`exepath(...)` checks name required binaries.

### Ecosystem metadata (priors, not gates)
GitHub **language breakdown** (any C/Rust/Go/Zig/TS bytes ≈ strong negative; 100% Lua ≈
weak positive), **topics** (`neovim-colorscheme`/`no-dependencies` positive; `lsp`/`dap`/
`treesitter`/`telescope` negative), awesome-neovim / neovimcraft / dotfyle **categories**
(colorscheme/statusline/editing-support/utility ≈ compatible; lsp/dap/git/ai/fuzzy-finder/
language-support ≈ incompatible).

### Signal strength (strongest → weakest)
1. Native artifacts in the tree · 2. `rplugin/` + provider `has()` · 3. Language breakdown
w/ compiled langs · 4. Source call-sites for spawn/socket/FFI · 5. treesitter-*install* /
nvim-treesitter dep · 6. `build=<non-nvim>` / native rockspec · 7. `executable()` guards +
health.lua · 8. `dependencies` naming known-bad plugins · 9. README prose · 10. category ·
11. topics · 12–15. stars / version gates / Nerd-Font / `has('nvim')` (**benign — exclude**).

---

## 2. What actually happens at runtime in *our* engine (codebase-grounded)

Two JS import namespaces exist (`src/engine/nvim-host.ts:397-407`): stock WASI preview1
(`@bjorn3/browser_wasi_shim`) + a tiny hand-written `env`. **Neither contains any
spawn/exec/dlopen import**, yet the wasm instantiates and boots cleanly — so the
process/PTY/dlopen machinery is **compiled to stubs inside the wasm** (an unresolved
import would `LinkError` at instantiate, which never happens). Confirmed by the prototype
build docs: `process_stubs.c`/`pty_stubs.c` "fail cleanly", PUC Lua 5.1 (no `ffi`).

| Capability | Runtime behavior in our engine | Confidence |
|---|---|---|
| Process spawn / PTY (`jobstart`/`system`/`termopen`) | Stubbed → **fails cleanly** at Lua level (error/empty), catchable; does **not** trap | High |
| FFI (`require('ffi')`) | No module → catchable "not found" | High |
| Native module / dlopen (`package.loadlib`, C `require`) | No dlopen → catchable error | High |
| **Tree-sitter** | **Partially SUPPORTED**: 7 static grammars register w/o dlopen (`c,lua,vim,vimdoc,query,markdown,markdown_inline`); other grammars fail | High |
| Host networking (libuv tcp/udp/spawn) | Not wired → fails cleanly (stub), not via WASI `sock_*` | Med-High |
| WASI `sock_*` (never hit in practice) | Shim **throws** → routes to `onFatal` → module dead (latent, not normal) | High |
| `io.write`/`print` | Made **safe** (won't corrupt the msgpack-RPC stream) | High |

**Key implication:** unsupported operations produce **catchable Lua errors / nvim error
messages**, not hard traps. That makes both static "it will error" prediction and a
dynamic "observe the attempt" test viable. (Exact errno/return values live in the pinned
`nvim-wasi@v0.1.0` artifact — `shims/process_stubs.c` etc. — not derivable from this repo.)

---

## 3. Gaps in the current static heuristics (`marketplace-discovery.ts`)

### 3.1 False POSITIVE — the treesitter over-rejection (fix now)
`{ re: /\bvim\.treesitter\b/ }` rejects ALL treesitter use, but 7 grammars are bundled.
**Narrow it** to parser-*installing* forms: `:TSInstall`/`:TSUpdate`, `nvim-treesitter`
(already in HARD_DEP), `vim.treesitter.language.add('<non-bundled>')`, `parser/*.so`. Stop
rejecting bare `vim.treesitter`.

### 3.2 Missing disqualifier patterns (add)
Network/channels: `sockconnect`, `serverstart`/`serverstop`, `ch_open`/`chansend`,
`require('socket'|'http'|'ssl'|'cjson'|'posix')`. Native: `package.loadlib`,
`package.cpath`. LSP: `vim.lsp.start`/`start_client`. libuv: `getaddrinfo`/`getnameinfo`/
`new_udp`. Hard-deps to add: `null-ls|none-ls|nvim-dap|conform|nvim-lint|gitsigns|
toggleterm|fzf-lua|neo-tree|nvim-tree`. Tree signals to add: `*.node`/`*.dylib`/
`pyproject.toml`/`setup.py`, `rplugin/`.

### 3.3 Structural weaknesses
- **Bounded scan (8 files / 300 KB) silently passes unscanned code** → false negatives on
  large plugins. Fix: prioritize entrypoints (`plugin/*.lua`, `lua/<name>/init.lua`,
  `after/plugin/*`) into the budget; treat "budget exhausted" as **unknown**, not clean,
  for the on-demand path.
- **Comment/string false-positives** and **aliasing false-negatives**
  (`local uv = vim.loop; uv.spawn(...)`) are structural regex limits — only an AST pass or
  the dynamic test fixes them.

### 3.4 Is an AST parser worth it?
Yes, but only for the **on-demand** tier. `luaparse` (pure-JS Lua 5.1, no wasm, callback
`onCreateNode`/`onCreateScope`) walks **call expressions** with light scope/alias
tracking — kills comment/string false-positives and catches aliased calls. Treat a
**parse failure as "unknown", never "clean."** Keep regex for the cheap bulk tier;
Vimscript stays regex (no good browser parser).

---

## 4. The dynamic load-test (the high-fidelity upgrade) — feasible with existing infra

**Interception point = a Lua prelude over the existing RPC channel** (`NvimClient.request`
→ `nvim_exec_lua`), NOT the WASI import object. Reuses `NvimClient` (constructible from the
options page via `chrome.runtime.getURL`), the `configFiles` staging, the compiled-module
IDB cache (compile once), and `dispose()`.

Procedure per candidate:
1. Stage files under `pack/plugins/**opt**/<name>/` (an `opt` variant of `pluginsToConfigFiles`) so nothing auto-loads.
2. Boot clean (`-u NORC --noplugin` + netrw guard), no visible UI (tiny `nvim_ui_attach`).
3. Inject a **recording prelude**: monkey-patch `vim.fn.system`/`systemlist`/`jobstart`/
   `termopen`, `vim.system`, `vim.loop.spawn`/`new_tcp`, `os.execute`, `io.popen`,
   `package.loadlib`, and wrap `require` to record requested module names — each records
   `{api,args}` then returns a benign stub. Force capability probes truthy
   (`vim.fn.executable`/`has`/`exepath`) so guarded branches actually run.
4. `packadd <name>` (load error → RPC rejects → recorded), then best-effort
   `pcall(require('<name>').setup, {})`.
5. Read back `_NIB` (`return vim.json.encode(_NIB)`); optionally `:checkhealth <name>` +
   grep the health buffer for ERROR/WARNING.
6. Classify with **reasons** ("attempts `jobstart` in `lua/foo/git.lua`"); `dispose()` with
   a per-test timeout + reuse the 700 MB memory watchdog. Treat `onFatal`/boot-crash as
   "incompatible (hard crash)".

Cost: one Worker + wasm instance per candidate; warm cache → a few hundred ms–~1.5 s.
**On-demand only** (Install / a "Verify compatibility" button), never the 50-candidate scan.
Limitation: only observes executed paths (lazy plugins that act only on a command may show
no attempts — combine with static as a risk flag). No `worker.ts`/`nvim-host.ts` changes
needed.

---

## 5. Recommended staged architecture

- **Tier 0 — Metadata prior** (exists, `metadataOk`) + add language-breakdown hard-reject
  on C/Rust/Go/Zig + category prior. One API field, no fetch.
- **Tier 1 — Git-tree scan** (exists, `treeHasNativeSignals`) + add `*.node`/`*.dylib`/
  `pyproject.toml`/`setup.py`/`rplugin/`/`parser/`. Cheap, near-perfect for native.
- **Tier 2 — Static regex scan** (exists, `sourceDisqualifier`), bulk, in the options page:
  apply §3.1 (narrow treesitter) + §3.2 (missing patterns) + §3.3 (entrypoint-first budget;
  "exhausted = unknown"). A hit **downgrades confidence**, doesn't necessarily hard-reject.
- **Tier 3 — On-demand AST + dynamic load-test** (NEW): on Install / "Verify", run the
  luaparse AST pass then the recording-prelude boot. Definitive, reasoned verdict; catches
  aliasing/optional-path cases Tier 2 can't and rehabilitates false-positives (e.g. a
  bundled-grammar treesitter plugin).
- **Verdict = 5 tiers** (Verified / Very likely / Likely / Risky / Incompatible) with
  reasons; any confirmed native/FFI/forbidden-call is a hard floor to Incompatible.

## 6. The honest ceiling
Undecidable in general (Rice). The `if executable('rg') then jobstart(...)` optional-path
pattern caps static precision and dynamic recall simultaneously. Obfuscated/dynamic
dispatch defeats static analysis. The sandbox's capabilities drift (e.g. bundled
grammars). So: automated pipeline = excellent **filter + prioritizer** for the easy ~80%;
the ambiguous middle needs **curated allow/deny overrides** and **community "works/doesn't"
reports** feeding back — designed in, not treated as failure. Present tiers + reasons, not a
binary.

---

## Sources
Neovim docs (job_control, provider, remote_plugin, treesitter, health); lazy.nvim spec;
awesome-neovim / neovimcraft / dotfyle; selene/full-moon, luaparse, web-tree-sitter +
tree-sitter-lua; plenary/mini.test harnesses. Codebase: `src/engine/{nvim-host,client,
worker,rpc}.ts`, `src/engine-frame/engine-frame.ts`, `src/plugins/{marketplace-discovery,
pack-layout}.ts`, `docs/superpowers/plans/2026-07-1[45]-*prototype*.md`, `engine.lock.json`.
Exact stub errno semantics: the pinned `nvim-wasi@v0.1.0` artifact (`shims/*_stubs.c`).
