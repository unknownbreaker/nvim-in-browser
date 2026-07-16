// Only the pure isSafePluginName validator is unit-tested; vitest's node env has
// no IndexedDB, so the plugin store's IDB round-trip is proven by the browser
// smoke (PHASE F), not here — mirroring config-store.test.ts.
import { describe, expect, it } from "vitest";
import { isSafePluginName } from "./plugin-store";

describe("isSafePluginName", () => {
  it("accepts a normal repo name", () => {
    expect(isSafePluginName("mini.nvim")).toBe(true);
  });
  it("accepts hyphens and underscores", () => {
    expect(isSafePluginName("vim-surround_2")).toBe(true);
  });
  it("rejects a path separator", () => {
    expect(isSafePluginName("a/b")).toBe(false);
  });
  it("rejects a parent-directory name", () => {
    expect(isSafePluginName("..")).toBe(false);
  });
  it("rejects a single dot", () => {
    expect(isSafePluginName(".")).toBe(false);
  });
  it("rejects empty", () => {
    expect(isSafePluginName("")).toBe(false);
  });
  it("rejects spaces / other chars", () => {
    expect(isSafePluginName("bad name")).toBe(false);
  });
});
