import { describe, expect, it } from "vitest";
import { fetchGithubPlugin, GithubFetchError, MAX_FILES } from "./github-fetch";

// Build a fake fetch that answers the tree API then raw file requests.
function fakeFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [frag, make] of Object.entries(handlers)) {
      if (url.includes(frag)) return make();
    }
    throw new TypeError("network");
  }) as unknown as typeof fetch;
}

const treeJson = (tree: { path: string; type: string; size?: number }[]) =>
  new Response(JSON.stringify({ tree, truncated: false }), { status: 200 });

describe("fetchGithubPlugin", () => {
  it("fetches only allowed text files and returns their bytes", async () => {
    const f = fakeFetch({
      "api.github.com": () =>
        treeJson([
          { path: "plugin/foo.lua", type: "blob", size: 10 },
          { path: "README.md", type: "blob", size: 10 },
          { path: "assets/logo.png", type: "blob", size: 10 },
          { path: "doc/foo.txt", type: "blob", size: 10 },
          { path: "lua", type: "tree" },
        ]),
      "raw.githubusercontent.com/o/r/main/plugin/foo.lua": () =>
        new Response("vim.g.x = 1", { status: 200 }),
      "raw.githubusercontent.com/o/r/main/doc/foo.txt": () =>
        new Response("help", { status: 200 }),
    });
    const { files } = await fetchGithubPlugin("o/r", "main", f);
    expect(files.map((x) => x.path).sort()).toEqual(["doc/foo.txt", "plugin/foo.lua"]);
    const foo = files.find((x) => x.path === "plugin/foo.lua");
    expect(new TextDecoder().decode(foo!.data)).toBe("vim.g.x = 1");
  });

  it("throws repo-not-found on a 404 tree", async () => {
    const f = fakeFetch({ "api.github.com": () => new Response("", { status: 404 }) });
    await expect(fetchGithubPlugin("o/r", "main", f)).rejects.toMatchObject({ kind: "repo-not-found" });
  });

  it("throws rate-limited on a 403 with no remaining quota", async () => {
    const f = fakeFetch({
      "api.github.com": () =>
        new Response("", { status: 403, headers: { "X-RateLimit-Remaining": "0" } }),
    });
    await expect(fetchGithubPlugin("o/r", "main", f)).rejects.toMatchObject({ kind: "rate-limited" });
  });

  it("refuses a repo over the file-count cap before fetching blobs", async () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      path: `plugin/f${i}.lua`,
      type: "blob",
      size: 1,
    }));
    const f = fakeFetch({ "api.github.com": () => treeJson(many) });
    await expect(fetchGithubPlugin("o/r", "main", f)).rejects.toMatchObject({ kind: "too-large" });
  });

  it("surfaces a network error as kind network", async () => {
    const f = fakeFetch({});
    const err = await fetchGithubPlugin("o/r", "main", f).catch((e) => e);
    expect(err).toBeInstanceOf(GithubFetchError);
    expect(err.kind).toBe("network");
  });
});
