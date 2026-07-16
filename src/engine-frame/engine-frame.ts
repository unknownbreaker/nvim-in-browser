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
const client = new NvimClient(
  chrome.runtime.getURL("engine-worker.js"),
  chrome.runtime.getURL("nvim-asyncify.wasm"),
  chrome.runtime.getURL("nvim-runtime.tar.gz"),
);

// Small, generic automation/debugging hook. Exposed on window so a headless
// browser (or DevTools) can observe readiness, read the buffer, drive input,
// and watch idle poll wake-ups without reaching into module internals.
const debug = {
  ready: false,
  wakeupsPerSecond: 0,
  getBufferText: (): Promise<string> => currentText(),
  input: (keys: string): void => client.input(keys),
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

client.onRedraw = (batch) => {
  renderer.apply(batch);
  // Park the hidden IME input at the caret so the composition candidate window
  // appears where the user is typing.
  const p = renderer.cursorPixel();
  ime.style.left = `${p.x}px`;
  ime.style.top = `${p.y}px`;
  ime.style.height = `${p.height}px`;
};

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
client.onStat = (wps) => {
  debug.wakeupsPerSecond = wps;
  console.log(`[nvim] poll wakeups/sec: ${wps}`);
};
// Engine gone (clean exit or post-boot fatal): post the last known text. On
// null the parent keeps the field's last synced value, so this never regresses.
const postDeactivateFinal = (): void => {
  parent.postMessage({ type: "nvim-deactivate", text: cachedFinalText }, "*");
};
client.onExit = postDeactivateFinal;
client.onFatal = postDeactivateFinal;

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
client.onEvent = (method, args) => {
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

async function init(seedText: unknown): Promise<void> {
  await client.start(cols, rows);
  debug.ready = true;
  if (typeof seedText === "string" && seedText.length > 0) {
    await client.request("nvim_buf_set_lines", [0, 0, -1, false, seedText.split("\n")]);
  }
  await installBufferHooks();
  void syncClipboardIn();
  parent.postMessage({ type: "nvim-ready" }, "*");
  ime.focus();
}

if (mode === "embed") {
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m?.type === "nvim-init") void init(m.text);
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
  await client.start(cols, rows);
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
