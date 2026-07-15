import { describe, expect, it } from "vitest";
import { serializeError } from "./scratch-store";

describe("serializeError", () => {
  it("uses an Error's message", () => {
    expect(serializeError(new Error("quota exceeded"))).toBe("quota exceeded");
  });
  it("reads a DOMException-like name/message", () => {
    expect(serializeError({ name: "QuotaExceededError", message: "no space" })).toContain("no space");
  });
  it("falls back to String() for unknown shapes", () => {
    expect(serializeError(42)).toBe("42");
  });
});
