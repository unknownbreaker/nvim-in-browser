// Options-page config file-manager: a list of ~/.config/nvim files with a
// click-to-edit textarea, add/rename/delete, folder import, fetch-to-init.lua,
// clear-all, and the master enable toggle. Thin UI over the config-store +
// folder-upload units. Drives the shared status line via the nib-status event.
import { openConfigStore, isSafeRelpath } from "../storage/config-store";
import { readFolderUpload } from "./folder-upload";

const store = openConfigStore();
let current = "init.lua"; // relpath being edited
// The current file's on-disk content. Save is enabled only when the editor
// differs from this; right after a save it matches, so Save disables again —
// which (with the status line) is the confirmation that the save landed.
let savedValue = "";

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as unknown as T;
}
function status(message: string, kind: "ok" | "err" | "info"): void {
  document.dispatchEvent(new CustomEvent("nib-status", { detail: { message, kind } }));
}
// Nudge the nav badges + Overview pane to re-read after a store write.
function refreshShell(): void {
  document.dispatchEvent(new CustomEvent("nib-refresh"));
}
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
// Enable Save only when the editor has unsaved changes.
function syncSaveButton(): void {
  el<HTMLButtonElement>("save").disabled = el<HTMLTextAreaElement>("editor").value === savedValue;
}

// Debounced autosave: after a pause in typing, persist the current file so edits
// aren't lost when switching files or closing the tab. The manual Save button
// still works (immediate) and doubles as the unsaved-changes indicator.
const AUTOSAVE_MS = 800;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

async function flushAutosave(): Promise<void> {
  clearTimeout(autosaveTimer);
  autosaveTimer = undefined;
  const value = el<HTMLTextAreaElement>("editor").value;
  if (value === savedValue) return; // nothing changed since the last save
  try {
    await store.saveFile(current, value);
    savedValue = value;
    syncSaveButton();
    status(`Autosaved ${current} ✓`, "ok");
  } catch (err) {
    status(`Autosave failed: ${describe(err)}`, "err");
  }
}

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void flushAutosave(), AUTOSAVE_MS);
}

// Save the file being left, then open another (used by the file-list clicks).
async function switchTo(name: string): Promise<void> {
  await flushAutosave();
  await select(name);
}

async function refreshList(): Promise<void> {
  const list = el<HTMLUListElement>("config-list");
  let files: Record<string, string>;
  try {
    files = await store.loadFiles();
  } catch (err) {
    status(`Failed to load config: ${describe(err)}`, "err");
    return;
  }
  const names = Object.keys(files).sort();
  if (!names.includes("init.lua")) names.unshift("init.lua"); // always offer init.lua
  list.textContent = "";
  for (const name of names) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = name;
    btn.style.width = "100%";
    btn.style.textAlign = "left";
    btn.style.marginBottom = "4px";
    if (name === current) btn.className = "primary";
    btn.addEventListener("click", () => void switchTo(name));
    li.append(btn);
    list.append(li);
  }
}

async function select(name: string): Promise<void> {
  clearTimeout(autosaveTimer); // cancel any pending save for the file we're leaving
  current = name;
  el<HTMLLabelElement>("config-editing-label").textContent = name;
  try {
    const files = await store.loadFiles();
    el<HTMLTextAreaElement>("editor").value = files[name] ?? "";
    savedValue = el<HTMLTextAreaElement>("editor").value;
    syncSaveButton();
  } catch (err) {
    status(`Failed to open ${name}: ${describe(err)}`, "err");
  }
  await refreshList();
}

async function onSave(): Promise<void> {
  clearTimeout(autosaveTimer); // a manual save preempts the pending autosave
  el<HTMLButtonElement>("save").disabled = true;
  try {
    const value = el<HTMLTextAreaElement>("editor").value;
    await store.saveFile(current, value);
    savedValue = value;
    status(`Saved ${current} ✓ (reload your editor tab to apply)`, "ok");
    await refreshList();
  } catch (err) {
    status(`Save failed: ${describe(err)}`, "err");
  } finally {
    // Success: matches savedValue -> stays disabled (the "saved" signal).
    // Failure: still dirty -> re-enabled so the user can retry.
    syncSaveButton();
  }
}

async function onAdd(): Promise<void> {
  const path = el<HTMLInputElement>("config-new").value.trim();
  if (!path) return;
  if (!isSafeRelpath(path)) {
    status(`Unsafe path: ${path}`, "err");
    return;
  }
  try {
    const files = await store.loadFiles();
    if (path in files) {
      el<HTMLInputElement>("config-new").value = "";
      status(`${path} already exists — select it to edit.`, "info");
      await select(path);
      return;
    }
    await store.saveFile(path, "");
    el<HTMLInputElement>("config-new").value = "";
    await select(path);
    status(`Created ${path}.`, "ok");
  } catch (err) {
    status(`Create failed: ${describe(err)}`, "err");
  }
}

async function onRename(): Promise<void> {
  const to = prompt(`Rename ${current} to:`, current);
  if (!to || to === current) return;
  if (!isSafeRelpath(to)) {
    status(`Unsafe path: ${to}`, "err");
    return;
  }
  try {
    await store.renameFile(current, to);
    await select(to);
    status(`Renamed to ${to}. (reload your editor)`, "ok");
  } catch (err) {
    status(`Rename failed: ${describe(err)}`, "err");
  }
}

async function onDelete(): Promise<void> {
  if (!confirm(`Delete config file "${current}"?`)) return;
  try {
    await store.deleteFile(current);
    status(`Deleted ${current}. (reload your editor)`, "ok");
    await select("init.lua");
  } catch (err) {
    status(`Delete failed: ${describe(err)}`, "err");
  }
}

async function onImportFolder(input: HTMLInputElement): Promise<void> {
  if (!input.files || input.files.length === 0) return;
  try {
    const files = await readFolderUpload(input.files);
    if (files.length === 0) {
      status("No usable files in the selected folder.", "err");
      return;
    }
    const dec = new TextDecoder();
    for (const f of files) await store.saveFile(f.path, dec.decode(f.data));
    status(`Imported ${files.length} config files. (reload your editor)`, "ok");
    await select("init.lua");
  } catch (err) {
    status(`Import failed: ${describe(err)}`, "err");
  } finally {
    input.value = "";
  }
}

async function onFetch(): Promise<void> {
  const url = el<HTMLInputElement>("fetch-url").value.trim();
  if (!url) {
    status("Enter a URL to fetch from.", "info");
    return;
  }
  const btn = el<HTMLButtonElement>("fetch");
  btn.disabled = true;
  status("Fetching…", "info");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    const files = await store.loadFiles();
    current = "init.lua";
    el<HTMLLabelElement>("config-editing-label").textContent = "init.lua";
    savedValue = files["init.lua"] ?? "";
    el<HTMLTextAreaElement>("editor").value = text;
    syncSaveButton(); // fetched text differs from saved -> Save enabled
    await refreshList();
    status("Fetched ✓ into init.lua — review, then Save.", "ok");
  } catch (err) {
    status(`Fetch failed: ${describe(err)} — some hosts block cross-origin fetch; raw GitHub / gists usually work.`, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onClear(): Promise<void> {
  if (!confirm("Clear ALL saved config files from this browser? This cannot be undone.")) return;
  try {
    await store.clear();
    el<HTMLTextAreaElement>("editor").value = "";
    status("Config cleared. (reload your editor)", "ok");
    await select("init.lua");
  } catch (err) {
    status(`Clear failed: ${describe(err)}`, "err");
  }
}

async function onToggleEnabled(box: HTMLInputElement): Promise<void> {
  const enabled = box.checked;
  try {
    await store.setMeta({ enabled });
    refreshShell();
    status(enabled ? "Config + plugins will load on boot." : "Editors will boot clean.", "info");
  } catch (err) {
    box.checked = !enabled;
    status(`Failed to update setting: ${describe(err)}`, "err");
  }
}

export function initConfigUI(): void {
  el<HTMLTextAreaElement>("editor").addEventListener("input", () => {
    syncSaveButton();
    scheduleAutosave();
  });
  // Don't lose a pending autosave when the tab is hidden or closed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAutosave();
  });
  window.addEventListener("beforeunload", () => void flushAutosave());
  el<HTMLButtonElement>("save").addEventListener("click", () => void onSave());
  el<HTMLButtonElement>("config-add").addEventListener("click", () => void onAdd());
  el<HTMLButtonElement>("config-rename").addEventListener("click", () => void onRename());
  el<HTMLButtonElement>("config-delete").addEventListener("click", () => void onDelete());
  el<HTMLButtonElement>("fetch").addEventListener("click", () => void onFetch());
  el<HTMLButtonElement>("clear").addEventListener("click", () => void onClear());
  el<HTMLInputElement>("config-folder").addEventListener("change", (e) =>
    void onImportFolder(e.target as HTMLInputElement),
  );
  const box = el<HTMLInputElement>("enabled");
  box.addEventListener("change", () => void onToggleEnabled(box));
  store
    .getMeta()
    .then((m) => (box.checked = m.enabled))
    .catch(() => undefined);
  void select("init.lua");
}
