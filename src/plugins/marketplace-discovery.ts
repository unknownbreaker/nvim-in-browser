// Self-discovering plugin marketplace: searches GitHub for Neovim plugins,
// vets each for sandbox compatibility with pure heuristics, and returns the
// safe ones. Runs in the options page (which has fetch). Uses ONLY hosts that
// send Access-Control-Allow-Origin: * (api.github.com + raw.githubusercontent.com),
// mirroring github-fetch.ts, so no host_permissions are needed. The token is
// sent as an Authorization header to api.github.com only (raw is public and its
// requests don't count against the API rate limit). fetchImpl is injectable so
// the whole pipeline is unit-testable with canned responses.

export interface MarketplacePlugin {
  repo: string;
  name: string;
  blurb: string;
  category: string;
  stars: number;
}

const API = "https://api.github.com";

// --- Pure vetting heuristics (unit-tested directly) --------------------------

// Basenames that indicate a native/build/compiled dependency the WASI sandbox
// cannot honor (no compiler, no package manager, no process to run them).
const NATIVE_BASENAMES = new Set([
  "makefile",
  "cmakelists.txt",
  "cargo.toml",
  "package.json",
  "build.lua",
]);
// Compiled/binary artifacts (shared libs, node addons, wasm). A compiled
// tree-sitter grammar under parser/ is caught here too (parser/lua.so), which
// is the "tree-sitter/parser dir with a compiled grammar" case — while plain
// treesitter queries/*.scm carry no such extension and are NOT a native signal.
const NATIVE_EXT = /\.(so|dll|dylib|node|wasm)$/i;

/** True if any tree path signals a native/build/compiled dependency. */
export function treeHasNativeSignals(paths: string[]): boolean {
  for (const p of paths) {
    const base = (p.split("/").pop() ?? p).toLowerCase();
    if (NATIVE_BASENAMES.has(base)) return true;
    if (NATIVE_EXT.test(base)) return true;
  }
  return false;
}

// Source-text patterns that make a plugin incompatible with the no-process,
// no-network WASI sandbox. Order defines "first match wins"; the hard-dep check
// (which captures the offending module name) runs last.
const DISQUALIFIERS: { re: RegExp; name: string }[] = [
  // process / shell
  { re: /\bjobstart\b/, name: "jobstart" },
  { re: /\bvim\.fn\.system\s*\(/, name: "vim.fn.system" },
  { re: /\bos\.execute\s*\(/, name: "os.execute" },
  { re: /\bio\.popen\s*\(/, name: "io.popen" },
  { re: /\bvim\.system\s*\(/, name: "vim.system" },
  // host network / libuv
  { re: /\b(?:vim\.loop|uv|vim\.uv)\.(?:new_tcp|new_udp|spawn)\b/, name: "libuv" },
  // FFI
  { re: /require\s*\(\s*['"]ffi['"]/, name: "ffi" },
  // needs compiled parsers
  { re: /\bvim\.treesitter\b/, name: "vim.treesitter" },
];
// Hard runtime deps that won't load in the sandbox. Capture group -> the name.
const HARD_DEP_RE = /require\s*\(\s*['"](plenary|telescope|nvim-treesitter|mason|lspconfig)/;

/** The first disqualifying flag found in `text`, or null if it looks clean. */
export function sourceDisqualifier(text: string): string | null {
  for (const { re, name } of DISQUALIFIERS) {
    if (re.test(text)) return name;
  }
  const dep = HARD_DEP_RE.exec(text);
  if (dep) return dep[1];
  return null;
}

function wordHit(hay: string, ...words: string[]): boolean {
  return words.some((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, "i").test(hay);
  });
}

/** Map a repo's topics + description to a short marketplace category. */
export function categoryForTopics(topics: string[], description: string): string {
  const hay = [...(topics ?? []), description ?? ""].join(" ").toLowerCase();
  if (wordHit(hay, "colorscheme", "colorschemes", "color-scheme", "theme")) return "Theme";
  if (wordHit(hay, "statusline", "tabline", "bufferline")) return "UI";
  if (wordHit(hay, "comment", "pairs", "surround", "motion", "text")) return "Editing";
  if (wordHit(hay, "which-key", "keybinding", "keybindings", "ui")) return "UX";
  return "Plugin";
}

/** Repo-level pre-filter run on the search results before any tree/source fetch. */
export function metadataOk(repo: {
  archived?: boolean;
  fork?: boolean;
  size?: number;
  stargazers_count?: number;
  description?: string | null;
}): boolean {
  if (repo.archived) return false;
  if (repo.fork) return false;
  if ((repo.size ?? 0) >= 10240) return false;
  if ((repo.stargazers_count ?? 0) < 30) return false;
  if (!repo.description || repo.description.trim().length === 0) return false;
  return true;
}

// --- Network pipeline --------------------------------------------------------

interface SearchRepo {
  full_name: string;
  description?: string | null;
  topics?: string[];
  archived?: boolean;
  fork?: boolean;
  size?: number;
  stargazers_count?: number;
  default_branch?: string;
}

// A 403 that GitHub attributes to rate limiting (header first, body as fallback).
async function isRateLimitResponse(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  if (res.headers.get("X-RateLimit-Remaining") === "0") return true;
  try {
    return /rate limit/i.test(await res.clone().text());
  } catch {
    return false;
  }
}

// Source files worth scanning for disqualifiers: entry points and Lua modules.
function isSourceCandidate(path: string): boolean {
  if (/^plugin\/.+\.vim$/.test(path)) return true;
  if (/^lua\/.+\.lua$/.test(path)) return true;
  return false;
}

const MAX_SOURCE_FILES = 8;
const MAX_SOURCE_BYTES = 300 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MARKETPLACE_MAX_AGE_MS = DAY_MS;

export interface DiscoverOptions {
  token: string;
  budget?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (vetted: number, scanned: number) => void;
  signal?: AbortSignal;
}

export async function discoverMarketplace(
  opts: DiscoverOptions,
): Promise<{ plugins: MarketplacePlugin[]; rateLimited: boolean; scanned: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const budget = opts.budget ?? 50;
  const authHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `token ${opts.token}`,
  };

  let rateLimited = false;
  let scanned = 0;

  // 1. Search (up to 2 pages) and pre-filter with metadataOk to ~budget*2.
  const candidates: SearchRepo[] = [];
  for (let page = 1; page <= 2; page++) {
    if (opts.signal?.aborted) break;
    const url =
      `${API}/search/repositories?q=topic:neovim-plugin+language:lua` +
      `&sort=stars&order=desc&per_page=100&page=${page}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: authHeaders, signal: opts.signal });
    } catch {
      break;
    }
    if (await isRateLimitResponse(res)) {
      rateLimited = true;
      break;
    }
    if (!res.ok) break;
    let body: { items?: SearchRepo[] };
    try {
      body = (await res.json()) as { items?: SearchRepo[] };
    } catch {
      break;
    }
    const items = body.items ?? [];
    for (const it of items) if (metadataOk(it)) candidates.push(it);
    if (items.length < 100) break; // last page
    if (candidates.length >= budget * 2) break;
  }

  // 2/3. Vet candidates in stars order with bounded concurrency, stopping early
  // on a full budget or a rate limit. Results are keyed by candidate index so
  // the final list stays in stars order regardless of completion order.
  const vettedByIdx = new Map<number, MarketplacePlugin>();
  let next = 0;
  let stop = rateLimited;

  const vetRepo = async (repo: SearchRepo): Promise<MarketplacePlugin | "rate-limited" | null> => {
    const [owner, name] = repo.full_name.split("/");
    if (!owner || !name) return null;
    const branch = repo.default_branch || "main";
    let treeRes: Response;
    try {
      treeRes = await fetchImpl(
        `${API}/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers: authHeaders, signal: opts.signal },
      );
    } catch {
      return null;
    }
    if (await isRateLimitResponse(treeRes)) return "rate-limited";
    if (!treeRes.ok) return null;
    let tree: { tree?: { path: string; type: string }[] };
    try {
      tree = (await treeRes.json()) as { tree?: { path: string; type: string }[] };
    } catch {
      return null;
    }
    const entries = tree.tree ?? [];
    if (treeHasNativeSignals(entries.map((e) => e.path))) return null;

    // Fetch a bounded set of source files from raw (public, no rate-limit cost).
    const sources = entries
      .filter((e) => e.type === "blob" && isSourceCandidate(e.path))
      .map((e) => e.path);
    let text = "";
    let bytes = 0;
    let count = 0;
    for (const p of sources) {
      if (count >= MAX_SOURCE_FILES || bytes >= MAX_SOURCE_BYTES) break;
      let raw: Response;
      try {
        raw = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${name}/${branch}/${p}`, {
          signal: opts.signal,
        });
      } catch {
        continue;
      }
      if (!raw.ok) continue;
      let bodyText: string;
      try {
        bodyText = await raw.text();
      } catch {
        continue;
      }
      text += "\n" + bodyText;
      bytes += bodyText.length;
      count++;
    }
    if (sourceDisqualifier(text)) return null;

    return {
      repo: repo.full_name,
      name,
      blurb: repo.description ?? "",
      category: categoryForTopics(repo.topics ?? [], repo.description ?? ""),
      stars: repo.stargazers_count ?? 0,
    };
  };

  const worker = async (): Promise<void> => {
    while (!stop) {
      const idx = next++;
      if (idx >= candidates.length) return;
      if (opts.signal?.aborted) {
        stop = true;
        return;
      }
      scanned++;
      const result = await vetRepo(candidates[idx]);
      if (result === "rate-limited") {
        rateLimited = true;
        stop = true;
        return;
      }
      if (result) {
        vettedByIdx.set(idx, result);
        if (vettedByIdx.size >= budget) stop = true;
      }
      opts.onProgress?.(vettedByIdx.size, scanned);
    }
  };

  const poolSize = Math.min(4, candidates.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  const plugins = [...vettedByIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((e) => e[1])
    .slice(0, budget);
  return { plugins, rateLimited, scanned };
}
