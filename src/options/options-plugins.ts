// Options-page plugin manager: install pure-Lua plugins from GitHub (owner/repo)
// or a folder upload, list installed plugins with per-plugin enable/disable,
// refresh (github only), and remove. All store ops are wrapped so failures land
// in the shared status line, never a blank page. Thin UI over the tested
// plugin-store + github-fetch + folder-upload units.
import { openPluginStore, isSafePluginName, type PluginRecord } from "../storage/plugin-store";
import { fetchGithubPlugin, GithubFetchError } from "../plugins/github-fetch";
import { openTokenStore } from "../storage/token-store";
import { readFolderUpload } from "./folder-upload";

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
        return "Plugin exceeds the 200-file / 5 MB limit.";
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
    list.append(renderRow(p));
  }
}

function renderRow(p: PluginRecord): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "checkbox-row";
  li.style.marginBottom = "8px";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = p.enabled;
  toggle.addEventListener("change", () => void onToggle(p.name, toggle));

  const label = document.createElement("label");
  label.style.flex = "1 1 auto";
  const src = p.source === "github" ? `github: ${p.repo}@${p.ref}` : "uploaded";
  // Build with textContent, not innerHTML: p.repo/p.ref are user-supplied, so
  // interpolating them into markup would be an injection vector (self-XSS on a
  // tampered IndexedDB record).
  const nameEl = document.createElement("strong");
  nameEl.textContent = p.name;
  const meta = document.createElement("span");
  meta.className = "hint";
  meta.style.color = "var(--subtext)";
  meta.textContent = ` ${src} · ${p.files.length} files`;
  label.append(nameEl, meta);

  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.margin = "0";
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

  li.append(toggle, label, actions);
  return li;
}

async function onToggle(name: string, box: HTMLInputElement): Promise<void> {
  const enabled = box.checked;
  try {
    await store.setEnabled(name, enabled);
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
    const { files } = await fetchGithubPlugin(p.repo, p.ref, { token });
    await store.add({ ...p, files, addedAt: Date.now() });
    status(`Refreshed ${p.name} (${files.length} files). (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Refresh failed: ${fetchErrorMessage(err)}`, "err");
  }
}

async function onAddGithub(): Promise<void> {
  const repo = el<HTMLInputElement>("plugin-repo").value.trim();
  const ref = el<HTMLInputElement>("plugin-ref").value.trim() || "main";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    status("Enter a plugin as owner/repo (e.g. echasnovski/mini.nvim).", "info");
    return;
  }
  const name = repo.split("/")[1];
  if (!isSafePluginName(name)) {
    status(`Unsafe plugin name derived from repo: ${name}`, "err");
    return;
  }
  const btn = el<HTMLButtonElement>("plugin-add");
  btn.disabled = true;
  status(`Fetching ${repo}@${ref}…`, "info");
  try {
    if (await store.get(name)) {
      status(`A plugin named "${name}" is already installed — remove or refresh it first.`, "err");
      return;
    }
    const token = (await tokenStore.get()) ?? undefined;
    const { files } = await fetchGithubPlugin(repo, ref, { token });
    if (files.length === 0) {
      status(`No .lua/.vim files found in ${repo}@${ref}.`, "err");
      return;
    }
    await store.add({ name, source: "github", repo, ref, enabled: true, files, addedAt: Date.now() });
    el<HTMLInputElement>("plugin-repo").value = "";
    el<HTMLInputElement>("plugin-ref").value = "";
    status(`Installed ${name} (${files.length} files). (reload your editor)`, "ok");
    await render();
  } catch (err) {
    status(`Install failed: ${fetchErrorMessage(err)}`, "err");
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
