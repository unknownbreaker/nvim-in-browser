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
import { GridRenderer } from "../ui/grid-renderer";
import { isEscapeChord, keyEventToNvim } from "../ui/keymap";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "full";

const canvas = document.getElementById("grid") as HTMLCanvasElement;
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

client.onRedraw = (batch) => renderer.apply(batch);
client.onStat = (wps) => {
  debug.wakeupsPerSecond = wps;
  console.log(`[nvim] poll wakeups/sec: ${wps}`);
};
client.onExit = () => parent.postMessage({ type: "nvim-deactivate", text: null }, "*");

const { cols, rows } = renderer.gridForSize(innerWidth, innerHeight);

document.addEventListener("keydown", (ev) => {
  if (isEscapeChord(ev)) {
    ev.preventDefault();
    void deactivate();
    return;
  }
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
  const text = await currentText();
  parent.postMessage({ type: "nvim-deactivate", text }, "*");
}

// Embed mode: nvim pushes a `wasm_text_changed` rpcnotify on every buffer edit
// (see the autocmd installed in init()). Debounce buffer pulls so a burst of
// keystrokes yields a single nvim_buf_get_lines + postMessage.
let syncTimer: ReturnType<typeof setTimeout> | null = null;
client.onEvent = (method) => {
  if (method !== "wasm_text_changed") return;
  if (syncTimer !== null) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void currentText().then((text) => parent.postMessage({ type: "nvim-text", text }, "*"));
  }, 300);
};

async function init(seedText: unknown): Promise<void> {
  await client.start(cols, rows);
  debug.ready = true;
  if (typeof seedText === "string" && seedText.length > 0) {
    await client.request("nvim_buf_set_lines", [0, 0, -1, false, seedText.split("\n")]);
  }
  // Push buffer edits to the page over our RPC channel. Query the channel id
  // from nvim rather than assuming the embed channel is always 1.
  const apiInfo = (await client.request("nvim_get_api_info", [])) as unknown[];
  const channel = typeof apiInfo[0] === "number" ? apiInfo[0] : 1;
  await client.request("nvim_exec2", [
    `autocmd TextChanged,TextChangedI * call rpcnotify(${channel}, 'wasm_text_changed')`,
    {},
  ]);
  parent.postMessage({ type: "nvim-ready" }, "*");
  canvas.focus();
}

if (mode === "embed") {
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m?.type === "nvim-init") void init(m.text);
  });
} else {
  void client.start(cols, rows).then(() => {
    debug.ready = true;
    canvas.focus();
  });
}
