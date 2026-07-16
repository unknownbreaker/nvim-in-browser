// Pure GitHub plugin fetcher. Runs in the options page (which has fetch). Uses
// ONLY endpoints that send Access-Control-Allow-Origin: * (api.github.com for
// the file tree, raw.githubusercontent.com for blobs), so no host_permissions
// are needed. fetchImpl is injectable for unit tests. Enforces file-count and
// total-size caps so a giant repo can't be pulled into IndexedDB.
export type GithubFetchErrorKind =
  | "repo-not-found"
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

export const MAX_FILES = 200;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

// Only text files that a pure-Lua/Vimscript plugin needs. Everything else
// (binaries, images, tests, CI) is skipped.
function isAllowedPath(path: string): boolean {
  if (/\.(lua|vim)$/.test(path)) return true;
  if (path === "vimrc" || path.endsWith("/vimrc")) return true;
  if (path.startsWith("doc/") && path.endsWith(".txt")) return true;
  return false;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

export async function fetchGithubPlugin(
  repo: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ files: { path: string; data: Uint8Array }[] }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new GithubFetchError("repo-not-found", `expected owner/repo, got "${repo}"`);
  }
  const treeUrl = `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`;

  let treeRes: Response;
  try {
    treeRes = await fetchImpl(treeUrl);
  } catch (e) {
    throw new GithubFetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (treeRes.status === 404) {
    throw new GithubFetchError("repo-not-found", `repo or ref not found: ${repo}@${ref}`);
  }
  if (treeRes.status === 403 && treeRes.headers.get("X-RateLimit-Remaining") === "0") {
    throw new GithubFetchError("rate-limited", "GitHub rate limit hit (60/hr unauthenticated)");
  }
  if (!treeRes.ok) {
    throw new GithubFetchError("network", `tree HTTP ${treeRes.status}`);
  }

  const body = (await treeRes.json()) as { tree?: TreeEntry[] };
  const blobs = (body.tree ?? []).filter((e) => e.type === "blob" && isAllowedPath(e.path));

  if (blobs.length > MAX_FILES) {
    throw new GithubFetchError("too-large", `plugin has ${blobs.length} files (max ${MAX_FILES})`);
  }
  const totalBytes = blobs.reduce((n, e) => n + (e.size ?? 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new GithubFetchError("too-large", `plugin is ${totalBytes} bytes (max ${MAX_TOTAL_BYTES})`);
  }

  const files: { path: string; data: Uint8Array }[] = [];
  for (const b of blobs) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${b.path}`;
    let res: Response;
    try {
      res = await fetchImpl(rawUrl);
    } catch (e) {
      throw new GithubFetchError("network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) {
      throw new GithubFetchError("network", `${b.path}: HTTP ${res.status}`);
    }
    files.push({ path: b.path, data: new Uint8Array(await res.arrayBuffer()) });
  }
  return { files };
}
