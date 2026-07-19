# Treesitter Grammar Packs (Option A) — Design Spec

*2026-07-19. Add user-selectable treesitter language support via curated engine
variants ("grammar packs") that statically link additional grammars, so
composite languages (Vue/Svelte/JSX, HTML+JS+CSS, markdown code fences) highlight
correctly via native nvim treesitter injection. Companion to
`docs/research/2026-07-17-plugin-compatibility-detection.md` and the v0.23.0
treesitter auto-start.*

## Goal

Let the user pick which languages get treesitter highlighting, delivered as
**separate engine builds** (grammar packs) the extension selects + boots — not a
single ever-growing engine, and not per-grammar runtime hot-loading (impossible:
tree-sitter's wasm loader needs wasmtime, which can't run inside the sandbox).

## Why Option A (static packs) over host-side web-tree-sitter (Option B)

Composite languages compose via **injection**, a native nvim treesitter feature:
an injecting grammar (vue/svelte/html/markdown) delegates embedded regions to
base grammars (js/ts/css) at runtime, and nvim recurses for you — **but only if
the base grammars are linked into the same engine.** Option A links them together,
so injection "just works." Option B would require re-implementing injection in JS.
Trade-off: Option A means curated variants + bigger downloads and rides the engine
release cadence; it gives full-fidelity treesitter (highlight + indent + folds +
textobjects + injection), which Option B can't.

## The "web" pack (first pack)

Bases (do the heavy lifting): `html`, `css`, `javascript`, `typescript`, `tsx`,
`json`, `yaml`. Injectors (small, delegate to bases): `vue`, `svelte`, `astro`.
Optional companions: `python`, `bash`, `graphql`. All target grammars are
MIT-licensed (permissive — fits the [[nvim-wasi-repo]] Apache-2.0/permissive-only
license gate; each must be re-verified at build time).

Filetype → treesitter-lang mappings needed (nvim defaults cover most; the rest via
`vim.treesitter.language.register`): `javascriptreact`→`javascript` (JSX is in the
js grammar), `typescriptreact`→`tsx`, `vue`→`vue`, `svelte`→`svelte`,
`astro`→`astro`.

## Engine side (nvim-wasi repo)

Mechanism already exists (used for the 7 bundled grammars):
1. **Compile each grammar**: clang the generated `parser.c` (+ `scanner.c` where
   present — js/ts/html/css have one) with the wasi toolchain → `libtree-sitter-
   <lang>.a` (static, position-dependent, same as the current 6× archives).
2. **Reference the symbols**: add `{name, tree_sitter_<lang>}` rows to the table in
   `shims/nvim-wasi-treesitter.c` (this is what forces wasm-ld to pull the parser
   archive members in). Link the new archives into the engine.
3. **Ship the queries** (THE step people forget — a parser with no queries gives a
   tree but no colors): add `queries/<lang>/highlights.scm`, `injections.scm`,
   `indents.scm` into the engine runtime tarball, sourced from the grammar repos or
   nvim-treesitter (verify query license is permissive). The `injections.scm` of
   html/vue/svelte/astro/markdown is what makes composite highlighting work.
4. **Build as a VARIANT**: produce a second asyncified artifact (e.g.
   `nvim-asyncify-web.wasm` + `nvim-runtime-web.tar.gz`) that is a SUPERSET of base
   (7 grammars + the web pack). Keep base as-is. The nvim-wasi ROADMAP already
   flags making grammars build-time opt-in — this formalizes it as named variants.
5. **Parity check**: extend the existing treesitter parity test — assert each web
   grammar registers, and that INJECTION works (parse a `.vue` fixture, assert the
   `<script>` region's tree is `javascript` and `<style>` is `css`).
6. **Release**: cut an nvim-wasi release publishing both variants' artifacts +
   hashes; `ENGINE-API.md` documents the variant list + each variant's grammar set.

Size budget: the 7 base grammars add ~2.8 MB asyncified; the web bases (js/ts/tsx
are the big ones) likely add ~1.5–3 MB, injectors are small. Estimate the web
variant at ~13–14 MB total vs base ~11 MB.

## Extension side

**Engine selection.** `engine.lock.json` grows a `variants` map (`base`, `web`)
each with `{wasm, runtime, sha256}`. `scripts/fetch-engine.mjs` + `build.mjs` stage
the selected variant(s) into dist. `engine-frame`'s `makeClient()` picks the wasm +
runtime URL for the active variant; the compiled-module IDB cache key becomes
`version + variant` so each variant caches independently.

**Packaging (phased — see below).** Phase 2 bundles base + web in the extension
(simplest, everyone's install grows). Phase 3 keeps base bundled and fetches heavier
packs on demand from **public** hosting (the nvim-wasi releases would need to be
public, or a public CDN — same hosting decision as the marketplace manifest),
cached in IDB, so users only download the pack they enable. Recommend shipping
Phase 2 first.

**Languages settings group.** A new options pane (a rail item "Languages", peer of
Config/Plugins/Overview/Advanced) listing the packs with a toggle + what each
includes + its size. Selection persisted (a `nib:enabledPacks` setting). Base is
always on. Changing the selection prompts "reload your editor tab to apply" (the
variant is chosen at boot, like config).

**Boot + auto-start.** `resolveBoot`/engine-frame reads the enabled pack → boots
that variant. The v0.23.0 treesitter auto-start's BUNDLED filetype set becomes
variant-aware: when the web variant is active, the FileType autocmd also starts
treesitter for html/css/js/ts/tsx/vue/svelte/astro/json/yaml (or, simpler, attempt
`pcall(vim.treesitter.start)` for any filetype and let a missing grammar no-op —
the pcall already handles that; keying off the known set just avoids futile
attempts).

**Filetype detection.** Overlay/scratch buffers are unnamed, so filetype comes from
`filetypeForHost` (host→ft map) or the user's `:set ft`. Add common web-editing
hosts to the map (e.g. a code sandbox → the right ft) and document `:set ft=vue`
etc. for the scratch page. (Not a blocker — highlighting activates once the ft is
set, by whatever means.)

## Verification plan

- **Engine (nvim-wasi):** the extended parity check (grammars register + injection
  splits a `.vue` into js/css/html regions) must pass in `test/parity-check.mjs`.
- **Extension:** (1) selecting the web pack boots `nvim-asyncify-web.wasm` (assert
  the loaded variant); (2) with web active, `:set ft=typescriptreact` → treesitter
  highlighter active and the tree's root lang is `tsx`; (3) a `.vue` buffer → the
  injected `<script>` region highlights as js (assert an extmark/`@` capture, or
  that `vim.treesitter.get_parser():children()` includes a `javascript` child);
  (4) base-only install unaffected (regression). Model on the existing
  browser-smoke + the v0.23.0 ts-check.

## Phasing

1. **Engine** (nvim-wasi): add web-pack grammars + queries + variant build + parity
   check; release; document variants. *(Prerequisite — nothing ships in the
   extension without it.)*
2. **Extension MVP**: variant-aware engine.lock/fetch/build (bundle base + web),
   `makeClient` variant selection + cache key, Languages settings pane, persisted
   selection + reload prompt, variant-aware treesitter auto-start. Release.
3. **On-demand packs** (optional): public hosting of pack variants + fetch-on-enable
   + cache, so the base install stays small and more packs can be added without
   bloating every user.

## Open questions / risks

- **Hosting for on-demand (Phase 3):** the nvim-wasi repo is private, so fetching a
  variant without the user's token needs a public home (public release/CDN) — the
  same decision deferred from the marketplace. Phase 2 (bundled) avoids it.
- **Grammar + query licenses:** must all be permissive (MIT/Apache/ISC) to satisfy
  the nvim-wasi clean-room gate; verify each at build time (grammars are MIT;
  nvim-treesitter queries are Apache-2.0 — check the specific query files used).
- **Size:** bundling the web variant grows the extension ~2–3 MB (Phase 2); Phase 3
  fixes this for users who don't enable it.
- **Renderer fidelity:** the canvas renderer applies colors but not bold/italic/
  underline (pre-existing) — themes/highlights differ by color, not font style.
- **Grammar drift:** grammars pin to versions; a grammar update needs an engine
  rebuild + re-release (the release cadence cost inherent to Option A).
