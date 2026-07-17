import { describe, expect, it } from "vitest";
import {
  categoryForTopics,
  discoverMarketplace,
  metadataOk,
  sourceDisqualifier,
  treeHasNativeSignals,
} from "./marketplace-discovery";

describe("treeHasNativeSignals", () => {
  it("flags a Cargo.toml", () => {
    expect(treeHasNativeSignals(["lua/foo.lua", "Cargo.toml"])).toBe(true);
  });
  it("flags Makefile / CMakeLists.txt / package.json / build.lua by basename", () => {
    expect(treeHasNativeSignals(["Makefile"])).toBe(true);
    expect(treeHasNativeSignals(["CMakeLists.txt"])).toBe(true);
    expect(treeHasNativeSignals(["package.json"])).toBe(true);
    expect(treeHasNativeSignals(["build.lua"])).toBe(true);
  });
  it("flags a compiled shared object anywhere (incl. a parser dir)", () => {
    expect(treeHasNativeSignals(["parser/lua.so"])).toBe(true);
    expect(treeHasNativeSignals(["build/foo.dll"])).toBe(true);
    expect(treeHasNativeSignals(["x.dylib"])).toBe(true);
    expect(treeHasNativeSignals(["addon.node"])).toBe(true);
    expect(treeHasNativeSignals(["grammar.wasm"])).toBe(true);
  });
  it("passes a plain Lua tree and plain treesitter queries (*.scm only)", () => {
    expect(
      treeHasNativeSignals([
        "plugin/foo.vim",
        "lua/foo/init.lua",
        "queries/lua/highlights.scm",
        "doc/foo.txt",
      ]),
    ).toBe(false);
  });
});

describe("sourceDisqualifier", () => {
  it("flags process/shell signals", () => {
    expect(sourceDisqualifier("vim.fn.jobstart({'ls'})")).toBe("jobstart");
    expect(sourceDisqualifier("local r = vim.fn.system('ls')")).toBe("vim.fn.system");
    expect(sourceDisqualifier("os.execute('rm -rf x')")).toBe("os.execute");
    expect(sourceDisqualifier("local h = io.popen('date')")).toBe("io.popen");
    expect(sourceDisqualifier("vim.system({'git'})")).toBe("vim.system");
  });
  it("flags libuv host networking / spawn", () => {
    expect(sourceDisqualifier("vim.loop.new_tcp()")).toBe("libuv");
    expect(sourceDisqualifier("uv.spawn('node', {})")).toBe("libuv");
    expect(sourceDisqualifier("vim.uv.new_udp()")).toBe("libuv");
  });
  it("flags ffi", () => {
    expect(sourceDisqualifier("local ffi = require('ffi')")).toBe("ffi");
    expect(sourceDisqualifier('local ffi = require("ffi")')).toBe("ffi");
  });
  it("flags vim.treesitter (needs compiled parsers)", () => {
    expect(sourceDisqualifier("vim.treesitter.get_parser(0)")).toBe("vim.treesitter");
  });
  it("flags hard deps that won't load, returning the dep name", () => {
    expect(sourceDisqualifier("local p = require('plenary.async')")).toBe("plenary");
    expect(sourceDisqualifier("require('telescope').setup{}")).toBe("telescope");
    expect(sourceDisqualifier("require('nvim-treesitter.configs')")).toBe("nvim-treesitter");
    expect(sourceDisqualifier("require('mason')")).toBe("mason");
    expect(sourceDisqualifier("require('lspconfig')")).toBe("lspconfig");
  });
  it("returns null for clean pure-Lua source", () => {
    expect(
      sourceDisqualifier("local M = {}\nfunction M.setup(o) vim.o.number = true end\nreturn M"),
    ).toBeNull();
  });
});

describe("categoryForTopics", () => {
  it("maps colorscheme/theme -> Theme", () => {
    expect(categoryForTopics(["colorscheme"], "")).toBe("Theme");
    expect(categoryForTopics([], "A dark theme")).toBe("Theme");
  });
  it("maps statusline/tabline/bufferline -> UI", () => {
    expect(categoryForTopics(["statusline"], "")).toBe("UI");
    expect(categoryForTopics([], "A bufferline plugin")).toBe("UI");
  });
  it("maps comment/pairs/surround/motion/text -> Editing", () => {
    expect(categoryForTopics(["comment"], "")).toBe("Editing");
    expect(categoryForTopics([], "auto pairs")).toBe("Editing");
    expect(categoryForTopics(["surround"], "")).toBe("Editing");
  });
  it("maps which-key/keybinding/ui -> UX", () => {
    expect(categoryForTopics(["which-key"], "")).toBe("UX");
    expect(categoryForTopics([], "shows keybindings")).toBe("UX");
  });
  it("falls back to Plugin", () => {
    expect(categoryForTopics(["neovim"], "does a thing")).toBe("Plugin");
  });
});

describe("metadataOk", () => {
  const base = { archived: false, fork: false, size: 100, stargazers_count: 100, description: "x" };
  it("accepts a healthy repo", () => {
    expect(metadataOk(base)).toBe(true);
  });
  it("rejects archived / fork", () => {
    expect(metadataOk({ ...base, archived: true })).toBe(false);
    expect(metadataOk({ ...base, fork: true })).toBe(false);
  });
  it("rejects too-few stars (< 30)", () => {
    expect(metadataOk({ ...base, stargazers_count: 29 })).toBe(false);
    expect(metadataOk({ ...base, stargazers_count: 30 })).toBe(true);
  });
  it("rejects too-large repos (>= 10240 KB)", () => {
    expect(metadataOk({ ...base, size: 10240 })).toBe(false);
    expect(metadataOk({ ...base, size: 10239 })).toBe(true);
  });
  it("rejects empty/missing description", () => {
    expect(metadataOk({ ...base, description: "" })).toBe(false);
    expect(metadataOk({ ...base, description: "   " })).toBe(false);
    expect(metadataOk({ ...base, description: null })).toBe(false);
  });
});

// --- discoverMarketplace with an injected fetch mock ------------------------

interface RepoFixture {
  full_name: string;
  description: string;
  topics?: string[];
  stargazers_count?: number;
  size?: number;
  archived?: boolean;
  fork?: boolean;
  tree: string[]; // full tree paths
  raw?: Record<string, string>; // path -> source text
}

// Build a substring-routed fetch mock from a set of repo fixtures. The search
// endpoint returns all repos; each repo's tree + raw files are served by path.
function mockFetch(
  repos: RepoFixture[],
  opts: { rateLimitTree?: string } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/search/repositories")) {
      // Only page 1 has items; page 2 returns empty so the loop stops.
      const page2 = /[?&]page=2\b/.test(url);
      const items = page2
        ? []
        : repos.map((r) => ({
            full_name: r.full_name,
            description: r.description,
            topics: r.topics ?? [],
            stargazers_count: r.stargazers_count ?? 100,
            size: r.size ?? 100,
            archived: r.archived ?? false,
            fork: r.fork ?? false,
            default_branch: "main",
          }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    // Tree endpoint: /repos/{owner}/{name}/git/trees/main?recursive=1
    const treeMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/git\/trees\//);
    if (treeMatch) {
      const full = `${treeMatch[1]}/${treeMatch[2]}`;
      if (opts.rateLimitTree === full) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "X-RateLimit-Remaining": "0" },
        });
      }
      const repo = repos.find((r) => r.full_name === full);
      const tree = (repo?.tree ?? []).map((p) => ({ path: p, type: "blob" }));
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    // Raw file: raw.githubusercontent.com/{owner}/{name}/main/{path}
    const rawMatch = url.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/main\/(.+)$/);
    if (rawMatch) {
      const full = `${rawMatch[1]}/${rawMatch[2]}`;
      const path = rawMatch[3];
      const repo = repos.find((r) => r.full_name === full);
      const text = repo?.raw?.[path];
      if (text === undefined) return new Response("not found", { status: 404 });
      return new Response(text, { status: 200 });
    }
    return new Response("unhandled", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("discoverMarketplace", () => {
  it("keeps a clean repo, drops native-signal and jobstart repos", async () => {
    const fetchImpl = mockFetch([
      {
        full_name: "clean/good.nvim",
        description: "A clean colorscheme",
        topics: ["colorscheme"],
        stargazers_count: 500,
        tree: ["lua/good/init.lua", "plugin/good.vim"],
        raw: { "lua/good/init.lua": "local M = {} return M", "plugin/good.vim": '" ok' },
      },
      {
        full_name: "native/bad.nvim",
        description: "Has a Cargo.toml",
        stargazers_count: 400,
        tree: ["lua/bad.lua", "Cargo.toml"],
        raw: { "lua/bad.lua": "local M = {} return M" },
      },
      {
        full_name: "spawn/ugly.nvim",
        description: "Spawns processes",
        stargazers_count: 300,
        tree: ["lua/ugly.lua"],
        raw: { "lua/ugly.lua": "vim.fn.jobstart({'ls'})" },
      },
    ]);
    const { plugins, rateLimited, scanned } = await discoverMarketplace({
      token: "t",
      fetchImpl,
    });
    expect(rateLimited).toBe(false);
    expect(scanned).toBe(3);
    expect(plugins.map((p) => p.repo)).toEqual(["clean/good.nvim"]);
    expect(plugins[0]).toMatchObject({
      name: "good.nvim",
      category: "Theme",
      stars: 500,
      blurb: "A clean colorscheme",
    });
  });

  it("respects the budget", async () => {
    const repos: RepoFixture[] = Array.from({ length: 5 }, (_, i) => ({
      full_name: `owner/p${i}.nvim`,
      description: `plugin ${i}`,
      stargazers_count: 1000 - i, // descending so order is deterministic
      tree: [`lua/p${i}.lua`],
      raw: { [`lua/p${i}.lua`]: "local M = {} return M" },
    }));
    const { plugins } = await discoverMarketplace({ token: "t", budget: 2, fetchImpl: mockFetch(repos) });
    expect(plugins.length).toBe(2);
    // Highest-star repos come first (stars order preserved).
    expect(plugins.map((p) => p.repo)).toEqual(["owner/p0.nvim", "owner/p1.nvim"]);
  });

  it("sets rateLimited when a tree request 403s on rate limit", async () => {
    const repos: RepoFixture[] = [
      {
        full_name: "a/one.nvim",
        description: "one",
        stargazers_count: 900,
        tree: ["lua/one.lua"],
        raw: { "lua/one.lua": "local M = {} return M" },
      },
      {
        full_name: "b/two.nvim",
        description: "two",
        stargazers_count: 800,
        tree: ["lua/two.lua"],
        raw: { "lua/two.lua": "local M = {} return M" },
      },
    ];
    // Force the rate limit on the SECOND repo's tree, with concurrency 1 so the
    // first is vetted before the limit trips.
    const { plugins, rateLimited } = await discoverMarketplace({
      token: "t",
      budget: 10,
      fetchImpl: mockFetch(repos, { rateLimitTree: "b/two.nvim" }),
    });
    expect(rateLimited).toBe(true);
    // The clean first repo is still returned (partial list).
    expect(plugins.map((p) => p.repo)).toContain("a/one.nvim");
    expect(plugins.map((p) => p.repo)).not.toContain("b/two.nvim");
  });
});
