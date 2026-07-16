// Options-page plugin manager: install pure-Lua plugins from GitHub (owner/repo)
// or a folder upload, list installed plugins with per-plugin enable/disable,
// refresh (github only), and remove. All store ops are wrapped so failures land
// in the shared status line, never a blank page. Thin UI over the tested
// plugin-store + github-fetch + folder-upload units.
import { openPluginStore, isSafePluginName, type PluginRecord } from "../storage/plugin-store";
import { fetchGithubPlugin, GithubFetchError } from "../plugins/github-fetch";
import { openTokenStore } from "../storage/token-store";
import { readFolderUpload } from "./folder-upload";
import { CURATED_PLUGINS, type CuratedPlugin } from "./plugin-catalog";

const store = openPluginStore();
const tokenStore = openTokenStore();

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
  // Compute the installed-name set ONCE and drive the shelf off it, so the
  // curated shelf and the installed grid always reflect the same store read.
  const installedNames = new Set(plugins.map((p) => p.name));
  renderShelf(installedNames);
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

// --- Curated shelf: recommended pure-Lua plugins with one-click install ------
// Rebuilt on every render() off the installed-name set, so a card flips to
// "Installed ✓" the moment its plugin lands in the store (and back if removed).
function renderShelf(installedNames: Set<string>): void {
  const shelf = el<HTMLDivElement>("plugin-shelf");
  shelf.textContent = "";
  for (const entry of CURATED_PLUGINS) {
    shelf.append(renderShelfCard(entry, installedNames.has(entry.name)));
  }
}

function renderShelfCard(entry: CuratedPlugin, installed: boolean): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "shelf-card";

  const header = document.createElement("div");
  header.className = "shelf-card-header";
  // Static catalog strings, but built with textContent for consistency.
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

async function onShelfInstall(entry: CuratedPlugin, btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Installing…";
  // Blank ref -> installFromGithub lets fetchGithubPlugin resolve the repo's
  // default branch (master vs main vs …). On success it re-renders, which
  // rebuilds this shelf and detaches this button (flipped to "Installed ✓").
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

export function initPluginsUI(): void {
  el<HTMLButtonElement>("plugin-add").addEventListener("click", () => void onAddGithub());
  el<HTMLInputElement>("plugin-folder").addEventListener("change", (e) =>
    void onUploadFolder(e.target as HTMLInputElement),
  );
  el<HTMLButtonElement>("gh-token-save").addEventListener("click", () => void onSaveToken());
  el<HTMLButtonElement>("gh-token-clear").addEventListener("click", () => void onClearToken());
  void refreshTokenStatus();
  void render();
}
