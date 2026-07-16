// Options page: edit / import the user's Neovim config (init.lua) that the
// engine loads on boot. Backed by openConfigStore (IndexedDB, Task 1). Every
// store operation is wrapped so a failure surfaces in the status line rather
// than throwing and leaving a blank page.
import { openConfigStore } from "../storage/config-store";
import { initPluginsUI } from "./options-plugins";

const store = openConfigStore();

const CONFIG_FILE = "init.lua";

// Grab the elements up front; if the DOM shape is ever wrong we want to know
// immediately rather than hitting scattered null derefs later.
function require<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

const editor = require<HTMLTextAreaElement>("editor");
const fetchUrl = require<HTMLInputElement>("fetch-url");
const enabledBox = require<HTMLInputElement>("enabled");
const statusEl = require<HTMLDivElement>("status");
const saveBtn = require<HTMLButtonElement>("save");
const fetchBtn = require<HTMLButtonElement>("fetch");
const clearBtn = require<HTMLButtonElement>("clear");

let statusTimer: ReturnType<typeof setTimeout> | undefined;

type StatusKind = "ok" | "err" | "info";

function setStatus(message: string, kind: StatusKind, autoClear = false): void {
  if (statusTimer !== undefined) {
    clearTimeout(statusTimer);
    statusTimer = undefined;
  }
  statusEl.textContent = message;
  statusEl.className = kind;
  if (autoClear) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "";
      statusTimer = undefined;
    }, 5000);
  }
}

document.addEventListener("nib-status", (e) => {
  const d = (e as CustomEvent<{ message: string; kind: "ok" | "err" | "info" }>).detail;
  setStatus(d.message, d.kind, d.kind !== "err");
});

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function loadInitialState(): Promise<void> {
  try {
    const files = await store.loadFiles();
    editor.value = files[CONFIG_FILE] ?? "";
  } catch (err) {
    setStatus(`Failed to load config: ${describeError(err)}`, "err");
  }
  try {
    const meta = await store.getMeta();
    enabledBox.checked = meta.enabled;
  } catch (err) {
    setStatus(`Failed to load settings: ${describeError(err)}`, "err");
  }
}

async function onSave(): Promise<void> {
  saveBtn.disabled = true;
  try {
    await store.saveFile(CONFIG_FILE, editor.value);
    setStatus("Saved ✓ (reload your editor tab to apply)", "ok", true);
  } catch (err) {
    setStatus(`Save failed: ${describeError(err)}`, "err");
  } finally {
    saveBtn.disabled = false;
  }
}

async function onFetch(): Promise<void> {
  const url = fetchUrl.value.trim();
  if (!url) {
    setStatus("Enter a URL to fetch from.", "info");
    return;
  }
  fetchBtn.disabled = true;
  setStatus("Fetching…", "info");
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    editor.value = text;
    setStatus("Fetched ✓ — review, then click Save to keep it.", "ok");
  } catch (err) {
    setStatus(
      `Fetch failed: ${describeError(err)} — some hosts block cross-origin fetch; raw GitHub / gists usually work.`,
      "err",
    );
  } finally {
    fetchBtn.disabled = false;
  }
}

async function onToggleEnabled(): Promise<void> {
  const enabled = enabledBox.checked;
  try {
    await store.setMeta({ enabled });
    setStatus(
      enabled ? "Config will load on boot." : "Editors will boot clean.",
      "info",
      true,
    );
  } catch (err) {
    // Revert the checkbox so it keeps reflecting persisted state.
    enabledBox.checked = !enabled;
    setStatus(`Failed to update setting: ${describeError(err)}`, "err");
  }
}

async function onClear(): Promise<void> {
  const ok = confirm(
    "Clear your saved Neovim config? This deletes init.lua from this browser and cannot be undone.",
  );
  if (!ok) return;
  clearBtn.disabled = true;
  try {
    await store.clear();
    editor.value = "";
    setStatus("Config cleared. (reload your editor tab to apply)", "ok", true);
  } catch (err) {
    setStatus(`Clear failed: ${describeError(err)}`, "err");
  } finally {
    clearBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", () => void onSave());
fetchBtn.addEventListener("click", () => void onFetch());
clearBtn.addEventListener("click", () => void onClear());
enabledBox.addEventListener("change", () => void onToggleEnabled());

void loadInitialState();
initPluginsUI();
