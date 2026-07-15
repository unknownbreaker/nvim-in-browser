import { defineConfig } from "vitest/config";

// Scope test discovery to the real source tree. Without this, vitest's
// default discovery walks the whole repo and picks up the tree-sitter test
// suites vendored (gitignored) under nvim-wasm-prototype/src-cache/ by the
// prototype build pipeline (scripts/fetch-sources.sh) — those suites belong
// to an upstream dependency's own build tree, aren't wired up to run here,
// and fail with module-resolution errors on any machine that has run the
// prototype pipeline.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
