import { describe, expect, it } from "vitest";
import { fetchGithubPlugin, GithubFetchError, MAX_FILES } from "./github-fetch";

// Substring-routed fake fetch (no token cases — only the tree + raw are hit).
function fakeFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [frag, make] of Object.entries(handlers)) {
      if (url.includes(frag)) return make();
    }
    throw new TypeError("network");
  }) as unknown as typeof fetch;
}

// Recording fake fetch: routes by a handler fn AND records every (url, init) so
// tests can assert on request headers (used for the token cases).
function recordingFetch(handler: (url: string) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const treeJson = (tree: { path: string; type: string; size?: number; sha?: string }[]) =>
  new Response(JSON.stringify({ tree, truncated: false }), { status: 200 });

function authOf(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

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
    const { files } = await fetchGithubPlugin("o/r", "main", { fetchImpl: f });
    expect(files.map((x) => x.path).sort()).toEqual(["doc/foo.txt", "plugin/foo.lua"]);
    const foo = files.find((x) => x.path === "plugin/foo.lua");
    expect(new TextDecoder().decode(foo!.data)).toBe("vim.g.x = 1");
  });

  it("skips non-runtime directories but keeps runtime modules", async () => {
    const f = fakeFetch({
      "api.github.com": () =>
        treeJson([
          { path: "lua/foo.lua", type: "blob", size: 5 },
          { path: "lua/mini/test.lua", type: "blob", size: 5 }, // runtime module — kept
          { path: "tests/foo_spec.lua", type: "blob", size: 5 }, // excluded
          { path: "extras/kitty.lua", type: "blob", size: 5 }, // excluded
          { path: ".github/gen.lua", type: "blob", size: 5 }, // excluded
          { path: "screenshots/demo.lua", type: "blob", size: 5 }, // excluded
        ]),
      "raw.githubusercontent.com/o/r/main/lua/foo.lua": () => new Response("a", { status: 200 }),
      "raw.githubusercontent.com/o/r/main/lua/mini/test.lua": () =>
        new Response("b", { status: 200 }),
    });
    const { files } = await fetchGithubPlugin("o/r", "main", { fetchImpl: f });
    expect(files.map((x) => x.path).sort()).toEqual(["lua/foo.lua", "lua/mini/test.lua"]);
  });

  it("skips tree blobs whose path is not a safe relpath", async () => {
    const f = fakeFetch({
      "api.github.com": () =>
        treeJson([
          { path: "plugin/ok.lua", type: "blob", size: 5 },
          { path: "../evil.lua", type: "blob", size: 5 },
        ]),
      "raw.githubusercontent.com/o/r/main/plugin/ok.lua": () =>
        new Response("vim.g.ok = 1", { status: 200 }),
    });
    const { files } = await fetchGithubPlugin("o/r", "main", { fetchImpl: f });
    const paths = files.map((x) => x.path);
    expect(paths).toContain("plugin/ok.lua");
    expect(paths).not.toContain("../evil.lua");
  });

  it("throws repo-not-found on a 404 tree", async () => {
    const f = fakeFetch({ "api.github.com": () => new Response("", { status: 404 }) });
    await expect(fetchGithubPlugin("o/r", "main", { fetchImpl: f })).rejects.toMatchObject({
      kind: "repo-not-found",
    });
  });

  it("throws rate-limited on a 403 with no remaining quota", async () => {
    const f = fakeFetch({
      "api.github.com": () =>
        new Response("", { status: 403, headers: { "X-RateLimit-Remaining": "0" } }),
    });
    await expect(fetchGithubPlugin("o/r", "main", { fetchImpl: f })).rejects.toMatchObject({
      kind: "rate-limited",
    });
  });

  it("refuses a repo over the file-count cap before fetching blobs", async () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      path: `plugin/f${i}.lua`,
      type: "blob",
      size: 1,
    }));
    const f = fakeFetch({ "api.github.com": () => treeJson(many) });
    await expect(fetchGithubPlugin("o/r", "main", { fetchImpl: f })).rejects.toMatchObject({
      kind: "too-large",
    });
  });

  it("surfaces a network error as kind network", async () => {
    const f = fakeFetch({});
    const err = await fetchGithubPlugin("o/r", "main", { fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubFetchError);
    expect(err.kind).toBe("network");
  });

  it("sends the token as an Authorization header on every api.github.com call", async () => {
    const { fn, calls } = recordingFetch((url) => {
      if (url.endsWith("/repos/o/r")) {
        return new Response(JSON.stringify({ private: false }), { status: 200 });
      }
      if (url.includes("/git/trees/")) {
        return treeJson([{ path: "plugin/foo.lua", type: "blob", size: 3, sha: "abc" }]);
      }
      if (url.includes("raw.githubusercontent.com")) return new Response("hi", { status: 200 });
      throw new TypeError("network");
    });
    await fetchGithubPlugin("o/r", "main", { token: "TESTTOKEN", fetchImpl: fn });
    const apiCalls = calls.filter((c) => c.url.includes("api.github.com"));
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const c of apiCalls) {
      expect(authOf(c.init)).toBe("Bearer TESTTOKEN");
    }
    // The token is NEVER attached to the public raw host.
    const rawCalls = calls.filter((c) => c.url.includes("raw.githubusercontent.com"));
    expect(rawCalls.length).toBeGreaterThan(0);
    for (const c of rawCalls) {
      expect(authOf(c.init)).toBeUndefined();
    }
  });

  it("fetches PRIVATE repo files via the git-blobs API (base64), not raw", async () => {
    const { fn } = recordingFetch((url) => {
      if (url.endsWith("/repos/o/r")) {
        return new Response(JSON.stringify({ private: true }), { status: 200 });
      }
      if (url.includes("/git/trees/")) {
        return treeJson([{ path: "plugin/foo.lua", type: "blob", size: 5, sha: "deadbeef" }]);
      }
      if (url.includes("/git/blobs/deadbeef")) {
        return new Response(
          JSON.stringify({ encoding: "base64", content: btoa("vim.g.p = 1") }),
          { status: 200 },
        );
      }
      if (url.includes("raw.githubusercontent.com")) {
        throw new Error("raw must not be used for a private repo");
      }
      throw new TypeError("network");
    });
    const { files } = await fetchGithubPlugin("o/r", "main", { token: "T", fetchImpl: fn });
    expect(files.map((x) => x.path)).toEqual(["plugin/foo.lua"]);
    expect(new TextDecoder().decode(files[0].data)).toBe("vim.g.p = 1");
  });

  it("uses raw (not the blobs API) for a PUBLIC repo even with a token", async () => {
    const { fn } = recordingFetch((url) => {
      if (url.endsWith("/repos/o/r")) {
        return new Response(JSON.stringify({ private: false }), { status: 200 });
      }
      if (url.includes("/git/trees/")) {
        return treeJson([{ path: "plugin/foo.lua", type: "blob", size: 2, sha: "abc" }]);
      }
      if (url.includes("/git/blobs/")) throw new Error("blobs API must not be used for a public repo");
      if (url.includes("raw.githubusercontent.com")) return new Response("ok", { status: 200 });
      throw new TypeError("network");
    });
    const { files } = await fetchGithubPlugin("o/r", "main", { token: "T", fetchImpl: fn });
    expect(new TextDecoder().decode(files[0].data)).toBe("ok");
  });

  it("maps a 401 to kind unauthorized", async () => {
    const f = fakeFetch({ "api.github.com": () => new Response("", { status: 401 }) });
    await expect(
      fetchGithubPlugin("o/r", "main", { token: "bad", fetchImpl: f }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });
});
