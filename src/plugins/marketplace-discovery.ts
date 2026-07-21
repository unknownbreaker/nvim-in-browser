// Self-discovering plugin marketplace: searches GitHub for Neovim plugins,
// vets each for sandbox compatibility with pure heuristics, and returns the
// safe ones. Runs in the options page (which has fetch). Uses ONLY hosts that
// send Access-Control-Allow-Origin: * (api.github.com + raw.githubusercontent.com),
// mirroring github-fetch.ts, so no host_permissions are needed. The token is
// sent as an Authorization header to api.github.com only (raw is public and its
// requests don't count against the API rate limit). fetchImpl is injectable so
// the whole pipeline is unit-testable with canned responses.

import { apiHeaders, isRateLimitStatus, treeUrl, rawUrl } from "./github-api";

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
  "pyproject.toml",
  "setup.py",
]);
// Compiled/binary artifacts (shared libs, node addons, static libs, wasm). A
// compiled tree-sitter grammar under parser/ is caught here too (parser/lua.so),
// which is the "tree-sitter/parser dir with a compiled grammar" case — while
// plain treesitter queries/*.scm carry no such extension and are NOT native.
const NATIVE_EXT = /\.(so|dll|dylib|node|a|wasm)$/i;
// A remote-plugin host directory (python3/node/ruby run in a separate process).
const NATIVE_DIR = /(?:^|\/)rplugin\//i;

/** True if any tree path signals a native/build/compiled/remote-host dependency. */
export function treeHasNativeSignals(paths: string[]): boolean {
  for (const p of paths) {
    if (NATIVE_DIR.test(p)) return true;
    const base = (p.split("/").pop() ?? p).toLowerCase();
    if (NATIVE_BASENAMES.has(base)) return true;
    if (NATIVE_EXT.test(base)) return true;
  }
  return false;
}

// --- Canonical sandbox-incompatible name lists -------------------------------
// Single source of truth for "risky" plugin/module names, shared by this
// file's static regex detector AND compat-verify.ts's runtime Lua shim (which
// imports these arrays to build its `risky` table). Each list is the UNION of
// what both detectors independently listed before this refactor, so neither
// detector was weakened by the merge. Exported so compat-verify.ts derives its
// table from the same source instead of hand-listing it separately.

// Plugin names with hard runtime deps that won't load in the sandbox (they
// spawn processes, hit the network, or need native code).
export const HARD_DEP_MODULES: readonly string[] = [
  "plenary",
  "telescope",
  "nvim-treesitter",
  "mason",
  "lspconfig",
  "null-ls",
  "none-ls",
  "nvim-dap",
  "dap",
  "conform",
  "nvim-lint",
  "gitsigns",
  "toggleterm",
  "fzf-lua",
  "neo-tree",
  "nvim-tree",
];

// Native/C-extension Lua modules that won't load without a native loader.
export const NATIVE_LUA_MODULES: readonly string[] = ["ffi", "socket", "ssl", "cjson", "posix"];

// `ffi` gets its own disqualifier entry (see DISQUALIFIERS below) distinct
// from the rest of NATIVE_LUA_MODULES, so it's split out here too. `socket`
// keeps its `(?:\.\w+)?` suffix so submodules (socket.core, socket.http, …)
// still match — the one piece of per-module regex shape that isn't a plain
// alternation, so it can't be folded into the array itself.
const FFI_MODULE = "ffi";
const ffiAlternation = NATIVE_LUA_MODULES.filter((m) => m === FFI_MODULE).join("|");
const otherNativeAlternation = NATIVE_LUA_MODULES.filter((m) => m !== FFI_MODULE)
  .map((m) => (m === "socket" ? "socket(?:\\.\\w+)?" : m))
  .join("|");

// Source-text patterns that make a plugin incompatible with the no-process,
// no-network WASI sandbox. Order defines "first match wins"; the hard-dep check
// (which captures the offending module name) runs last.
const DISQUALIFIERS: { re: RegExp; name: string }[] = [
  // process / shell. `system(list)?` covers vim.fn.system + vim.fn.systemlist;
  // termopen spawns a terminal process; jobstart spawns a job.
  { re: /\bjobstart\b/, name: "jobstart" },
  { re: /\bvim\.fn\.system(?:list)?\s*\(/, name: "vim.fn.system" },
  { re: /\b(?:vim\.fn\.)?termopen\s*\(/, name: "termopen" },
  { re: /\bos\.execute\s*\(/, name: "os.execute" },
  { re: /\bio\.popen\s*\(/, name: "io.popen" },
  { re: /\bvim\.system\s*\(/, name: "vim.system" },
  // host network / libuv sockets + DNS
  { re: /\b(?:vim\.loop|uv|vim\.uv)\.(?:new_tcp|new_udp|spawn|getaddrinfo|getnameinfo)\b/, name: "libuv" },
  // channels / RPC sockets (Lua vim.fn.* and Vimscript)
  { re: /\b(?:vim\.fn\.)?(?:sockconnect|serverstart|ch_open|chansend)\s*\(/, name: "sockets/channels" },
  // LSP client needs a language-server process + a stdio/socket channel
  // (start/start_client, and 0.11's vim.lsp.enable which starts configured servers)
  { re: /\bvim\.lsp\.(?:start(?:_client)?|enable)\s*\(/, name: "vim.lsp.start" },
  // FFI / dynamic native library load. `\(?` so Lua's paren-less string-call
  // sugar (`require 'ffi'`) is caught.
  { re: new RegExp(`require\\s*\\(?\\s*['"]${ffiAlternation}['"]`), name: "ffi" },
  { re: /\bpackage\.loadlib\s*\(/, name: "package.loadlib" },
  // C-extension Lua modules that won't load without a native loader. NB: lpeg
  // and luv are statically linked into core Neovim (require('lpeg')/require('luv')
  // resolve to built-ins — lpeg backs vim.lpeg/vim.re; luv is the vim.loop table),
  // so they are NOT listed here; luv's incompatible socket/spawn methods are
  // already caught by the libuv disqualifier above.
  { re: new RegExp(`require\\s*\\(?\\s*['"](?:${otherNativeAlternation})['"]`), name: "native-lua-module" },
  // tree-sitter PARSER INSTALL. The engine ships 7 static grammars, so plain
  // `vim.treesitter` use is FINE and no longer disqualifies; only installing new
  // (compiled) grammars does — that path fails in the sandbox.
  { re: /:TS(?:Install|Update)\b/, name: "treesitter-install" },
];
// Hard runtime deps that won't load in the sandbox (they spawn processes, hit
// the network, or need native code). Capture group -> the offending module name.
// `\(?` matches both require("x") and the paren-less require"x" / require 'x'.
const HARD_DEP_RE = new RegExp(`require\\s*\\(?\\s*['"](${HARD_DEP_MODULES.join("|")})`);

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
  if (isRateLimitStatus(res)) return true;
  if (res.status !== 403) return false;
  try {
    return /rate limit/i.test(await res.clone().text());
  } catch {
    return false;
  }
}

// Source files worth scanning for disqualifiers: Lua modules and the Vimscript
// runtime dirs where plugins put executable code (a jobstart in autoload/ or
// ftplugin/ counts just as much as one in lua/).
function isSourceCandidate(path: string): boolean {
  // Skip non-runtime dirs so test/doc code doesn't cause false positives or eat
  // the file budget.
  if (/(?:^|\/)(?:tests?|specs?|doc|docs)\//i.test(path)) return false;
  if (/\.lua$/.test(path)) return true; // lua/**, plugin/*.lua, a top-level init.lua, …
  if (/^(?:plugin|autoload|after|ftplugin|syntax|indent)\/.+\.vim$/.test(path)) return true;
  return false;
}

// Scan-order priority (lower = scanned first). The bounded budget can't read
// every file, so front-load the ENTRY POINTS where process/network calls almost
// always live — otherwise a jobstart in the 9th file slips through unscanned.
function sourcePriority(path: string): number {
  if (/^plugin\/.+\.(lua|vim)$/.test(path)) return 0; // auto-sourced entry points
  if (/(?:^|\/)init\.lua$/.test(path)) return 1; // lua/<name>/init.lua, top-level init.lua
  if (/^lua\//.test(path)) return 2; // the rest of the Lua modules
  return 3; // autoload/after/ftplugin vim, etc.
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
  const authHeaders = apiHeaders(opts.token);

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
      treeRes = await fetchImpl(treeUrl(owner, name, branch), {
        headers: authHeaders,
        signal: opts.signal,
      });
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

    // Fetch a bounded set of source files from raw (public, no rate-limit cost),
    // entry points first so the budget is spent where disqualifiers cluster.
    const sources = entries
      .filter((e) => e.type === "blob" && isSourceCandidate(e.path))
      .map((e) => e.path)
      .sort((a, b) => sourcePriority(a) - sourcePriority(b));
    let text = "";
    let bytes = 0;
    let count = 0;
    for (const p of sources) {
      if (count >= MAX_SOURCE_FILES || bytes >= MAX_SOURCE_BYTES) break;
      let raw: Response;
      try {
        raw = await fetchImpl(rawUrl(owner, name, branch, p), {
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
      // Only take up to the remaining budget from this file, so a single large
      // file can't push the per-repo scan far past MAX_SOURCE_BYTES.
      bodyText = bodyText.slice(0, MAX_SOURCE_BYTES - bytes);
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
