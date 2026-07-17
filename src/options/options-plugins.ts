// Options-page plugin manager: install pure-Lua plugins from GitHub (owner/repo)
// or a folder upload, list installed plugins with per-plugin enable/disable,
// refresh (github only), and remove. All store ops are wrapped so failures land
// in the shared status line, never a blank page. Thin UI over the tested
// plugin-store + github-fetch + folder-upload units.
import { openPluginStore, isSafePluginName, type PluginRecord } from "../storage/plugin-store";
import { fetchGithubPlugin, GithubFetchError } from "../plugins/github-fetch";
import { openTokenStore } from "../storage/token-store";
import { openMarketplaceStore } from "../storage/marketplace-store";
import { discoverMarketplace, MARKETPLACE_MAX_AGE_MS } from "../plugins/marketplace-discovery";
import { readFolderUpload } from "./folder-upload";
import { CURATED_PLUGINS } from "./plugin-catalog";

const store = openPluginStore();
const tokenStore = openTokenStore();
const marketplaceStore = openMarketplaceStore();

// The shape the marketplace card renderer needs. Both the discovered
// MarketplacePlugin (has stars) and the bundled CuratedPlugin seed (no stars)
// satisfy it, so either can drive a card without a mapping step.
interface ShelfEntry {
  repo: string;
  name: string;
  blurb: string;
  category: string;
  stars?: number;
}

// localStorage flag for daily-on-open auto-update (mirrors the format-on-save
// toggle in options-config — a small UI preference, not worth a store schema).
const MARKETPLACE_AUTOUPDATE_KEY = "nib:marketplaceAutoUpdate";
function autoUpdateEnabled(): boolean {
  try {
    return localStorage.getItem(MARKETPLACE_AUTOUPDATE_KEY) === "1";
  } catch {
    return false;
  }
}
function setAutoUpdate(on: boolean): void {
  try {
    localStorage.setItem(MARKETPLACE_AUTOUPDATE_KEY, on ? "1" : "0");
  } catch {
    // Private-mode / storage-disabled: the toggle just won't persist.
  }
}

function relativeTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as unknown as T;
}

// Reuse the page's status line (owned by options.ts) via a tiny event so this
// module doesn't duplicate the status widget.
function status(message: string, kind: "ok" | "err" | "info"): void {
  document.dispatchEvent(new CustomEvent("nib-status", { detail: { message, kind } }));
}
// Nudge the nav badges + Overview pane to re-read after a store write.
function refreshShell(): void {
  document.dispatchEvent(new CustomEvent("nib-refresh"));
}

function fetchErrorMessage(err: unknown): string {
  if (err instanceof GithubFetchError) {
    switch (err.kind) {
      case "repo-not-found":
        return "Repo or ref not found — check owner/repo and the ref (a private repo needs a token with access).";
      case "unauthorized":
        return "GitHub rejected your token — make sure it's valid, not expired, and has access to this repo.";
      case "rate-limited":
        return "GitHub rate limit hit. Save a personal access token below to raise it (60/hr → 5,000/hr).";
      case "too-large":
        return "Plugin is too large even after skipping test/CI/media files (max 300 files / 10 MB).";
      case "network":
        return `Network error: ${err.message} (some hosts block cross-origin fetch; GitHub works).`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function render(): Promise<void> {
  const list = el<HTMLUListElement>("plugin-list");
  let plugins: PluginRecord[];
  try {
    plugins = await store.list();
  } catch (err) {
    status(`Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`, "err");
    return;
  }
  // Keep the plugins count badge + Overview in sync after any (re-)render.
  refreshShell();
  // Compute the installed-name set ONCE and drive the marketplace off it, so the
  // marketplace cards and the installed grid always reflect the same store read
  // (an install/remove here flips the matching marketplace card to/from
  // "Installed ✓"). The marketplace render is async (it reads its own cache DB)
  // but doesn't block the installed grid below.
  const installedNames = new Set(plugins.map((p) => p.name));
  void renderMarketplace(installedNames);
  list.textContent = "";
  if (plugins.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.style.color = "var(--subtext)";
    empty.textContent = "No plugins installed.";
    list.append(empty);
    return;
  }
  for (const p of plugins.sort((a, b) => a.name.localeCompare(b.name))) {
    list.append(renderCard(p));
  }
}

function renderCard(p: PluginRecord): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "plugin-card";

  // Header: name (strong) + an Enabled/Disabled status pill.
  const header = document.createElement("div");
  header.className = "plugin-card-header";
  // Build with textContent, not innerHTML: p.repo/p.ref are user-supplied, so
  // interpolating them into markup would be an injection vector (self-XSS on a
  // tampered IndexedDB record).
  const nameEl = document.createElement("strong");
  nameEl.className = "plugin-card-name";
  nameEl.textContent = p.name;
  const pill = document.createElement("span");
  pill.className = p.enabled ? "pill pill-on" : "pill pill-off";
  pill.textContent = p.enabled ? "Enabled" : "Disabled";
  header.append(nameEl, pill);

  // Meta: for github "owner/repo@ref · N files"; for upload "uploaded · N files".
  const meta = document.createElement("div");
  meta.className = "plugin-card-meta";
  meta.textContent =
    p.source === "github"
      ? `${p.repo}@${p.ref} · ${p.files.length} files`
      : `uploaded · ${p.files.length} files`;

  const actions = document.createElement("div");
  actions.className = "plugin-card-actions";

  // Enable/disable toggle — same store.setEnabled path via onToggle.
  const toggleLabel = document.createElement("label");
  toggleLabel.className = "plugin-card-toggle";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = p.enabled;
  toggle.addEventListener("change", () => void onToggle(p.name, toggle, pill));
  const toggleText = document.createElement("span");
  toggleText.textContent = "Enabled";
  toggleLabel.append(toggle, toggleText);
  actions.append(toggleLabel);

  if (p.source === "github") {
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", () => void onRefresh(p));
    actions.append(refresh);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => void onRemove(p.name));
  actions.append(remove);

  li.append(header, meta, actions);
  return li;
}

// --- Marketplace: self-discovered (or bundled-seed) pure-Lua plugins ---------
// Rebuilt on every render() off the installed-name set, so a card flips to
// "Installed ✓" the moment its plugin lands in the store (and back if removed).
// Cards come from the marketplace cache DB; with no cache we fall back to the
// bundled CURATED_PLUGINS seed and label the timestamp accordingly.
async function renderMarketplace(installedNames: Set<string>): Promise<void> {
  const listEl = el<HTMLDivElement>("marketplace-list");
  const cache = await marketplaceStore.load();
  // Show discovered plugins only when a run actually produced some; otherwise
  // (no cache, or a run that found nothing / was rate-limited) fall back to the
  // bundled seed — and label it as the seed, not as a fresh "Updated" run.
  const usingCache = Boolean(cache && cache.plugins.length > 0);
  const entries: ShelfEntry[] = usingCache ? cache!.plugins : CURATED_PLUGINS;
  listEl.textContent = "";
  for (const entry of entries) {
    listEl.append(renderMarketplaceCard(entry, installedNames.has(entry.name)));
  }
  el<HTMLSpanElement>("marketplace-updated").textContent = usingCache
    ? `Updated ${relativeTime(cache!.updatedAt)}`
    : "Showing bundled list — run Update to discover plugins";
}

function renderMarketplaceCard(entry: ShelfEntry, installed: boolean): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "shelf-card";

  const header = document.createElement("div");
  header.className = "shelf-card-header";
  // entry.name/blurb/repo can be repo-derived (marketplace) or static (seed);
  // build with textContent either way so a repo string can never inject markup.
  const nameEl = document.createElement("strong");
  nameEl.className = "shelf-card-name";
  nameEl.textContent = entry.name;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = entry.category;
  header.append(nameEl, tag);

  const blurb = document.createElement("p");
  blurb.className = "shelf-card-blurb";
  blurb.textContent = entry.blurb;

  const repoEl = document.createElement("div");
  repoEl.className = "shelf-card-repo";
  repoEl.textContent = entry.repo;
  if (typeof entry.stars === "number" && entry.stars > 0) {
    const stars = document.createElement("span");
    stars.className = "shelf-card-stars";
    stars.textContent = ` ★ ${entry.stars.toLocaleString()}`;
    repoEl.append(stars);
  }

  const install = document.createElement("button");
  install.type = "button";
  install.className = "shelf-card-install";
  if (installed) {
    install.disabled = true;
    install.textContent = "Installed ✓";
  } else {
    install.classList.add("primary");
    install.textContent = "Install";
    install.addEventListener("click", () => void onShelfInstall(entry, install));
  }

  card.append(header, blurb, repoEl, install);
  return card;
}

async function onShelfInstall(entry: ShelfEntry, btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Installing…";
  // Blank ref -> installFromGithub lets fetchGithubPlugin resolve the repo's
  // default branch (master vs main vs …). On success it re-renders, which
  // rebuilds the marketplace and detaches this button (flipped to "Installed ✓").
  await installFromGithub(entry.repo, "");
  // Only reached with the button still attached if the install did NOT succeed
  // (no re-render happened); restore it so the user can retry.
  if (btn.isConnected) {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function onToggle(name: string, box: HTMLInputElement, pill?: HTMLElement): Promise<void> {
  const enabled = box.checked;
  try {
    await store.setEnabled(name, enabled);
    // Keep the card's status pill in sync with the toggle (it would otherwise
    // stay stale until the next full render() after an install/remove).
    if (pill) {
      pill.className = enabled ? "pill pill-on" : "pill pill-off";
      pill.textContent = enabled ? "Enabled" : "Disabled";
    }
    refreshShell();
    status(enabled ? `${name} enabled (reload your editor).` : `${name} disabled (reload your editor).`, "info");
  } catch (err) {
    box.checked = !enabled;
    status(`Failed to update ${name}: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

async function onRemove(name: string): Promise<void> {
  if (!confirm(`Remove plugin "${name}"? This deletes it from this browser.`)) return;
  try {
    await store.remove(name);
    status(`Removed ${name}. (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Failed to remove ${name}: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

async function onRefresh(p: PluginRecord): Promise<void> {
  if (!p.repo || !p.ref) return;
  status(`Refreshing ${p.name}…`, "info");
  try {
    const token = (await tokenStore.get()) ?? undefined;
    const { files, ref } = await fetchGithubPlugin(p.repo, p.ref, { token });
    await store.add({ ...p, ref, files, addedAt: Date.now() });
    status(`Refreshed ${p.name} (${files.length} files). (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Refresh failed: ${fetchErrorMessage(err)}`, "err");
  }
}

// Shared install core for both the manual "Add from GitHub" button and the
// curated shelf. Validates owner/repo, guards against a duplicate name, fetches
// over the GitHub API (blank ref -> the repo's default branch is auto-detected),
// stages it, then re-renders (which also refreshes the shelf). Errors are caught
// and surfaced via fetchErrorMessage, so this never throws — callers manage only
// their own button state.
async function installFromGithub(repo: string, ref: string): Promise<void> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    status("Enter a plugin as owner/repo (e.g. echasnovski/mini.nvim).", "info");
    return;
  }
  const name = repo.split("/")[1];
  if (!isSafePluginName(name)) {
    status(`Unsafe plugin name derived from repo: ${name}`, "err");
    return;
  }
  status(`Fetching ${repo}${ref ? "@" + ref : ""}…`, "info");
  try {
    if (await store.get(name)) {
      status(`A plugin named "${name}" is already installed — remove or refresh it first.`, "err");
      return;
    }
    const token = (await tokenStore.get()) ?? undefined;
    const { files, ref: resolvedRef } = await fetchGithubPlugin(repo, ref, { token });
    if (files.length === 0) {
      status(`No .lua/.vim files found in ${repo}@${resolvedRef}.`, "err");
      return;
    }
    await store.add({ name, source: "github", repo, ref: resolvedRef, enabled: true, files, addedAt: Date.now() });
    // Clear the manual install fields on success. (When invoked from the shelf
    // these are typically empty; clearing them is harmless.)
    el<HTMLInputElement>("plugin-repo").value = "";
    el<HTMLInputElement>("plugin-ref").value = "";
    status(`Installed ${name} (${files.length} files) from ${repo}@${resolvedRef}. (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Install failed: ${fetchErrorMessage(err)}`, "err");
  }
}

async function onAddGithub(): Promise<void> {
  const repo = el<HTMLInputElement>("plugin-repo").value.trim();
  // Blank ref -> fetchGithubPlugin resolves the repo's default branch (main vs
  // master vs …), so the user doesn't have to know which a repo uses.
  const ref = el<HTMLInputElement>("plugin-ref").value.trim();
  const btn = el<HTMLButtonElement>("plugin-add");
  btn.disabled = true;
  try {
    await installFromGithub(repo, ref);
  } finally {
    btn.disabled = false;
  }
}

async function onUploadFolder(input: HTMLInputElement): Promise<void> {
  const files = input.files;
  if (!files || files.length === 0) return;
  // The top folder segment is the plugin name.
  const top = files[0].webkitRelativePath.split("/")[0];
  if (!isSafePluginName(top)) {
    status(`Unsafe plugin folder name: ${top}`, "err");
    input.value = "";
    return;
  }
  try {
    if (await store.get(top)) {
      status(`A plugin named "${top}" is already installed — remove it first.`, "err");
      return;
    }
    const pluginFiles = await readFolderUpload(files);
    if (pluginFiles.length === 0) {
      status(`No usable files found in ${top}.`, "err");
      return;
    }
    await store.add({ name: top, source: "upload", enabled: true, files: pluginFiles, addedAt: Date.now() });
    status(`Uploaded ${top} (${pluginFiles.length} files). (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    input.value = "";
  }
}

// --- GitHub token (isolated secrets DB; never staged into the editor FS) -----
// The field is never populated with the stored token — we only report whether
// one is saved, so the secret is not rendered back into the DOM.
async function refreshTokenStatus(): Promise<void> {
  const label = el<HTMLSpanElement>("gh-token-status");
  try {
    label.textContent = (await tokenStore.has()) ? "✓ token saved" : "no token saved";
  } catch {
    label.textContent = "";
  }
}

async function onSaveToken(): Promise<void> {
  const input = el<HTMLInputElement>("gh-token");
  const value = input.value.trim();
  if (!value) {
    status("Enter a token, or use Clear to remove the saved one.", "info");
    return;
  }
  try {
    await tokenStore.set(value);
    input.value = "";
    status("GitHub token saved.", "ok");
    refreshShell();
    await refreshTokenStatus();
  } catch (err) {
    status(`Failed to save token: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

async function onClearToken(): Promise<void> {
  try {
    await tokenStore.clear();
    el<HTMLInputElement>("gh-token").value = "";
    status("GitHub token cleared.", "ok");
    refreshShell();
    await refreshTokenStatus();
  } catch (err) {
    status(`Failed to clear token: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

// --- Marketplace update: discover from GitHub + refresh the cached list ------
// Always available, but a token is required (GitHub's search + tree APIs are
// rate-limited hard without one). Guards every network/store call so a failure
// lands in the status line and re-enables the button, never a blank page.
let marketplaceUpdating = false;
async function onMarketplaceUpdate(): Promise<void> {
  if (marketplaceUpdating) return; // don't stack a manual click on an auto-update
  let token: string | null;
  try {
    token = await tokenStore.get();
  } catch {
    token = null;
  }
  if (!token) {
    status("Save a GitHub token in Advanced to update the marketplace.", "info");
    return;
  }
  const btn = el<HTMLButtonElement>("marketplace-update");
  const original = btn.textContent;
  marketplaceUpdating = true;
  btn.disabled = true;
  btn.textContent = "Updating…";
  status("Updating marketplace…", "info");
  try {
    const result = await discoverMarketplace({
      token,
      onProgress: (vetted, scanned) => {
        btn.textContent = `Updating… (${vetted})`;
        status(`Updating marketplace… vetted ${vetted} (scanned ${scanned}).`, "info");
      },
    });
    await marketplaceStore.save(result.plugins, Date.now());
    await render(); // recomputes installedNames + re-renders both sub-panels
    if (result.rateLimited) {
      status(
        `GitHub's rate limit was hit — showing a partial list of ${result.plugins.length}. Try Update again later.`,
        "info",
      );
    } else {
      status(`Marketplace updated — ${result.plugins.length} sandbox-safe plugins.`, "ok");
    }
  } catch (err) {
    status(`Marketplace update failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    marketplaceUpdating = false;
    btn.disabled = false;
    btn.textContent = original ?? "Update list";
  }
}

// Daily-on-open refresh: only when the toggle is on, a token exists, and the
// cache is missing or older than 24h. Non-blocking — kicked off from init.
async function maybeAutoUpdateMarketplace(): Promise<void> {
  if (!autoUpdateEnabled()) return;
  let token: string | null;
  try {
    token = await tokenStore.get();
  } catch {
    token = null;
  }
  if (!token) return; // toggle stays usable; updates simply need a token
  const cache = await marketplaceStore.load();
  const stale = !cache || Date.now() - cache.updatedAt > MARKETPLACE_MAX_AGE_MS;
  if (!stale) return;
  void onMarketplaceUpdate();
}

function initSubtabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#plugins-section .subtab"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>("#plugins-section .subpanel"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.subtab;
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const p of panels) p.classList.toggle("active", p.dataset.subtab === target);
    });
  }
}

export function initPluginsUI(): void {
  el<HTMLButtonElement>("plugin-add").addEventListener("click", () => void onAddGithub());
  el<HTMLInputElement>("plugin-folder").addEventListener("change", (e) =>
    void onUploadFolder(e.target as HTMLInputElement),
  );
  el<HTMLButtonElement>("gh-token-save").addEventListener("click", () => void onSaveToken());
  el<HTMLButtonElement>("gh-token-clear").addEventListener("click", () => void onClearToken());

  initSubtabs();
  el<HTMLButtonElement>("marketplace-update").addEventListener("click", () => void onMarketplaceUpdate());
  const autoBox = el<HTMLInputElement>("marketplace-autoupdate");
  autoBox.checked = autoUpdateEnabled();
  autoBox.addEventListener("change", () => {
    setAutoUpdate(autoBox.checked);
    if (!autoBox.checked) return;
    // Turned on: nudge an update now if a token exists, else say why it won't.
    void tokenStore
      .get()
      .then((t) => {
        if (t) void maybeAutoUpdateMarketplace();
        else status("Auto-update is on, but updates need a GitHub token (save one in Advanced).", "info");
      })
      .catch(() => undefined);
  });

  void refreshTokenStatus();
  void render();
  void maybeAutoUpdateMarketplace();
}
