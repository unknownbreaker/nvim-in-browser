// Only the pure isSafeRelpath validator is unit-tested here; vitest's node env
// has no IndexedDB, so the config store's IDB round-trip (loadFiles/saveFile/
// clear/getMeta/setMeta) is exercised by Task 5's browser smoke, not here.
import { describe, expect, it } from "vitest";
import { isSafeRelpath } from "./config-store";

describe("isSafeRelpath", () => {
  it("accepts a plain filename", () => {
    expect(isSafeRelpath("init.lua")).toBe(true);
  });
  it("accepts a nested relpath", () => {
    expect(isSafeRelpath("lua/foo.lua")).toBe(true);
  });
  it("rejects a parent-directory escape", () => {
    expect(isSafeRelpath("../evil")).toBe(false);
  });
  it("rejects an absolute path", () => {
    expect(isSafeRelpath("/abs")).toBe(false);
  });
  it("rejects a mid-path parent-directory segment", () => {
    expect(isSafeRelpath("a/../../b")).toBe(false);
  });
  it("rejects characters outside the allowed set", () => {
    expect(isSafeRelpath("bad name!")).toBe(false);
  });
});
