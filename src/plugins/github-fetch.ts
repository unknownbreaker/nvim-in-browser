// Pure GitHub plugin fetcher. Runs in the options page (which has fetch). Uses
// ONLY hosts that send Access-Control-Allow-Origin: * (api.github.com +
// raw.githubusercontent.com), so no host_permissions are needed — this holds
// even with a token, which is sent as an Authorization header (api.github.com
// supports CORS for token auth). fetchImpl is injectable for unit tests.
//
// Without a token: lists the tree and pulls PUBLIC files from raw.
// With a token: authenticates the api.github.com calls (raising the 60/hr
// per-IP limit to 5000/hr per account) and, for PRIVATE repos, pulls each
// file's bytes through the authenticated git-blobs API (base64), since raw
// cannot serve private files with a token.
import { isSafeRelpath } from "../storage/config-store";
import { apiHeaders, isRateLimitStatus, treeUrl, rawUrl } from "./github-api";

export type GithubFetchErrorKind =
  | "repo-not-found"
  | "unauthorized"
  | "rate-limited"
  | "too-large"
  | "network";

export class GithubFetchError extends Error {
  kind: GithubFetchErrorKind;
  constructor(kind: GithubFetchErrorKind, message: string) {
    super(message);
    this.name = "GithubFetchError";
    this.kind = kind;
  }
}

export const MAX_FILES = 300;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export interface FetchOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

// Top-level directories a runtime plugin never needs: test suites, CI config,
// screenshots/media, build/generator scripts, and app-specific theme exports
// (e.g. tokyonight's extras/). Skipping them keeps large repos (mini.nvim,
// tokyonight.nvim) well under the file/size caps. Matched against the leading
// path segment only, so runtime modules like lua/mini/test.lua are untouched.
const EXCLUDED_DIR =
  /^(tests?|spec|\.github|\.ci|ci|screenshots?|media|images?|img|assets|demos?|scripts?|tools|examples?|benchmarks?|bench|extras?)\//;

// Only text files that a pure-Lua/Vimscript plugin needs at runtime. Everything
// else (binaries, images, tests, CI, generator scripts) is skipped.
function isAllowedPath(path: string): boolean {
  if (EXCLUDED_DIR.test(path)) return false;
  if (/\.(lua|vim)$/.test(path)) return true;
  if (path === "vimrc" || path.endsWith("/vimrc")) return true;
  if (path.startsWith("doc/") && path.endsWith(".txt")) return true;
  return false;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
  sha?: string;
}

// Map a non-ok api.github.com response to a typed error. `null` when ok.
function apiError(res: Response, repo: string, ref: string): GithubFetchError | null {
  if (res.ok) return null;
  if (res.status === 401) {
    return new GithubFetchError("unauthorized", "GitHub rejected the token (invalid, expired, or missing access)");
  }
  if (isRateLimitStatus(res)) {
    return new GithubFetchError("rate-limited", "GitHub rate limit hit — add or check your token");
  }
  if (res.status === 404) {
    return new GithubFetchError("repo-not-found", `repo or ref not found (or the token lacks access): ${repo}@${ref}`);
  }
  return new GithubFetchError("network", `GitHub HTTP ${res.status}`);
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function fetchGithubPlugin(
  repo: string,
  ref: string,
  opts: FetchOptions = {},
): Promise<{ files: { path: string; data: Uint8Array }[]; ref: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token;
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new GithubFetchError("repo-not-found", `expected owner/repo, got "${repo}"`);
  }

  const api = (path: string) => `https://api.github.com/repos/${owner}/${name}${path}`;
  const getApi = async (url: string): Promise<Response> => {
    try {
      return await fetchImpl(url, { headers: apiHeaders(token) });
    } catch (e) {
      throw new GithubFetchError("network", e instanceof Error ? e.message : String(e));
    }
  };

  // Fetch repo metadata when we need it: to resolve a BLANK ref to the repo's
  // default branch (repos vary — main vs master vs trunk, so a hardcoded "main"
  // 404s on many), and/or, with a token, to learn `private` (which picks the
  // blob source: raw for public, the blobs API for private). One call covers both.
  let effectiveRef = ref;
  let isPrivate = false;
  if (!effectiveRef || token) {
    const metaRes = await getApi(api(""));
    const metaErr = apiError(metaRes, repo, ref || "(default branch)");
    if (metaErr) throw metaErr;
    const meta = (await metaRes.json()) as { private?: boolean; default_branch?: string };
    isPrivate = meta.private === true;
    if (!effectiveRef) effectiveRef = meta.default_branch ?? "main";
  }

  const treeRes = await getApi(treeUrl(owner, name, effectiveRef));
  const treeErr = apiError(treeRes, repo, effectiveRef);
  if (treeErr) throw treeErr;

  const body = (await treeRes.json()) as { tree?: TreeEntry[] };
  const blobs = (body.tree ?? []).filter(
    (e) => e.type === "blob" && isAllowedPath(e.path) && isSafeRelpath(e.path),
  );

  if (blobs.length > MAX_FILES) {
    throw new GithubFetchError("too-large", `plugin has ${blobs.length} files (max ${MAX_FILES})`);
  }
  const totalBytes = blobs.reduce((n, e) => n + (e.size ?? 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new GithubFetchError("too-large", `plugin is ${totalBytes} bytes (max ${MAX_TOTAL_BYTES})`);
  }

  const files: { path: string; data: Uint8Array }[] = [];
  for (const b of blobs) {
    let data: Uint8Array;
    if (token && isPrivate) {
      // Private repo: raw won't serve it with a token, so pull the blob by SHA
      // through the authenticated git-blobs API (base64).
      if (!b.sha) throw new GithubFetchError("network", `${b.path}: missing blob sha`);
      const blobRes = await getApi(api(`/git/blobs/${b.sha}`));
      const blobErr = apiError(blobRes, repo, effectiveRef);
      if (blobErr) throw blobErr;
      const blob = (await blobRes.json()) as { content?: string; encoding?: string };
      if (blob.encoding !== "base64" || typeof blob.content !== "string") {
        throw new GithubFetchError("network", `${b.path}: unexpected blob encoding`);
      }
      data = decodeBase64(blob.content);
    } else {
      let res: Response;
      try {
        res = await fetchImpl(rawUrl(owner, name, effectiveRef, b.path));
      } catch (e) {
        throw new GithubFetchError("network", e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) {
        throw new GithubFetchError("network", `${b.path}: HTTP ${res.status}`);
      }
      data = new Uint8Array(await res.arrayBuffer());
    }
    files.push({ path: b.path, data });
  }
  return { files, ref: effectiveRef };
}
