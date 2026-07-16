// Map a host page to a Neovim filetype so syntax highlighting / treesitter
// engage on sites whose text fields are known to hold a particular markup.
//
// Extracted into its own tiny, dependency-free module so it can be unit-tested
// in Node (vitest) without importing the content script — overlay.ts references
// chrome.* and the compile-time __NVIM_TEST_HOOKS__ flag at module load, neither
// of which exists under a bare vitest/tsc runtime.
export function filetypeForHost(host: string): string | undefined {
  const h = host.replace(/^www\./, "");
  if (/(^|\.)(github|gitlab)\.com$/.test(h)) return "markdown";
  if (/(^|\.)(stackoverflow|stackexchange|reddit)\.com$/.test(h)) return "markdown";
  if (h === "news.ycombinator.com") return "markdown";
  return undefined;
}
