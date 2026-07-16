// Engine frame: a full-page canvas that boots the nvim engine worker, renders
// its grid, and forwards keyboard input. Runs as its own extension page so the
// engine worker and its 8 MB wasm are isolated from host pages.
//
// Modes (via ?mode= query param):
//   full  — used by the scratch page; boots immediately, focuses the canvas.
//   embed — used by the Task 7 content script; waits for a `nvim-init`
//           postMessage from the parent, seeds the buffer, and streams buffer
//           text back on change (debounced) plus deactivate/ready signals.
import { NvimClient } from "../engine/client";
import { openScratchStore, serializeError } from "../scratch/scratch-store";
import { openConfigStore } from "../storage/config-store";
import { GridRenderer } from "../ui/grid-renderer";
import { isEscapeChord, keyEventToNvim } from "../ui/keymap";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "full";

const canvas = document.getElementById("grid") as HTMLCanvasElement;
// Hidden-but-focusable input that owns focus so the browser routes IME
// composition (and its candidate window) here. keydown still bubbles to
// `document`, so the normal keymap path is unaffected for non-composition keys.
const ime = document.getElementById("ime") as HTMLInputElement;
const renderer = new GridRenderer(canvas);
// Build a fresh engine client. Factored out so the safe-mode fallback can
// replace a wedged config client with an identically-constructed clean one.
function makeClient(): NvimClient {
  return new NvimClient(
    chrome.runtime.getURL("engine-worker.js"),
    chrome.runtime.getURL("nvim-asyncify.wasm"),
    chrome.runtime.getURL("nvim-runtime.tar.gz"),
  );
}
// Reassignable: bootWithSafeMode swaps in a fresh client on config-boot failure.
// All code references the current binding, so the swap is transparent.
let client = makeClient();

// Small, generic automation/debugging hook. Exposed on window so a headless
// browser (or DevTools) can observe readiness, read the buffer, drive input,
// and watch idle poll wake-ups without reaching into module internals.
const debug = {
  ready: false,
  // True once a config boot failed and the frame fell back to a clean engine.
  // Stays false for clean boots and successful config boots. Read by smokes.
  safeMode: false,
  wakeupsPerSecond: 0,
  getBufferText: (): Promise<string> => currentText(),
  input: (keys: string): void => client.input(keys),
  // Generic RPC passthrough so a headless smoke can query/mutate nvim state
  // (e.g. read `&filetype`, or `setlocal filetype=...`) without module internals.
  request: (method: string, params: unknown[]): Promise<unknown> => client.request(method, params),
};
(window as unknown as { __nvim: typeof debug }).__nvim = debug;

// Final buffer text carried out-of-band by the VimLeavePre autocmd (see
// init()). `:q`/`:wq` can fire after the last debounce flush, so onExit/onFatal
// relay this cached snapshot rather than losing edits since the last sync.
let cachedFinalText: string | null = null;

// Full/scratch mode installs a debounced-save callback here so the shared
// wasm_text_changed handler can drive persistence. Stays null in embed mode,
// which leaves the embed-only `nvim-text` post as the sole change reaction.
let scratchOnChange: (() => void) | null = null;

// IME composition: while composing, keydown events feed the input (and are
// suppressed in the document handler below). On compositionend, forward the
// finished text to nvim as literal input and reset the field.
let composing = false;
ime.addEventListener("compositionstart", () => {
  composing = true;
});
ime.addEventListener("compositionend", (ev) => {
  composing = false;
  const text = (ev as CompositionEvent).data ?? "";
  if (text) client.input(text);
  ime.value = "";
});
// Guard: any stray text that lands outside composition is dropped so it can't
// leak into nvim or accumulate in the input.
ime.addEventListener("input", () => {
  if (!composing) ime.value = "";
});
// Engine gone (clean exit or post-boot fatal): post the last known text. On
// null the parent keeps the field's last synced value, so this never regresses.
const postDeactivateFinal = (): void => {
  parent.postMessage({ type: "nvim-deactivate", text: cachedFinalText }, "*");
};

const { cols, rows } = renderer.gridForSize(innerWidth, innerHeight);

document.addEventListener("keydown", (ev) => {
  if (isEscapeChord(ev)) {
    ev.preventDefault();
    void deactivate();
    return;
  }
  // Keys that are feeding an active IME composition (isComposing) or the
  // pre-composition sentinel (keyCode 229) must not be forwarded to nvim — the
  // composed text arrives via compositionend instead. Checked after the escape
  // chord so the chord always wins.
  if (ev.isComposing || ev.keyCode === 229) return;
  const keys = keyEventToNvim(ev);
  if (keys !== null) {
    ev.preventDefault();
    client.input(keys);
  }
});

function decodeLine(line: unknown): string {
  return line instanceof Uint8Array ? new TextDecoder().decode(line) : String(line);
}

async function currentText(): Promise<string> {
  const lines = (await client.request("nvim_buf_get_lines", [0, 0, -1, false])) as unknown[];
  return lines.map(decodeLine).join("\n");
}

async function deactivate(): Promise<void> {
  // Race the buffer pull against a timeout: if the engine is dead or hung after
  // boot, fall back to the last known text instead of wedging the escape chord
  // forever. The parent still has the last synced value as a floor.
  const timeout = new Promise<string | null>((resolve) =>
    setTimeout(() => resolve(cachedFinalText), 500),
  );
  const text = await Promise.race([currentText(), timeout]);
  parent.postMessage({ type: "nvim-deactivate", text }, "*");
}

// Embed mode: nvim pushes a `wasm_text_changed` rpcnotify on every buffer edit
// (see the autocmd installed in init()). Debounce buffer pulls so a burst of
// keystrokes yields a single nvim_buf_get_lines + postMessage.
let syncTimer: ReturnType<typeof setTimeout> | null = null;

// Attach every worker-event handler to a client. Factored out so the initial
// client and any safe-mode replacement client are wired identically; each
// handler closes over the shared module state (renderer, ime, debug,
// currentText, syncTimer, scratchOnChange, cachedFinalText). Keep this the sole
// definition of these handlers so the two clients can never drift.
function wireClient(c: NvimClient): void {
  c.onRedraw = (batch) => {
    renderer.apply(batch);
    // Park the hidden IME input at the caret so the composition candidate window
    // appears where the user is typing.
    const p = renderer.cursorPixel();
    ime.style.left = `${p.x}px`;
    ime.style.top = `${p.y}px`;
    ime.style.height = `${p.height}px`;
  };
  c.onStat = (wps) => {
    debug.wakeupsPerSecond = wps;
    console.log(`[nvim] poll wakeups/sec: ${wps}`);
  };
  c.onExit = postDeactivateFinal;
  c.onFatal = postDeactivateFinal;
  c.onEvent = (method, args) => {
    if (method === "wasm_text_final") {
      // VimLeavePre payload: the whole buffer joined by "\n". Cache it so
      // onExit/onFatal can relay it even if no debounce flush has run.
      if (typeof args[0] === "string") cachedFinalText = args[0];
      return;
    }
    if (method === "clipboard_copy") {
      // A `+`/`*` yank fired: mirror v:event.regcontents (a list of lines, each a
      // Uint8Array or string) out to the system clipboard. Runs in both modes.
      const lines = (args[0] as unknown[]).map(decodeLine);
      void navigator.clipboard.writeText(lines.join("\n")).catch((e) =>
        console.warn("[clipboard] write failed:", serializeError(e)),
      );
      return;
    }
    if (method !== "wasm_text_changed") return;
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void currentText().then((text) => parent.postMessage({ type: "nvim-text", text }, "*"));
    }, 300);
    if (scratchOnChange) scratchOnChange();
  };
}

// Wire the initial client. A safe-mode retry re-runs wireClient on its fresh
// client, so this must run before any client.start.
wireClient(client);

// Resolve how to boot nvim from the persisted user config. When the config is
// enabled and carries a non-empty init.lua, return the argv that lets nvim read
// $XDG_CONFIG_HOME/nvim/init.lua (dropping `-u NORC --noplugin`) plus every
// config file staged into the worker FS under /home/.config/nvim. Any IndexedDB
// failure degrades to a clean boot — persistence problems must never keep the
// editor from starting.
async function resolveBoot(): Promise<{
  argv?: string[];
  configFiles?: { path: string; data: Uint8Array }[];
  usedConfig: boolean;
}> {
  try {
    const store = openConfigStore();
    const [meta, files] = await Promise.all([store.getMeta(), store.loadFiles()]);
    const initLua = files["init.lua"];
    if (meta.enabled && typeof initLua === "string" && initLua.trim().length > 0) {
      const encoder = new TextEncoder();
      const configFiles = Object.entries(files).map(([relpath, content]) => ({
        path: "/home/.config/nvim/" + relpath,
        data: encoder.encode(content),
      }));
      return { argv: ["nvim", "--embed", "-i", "NONE", "-n"], configFiles, usedConfig: true };
    }
  } catch (e) {
    console.warn("[config] load failed, booting without config:", serializeError(e));
  }
  return { usedConfig: false };
}

// One-line in-frame notice that the config didn't load. Cheap and best-effort;
// debug.safeMode is the authoritative signal for smokes.
function showSafeModeBanner(): void {
  const banner = document.createElement("div");
  banner.textContent = "⚠ config failed — started in safe mode";
  banner.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:9999;padding:4px 8px;" +
    "font:12px system-ui,sans-serif;color:#000;background:#f5c518;text-align:center;";
  document.body.appendChild(banner);
}

// Boot nvim, falling back to a clean "safe mode" if the user config fails. A
// broken config can either reject start() (a pre-ready fatal) or hang forever
// (never resolving nvim_ui_attach), so the config boot races a 12s timeout. On
// either failure the config client is disposed and a fresh one boots with no
// config, so the editor always comes up. The fresh client becomes the module
// `client`, so installBufferHooks/seed/etc. run against whichever boot won.
async function bootWithSafeMode(cols: number, rows: number): Promise<void> {
  const boot = await resolveBoot();
  if (!boot.usedConfig) {
    await client.start(cols, rows);
    return;
  }
  try {
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("config boot timed out")), 12_000),
    );
    await Promise.race([
      client.start(cols, rows, { argv: boot.argv, configFiles: boot.configFiles }),
      timeout,
    ]);
    debug.safeMode = false;
  } catch (e) {
    console.warn("config failed to load; started in safe mode:", serializeError(e));
    client.dispose();
    client = makeClient();
    wireClient(client);
    await client.start(cols, rows);
    debug.safeMode = true;
    showSafeModeBanner();
  }
}

// Query the RPC channel id from nvim (rather than assuming the embed channel is
// always 1) and install the buffer autocmds that push edits back over it. Shared
// by embed mode and full/scratch mode; returns the channel id for callers that
// want it. TextChanged drives change notifications; VimLeavePre carries the
// final buffer snapshot for exit relays.
async function installBufferHooks(): Promise<number> {
  const apiInfo = (await client.request("nvim_get_api_info", [])) as unknown[];
  const channel = typeof apiInfo[0] === "number" ? apiInfo[0] : 1;
  await client.request("nvim_exec2", [
    [
      `autocmd TextChanged,TextChangedI * call rpcnotify(${channel}, 'wasm_text_changed')`,
      `autocmd VimLeavePre * call rpcnotify(${channel}, 'wasm_text_final', join(getline(1,'$'),"\\n"))`,
      `autocmd TextYankPost * if v:event.regname ==# '+' || v:event.regname ==# '*' | call rpcnotify(${channel}, 'clipboard_copy', v:event.regcontents) | endif`,
    ].join("\n"),
    {},
  ]);
  return channel;
}

// Pull the system clipboard into nvim's `+`/`*` registers so `"+p`/`"*p` paste
// what the user copied elsewhere. Runs on focus/visibility (browsers only grant
// clipboard reads to the focused document), so the registers reflect the
// clipboard as of the last sync rather than being always-fresh. Guarded by an
// in-flight flag so overlapping focus/visibility events don't stack requests.
let clipboardInFlight = false;
async function syncClipboardIn(): Promise<void> {
  if (clipboardInFlight) return;
  clipboardInFlight = true;
  try {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return; // no permission / not focused — leave registers as-is
    }
    // Normalize CRLF to LF, and treat a trailing newline as "linewise" (a
    // whole-line copy) rather than leaving a spurious blank element from
    // split("\n") — "hello\nworld\n".split("\n") is ["hello","world",""].
    const normalized = text.replace(/\r\n/g, "\n");
    if (normalized === "") return;
    const linewise = normalized.endsWith("\n");
    const body = linewise ? normalized.slice(0, -1) : normalized;
    const lines = body.split("\n");
    const regtype = linewise ? "l" : "c";
    try {
      await client.request("nvim_call_function", ["setreg", ["+", lines, regtype]]);
      await client.request("nvim_call_function", ["setreg", ["*", lines, regtype]]);
    } catch (e) {
      console.warn("[clipboard] setreg failed:", serializeError(e));
    }
  } finally {
    clipboardInFlight = false;
  }
}

// Keep the `+`/`*` registers current whenever this frame regains focus or
// becomes visible. Registered once; both surfaces call syncClipboardIn after
// boot for the initial pull.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void syncClipboardIn();
});
window.addEventListener("focus", () => void syncClipboardIn());

async function init(seedText: unknown, filetype?: unknown): Promise<void> {
  await bootWithSafeMode(cols, rows);
  debug.ready = true;
  if (typeof seedText === "string" && seedText.length > 0) {
    await client.request("nvim_buf_set_lines", [0, 0, -1, false, seedText.split("\n")]);
  }
  // SECURITY: the filetype comes from the parent page via postMessage, so it is
  // untrusted. Validate it against a strict allowlist charset before letting it
  // anywhere near an Ex command — never interpolate raw text into `setlocal`.
  if (typeof filetype === "string" && /^[a-z0-9._-]+$/.test(filetype)) {
    await client.request("nvim_exec2", ["setlocal filetype=" + filetype, {}]);
  }
  await installBufferHooks();
  void syncClipboardIn();
  parent.postMessage({ type: "nvim-ready" }, "*");
  ime.focus();
}

if (mode === "embed") {
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m?.type === "nvim-init") void init(m.text, m.filetype);
  });
} else {
  void startScratch();
}

async function startScratch(): Promise<void> {
  const store = openScratchStore();
  let saved: string | null = null;
  try {
    saved = await store.load();
  } catch (e) {
    console.warn("[scratch] load failed, starting empty:", serializeError(e));
  }
  await bootWithSafeMode(cols, rows);
  debug.ready = true;
  const channel = await installBufferHooks();
  void syncClipboardIn();
  if (saved !== null && saved.length > 0) {
    await client.request("nvim_buf_set_lines", [0, 0, -1, false, saved.split("\n")]);
    // Land the cursor at end-of-buffer so restore feels like resuming.
    await client.request("nvim_input", ["G$"]);
  }
  // Debounced save on every buffer change (reuses the wasm_text_changed notify).
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void currentText().then((t) => store.save(t)).catch((e) =>
        console.warn("[scratch] save failed:", serializeError(e)),
      );
    }, 400);
  };
  scratchOnChange = scheduleSave; // consumed by the onEvent handler
  // Best-effort flush when the tab is hidden or closing.
  const flush = () => {
    void currentText().then((t) => store.save(t)).catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("beforeunload", flush);
  void channel; // channel already used by installBufferHooks; kept for clarity
  ime.focus();
}
