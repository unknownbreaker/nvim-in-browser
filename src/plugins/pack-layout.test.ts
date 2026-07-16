import { describe, expect, it } from "vitest";
import { pluginsToConfigFiles, PACK_BASE } from "./pack-layout";
import type { PluginRecord } from "../storage/plugin-store";

const rec = (name: string, enabled: boolean, files: string[]): PluginRecord => ({
  name,
  source: "upload",
  enabled,
  addedAt: 0,
  files: files.map((path) => ({ path, data: new TextEncoder().encode(path) })),
});

describe("pluginsToConfigFiles", () => {
  it("maps an enabled plugin's files to absolute site-pack paths", () => {
    const out = pluginsToConfigFiles([rec("mini.nvim", true, ["plugin/mini.lua", "lua/mini/init.lua"])]);
    expect(out.map((f) => f.path)).toEqual([
      `${PACK_BASE}mini.nvim/plugin/mini.lua`,
      `${PACK_BASE}mini.nvim/lua/mini/init.lua`,
    ]);
  });
  it("carries the file bytes through unchanged", () => {
    const out = pluginsToConfigFiles([rec("foo", true, ["plugin/foo.lua"])]);
    expect(new TextDecoder().decode(out[0].data)).toBe("plugin/foo.lua");
  });
  it("excludes disabled plugins", () => {
    const out = pluginsToConfigFiles([
      rec("on", true, ["plugin/a.lua"]),
      rec("off", false, ["plugin/b.lua"]),
    ]);
    expect(out.map((f) => f.path)).toEqual([`${PACK_BASE}on/plugin/a.lua`]);
  });
  it("returns empty for no plugins", () => {
    expect(pluginsToConfigFiles([])).toEqual([]);
  });
});
