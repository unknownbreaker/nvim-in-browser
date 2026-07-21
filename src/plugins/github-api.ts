// Shared GitHub API access: auth headers, rate-limit detection, and URL
// construction used by both github-fetch.ts (single-plugin install) and
// marketplace-discovery.ts (search/vet pipeline). Both callers use ONLY hosts
// that send Access-Control-Allow-Origin: * (api.github.com +
// raw.githubusercontent.com), so no host_permissions are needed even with a
// token — it's sent as an Authorization header, which api.github.com CORS
// supports.

// api.github.com request headers. Accept is CORS-safelisted (no preflight);
// Authorization (when a token is present) triggers a CORS preflight that
// api.github.com answers — still no host_permissions needed.
export function apiHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// SYNC header-only rate-limit check: true when a 403 carries
// X-RateLimit-Remaining: 0. Callers that also want a response-body fallback
// (GitHub sometimes 403s for rate-limit reasons without that header) should
// check this first and fall back to inspecting the body themselves.
export function isRateLimitStatus(res: Response): boolean {
  return res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0";
}

// `git/trees/<ref>?recursive=1` — the recursive repo-tree listing used to
// discover files. `ref` is URI-component-encoded (branch/tag names can
// contain characters like `/` that need escaping in a path segment).
export function treeUrl(owner: string, name: string, ref: string): string {
  return `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
}

// raw.githubusercontent.com file URL for a public blob. Neither `ref` nor
// `path` is encoded, matching both callers' prior behavior.
export function rawUrl(owner: string, name: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${path}`;
}
