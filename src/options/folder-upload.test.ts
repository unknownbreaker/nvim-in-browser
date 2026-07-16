// Only the pure toUploadRelpath transform is unit-tested; readFolderUpload needs
// a browser File/FileList and is exercised via the options page + manual QA.
import { describe, expect, it } from "vitest";
import { toUploadRelpath } from "./folder-upload";

describe("toUploadRelpath", () => {
  it("strips the top-level folder segment", () => {
    expect(toUploadRelpath("mycfg/lua/opts.lua")).toBe("lua/opts.lua");
  });
  it("handles a file directly under the top folder", () => {
    expect(toUploadRelpath("mycfg/init.lua")).toBe("init.lua");
  });
  it("returns null for a top-folder-only path (no file part)", () => {
    expect(toUploadRelpath("mycfg/")).toBe(null);
  });
  it("returns null when the stripped path is unsafe", () => {
    expect(toUploadRelpath("mycfg/../evil")).toBe(null);
  });
  it("returns null for an empty string", () => {
    expect(toUploadRelpath("")).toBe(null);
  });
});
