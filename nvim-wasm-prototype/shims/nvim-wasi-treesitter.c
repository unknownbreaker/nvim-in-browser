/* shims/nvim-wasi-treesitter.c
 *
 * WHAT: The static tree-sitter parser registry for the WASI build. WASI has
 * no dlopen, so the parsers Neovim normally loads at runtime from
 * parser/<lang>.so are linked into the binary (the 6 archives pinned from
 * Neovim's own cmake.deps manifest: c, lua, vim, vimdoc, query, markdown —
 * the markdown archive exports BOTH the block and inline grammars, 7
 * grammars total). This TU exports a {name, constructor} table that a small
 * __wasi__-guarded hunk in src/nvim/lua/treesitter.c's tslua_init()
 * (patches/neovim-ts-static.patch) walks to pre-register every grammar in
 * the process-global language map, so vim.treesitter.language.add('<lang>')
 * hits the vim._ts_has_language() fast path and never consults the runtime
 * path or dlopen.
 *
 * WHY A SEPARATE TU: (1) the language map is file-static in treesitter.c, so
 * registration must happen there, but the parser list is a build-wiring
 * detail that belongs with the shims, not in the patch; (2) referencing all
 * 7 tree_sitter_*() constructors here is what forces wasm-ld to extract the
 * parser archive members at link time (no --whole-archive tricks needed —
 * treesitter.c references this table, this table references the parsers).
 *
 * CLEAN-ROOM PROVENANCE: parser constructor signature
 * (`const TSLanguage *tree_sitter_<name>(void)`) from the tree-sitter
 * generated-parser convention as seen in the pinned grammar sources
 * (src-cache/treesitter_<lang>, each src/parser.c) and tree-sitter's own
 * docs/headers. No excluded project (MuNeNICK/nvim-wasm or
 * monaco-neovim-wasm) was consulted in any form.
 */

#include <stddef.h>

typedef struct TSLanguage TSLanguage;

typedef struct {
  const char *name;
  const TSLanguage *(*fn)(void);
} NvimWasiTsStaticLang;

extern const TSLanguage *tree_sitter_c(void);
extern const TSLanguage *tree_sitter_lua(void);
extern const TSLanguage *tree_sitter_vim(void);
extern const TSLanguage *tree_sitter_vimdoc(void);
extern const TSLanguage *tree_sitter_query(void);
extern const TSLanguage *tree_sitter_markdown(void);
extern const TSLanguage *tree_sitter_markdown_inline(void);

const NvimWasiTsStaticLang nvim_wasi_ts_static_langs[] = {
  { "c", tree_sitter_c },
  { "lua", tree_sitter_lua },
  { "vim", tree_sitter_vim },
  { "vimdoc", tree_sitter_vimdoc },
  { "query", tree_sitter_query },
  { "markdown", tree_sitter_markdown },
  { "markdown_inline", tree_sitter_markdown_inline },
};

const size_t nvim_wasi_ts_static_langs_count =
    sizeof(nvim_wasi_ts_static_langs) / sizeof(nvim_wasi_ts_static_langs[0]);
