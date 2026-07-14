import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { untar } from "./untar";

function makeTar(): Uint8Array {
  const dir = mkdtempSync(path.join(tmpdir(), "untar-test-"));
  mkdirSync(path.join(dir, "runtime/lua"), { recursive: true });
  writeFileSync(path.join(dir, "runtime/hello.txt"), "hello nvim\n");
  writeFileSync(path.join(dir, "runtime/lua/init.lua"), "-- lua\n");
  const tarPath = path.join(dir, "out.tar");
  execFileSync("tar", ["-cf", tarPath, "-C", dir, "runtime"]);
  return new Uint8Array(readFileSync(tarPath));
}

describe("untar", () => {
  it("extracts files and directories with correct contents", () => {
    const entries = untar(makeTar());
    const file = entries.find((e) => e.path === "runtime/hello.txt");
    expect(file?.type).toBe("file");
    expect(new TextDecoder().decode(file!.data)).toBe("hello nvim\n");
    expect(entries.some((e) => e.path.replace(/\/$/, "") === "runtime/lua" && e.type === "dir")).toBe(true);
    expect(entries.find((e) => e.path === "runtime/lua/init.lua")).toBeTruthy();
  });

  it("returns empty for empty archive terminator", () => {
    expect(untar(new Uint8Array(1024))).toEqual([]);
  });
});
