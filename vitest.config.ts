import { defineConfig } from "vitest/config";

// Scope test discovery to the real source tree so vitest only runs the
// extension's own unit suites (src/**/*.test.ts) and never wanders into any
// stray test files under vendored/gitignored trees.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
