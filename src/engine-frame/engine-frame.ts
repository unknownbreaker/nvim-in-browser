// Engine frame: a full-page canvas that boots the nvim engine worker, renders
// its grid, and forwards keyboard input. Runs as its own extension page so the
// engine worker and its ~11 MB wasm are isolated from host pages.
//
// Modes (via ?mode= query param):
//   full  — used by the scratch page; boots immediately, focuses the canvas.
//   embed — used by the Task 7 content script; waits for a `nvim-init`
//           postMessage from the parent, seeds the buffer, and streams buffer
//           text back on change (debounced) plus deactivate/ready signals.
import { NvimClient } from "../engine/client";
import { openScratchStore, serializeError, type ScratchStore } from "../scratch/scratch-store";
import { openConfigStore } from "../storage/config-store";
import { openPluginStore } from "../storage/plugin-store";
import { pluginsToConfigFiles } from "../plugins/pack-layout";
import { GridRenderer } from "../ui/grid-renderer";
import { isEscapeChord, isToggleChord, keyEventToNvim } from "../ui/keymap";

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
    // Keys the worker's compiled-module cache so later boots skip the ~11 MB
    // recompile. The version bumps on every release (new engine), invalidating it.
    chrome.runtime.getManifest().version,
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
  // Live wasm heap size (bytes) from the latest stat sample. 0 until the first
  // 5s stat arrives. Feeds the memory watchdog and is read by smokes.
  memoryBytes: 0,
  // True once the memory watchdog tripped and stopped the editor (no respawn).
  memoryCapped: false,
  // True while an idle-torn-down scratch instance is sleeping (worker disposed,
  // waiting for a keydown/click to respawn). Read by the idle-teardown smoke.
  sleeping: false,
  getBufferText: (): Promise<string> => currentText(),
  input: (keys: string): void => client.input(keys),
  // Generic RPC passthrough so a headless smoke can query/mutate nvim state
  // (e.g. read `&filetype`, or `setlocal filetype=...`) without module internals.
  request: (method: string, params: unknown[]): Promise<unknown> => client.request(method, params),
};
(window as unknown as { __nvim: typeof debug }).__nvim = debug;

// Resource-lifecycle budgets (scratch/full mode). A runaway config/plugin that
// blows past MEM_CAP_BYTES is stopped (no respawn — avoid a crash loop); an
// instance left untouched for IDLE_TEARDOWN_MS is torn down and respawned on the
// next input to reclaim its ~11 MB wasm + worker.
const MEM_CAP_BYTES = 700 * 1024 * 1024;
const IDLE_TEARDOWN_MS = 5 * 60 * 1000;

// Idle-teardown state (scratch/full mode only; stays inert in embed mode).
// `armIdleTimer` restarts the idle countdown on any input; `resumeFromSleep`
// respawns a torn-down instance. Both are installed by installIdleLifecycle and
// left null in embed mode. `idleTimer` holds the pending teardown timeout.
let armIdleTimer: (() => void) | null = null;
let resumeFromSleep: (() => Promise<void>) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let sleepingOverlay: HTMLDivElement | null = null;

// Resolve the idle-teardown delay at arm time so a smoke can shorten it by
// setting `window.__nvimIdleMs` before boot (avoids waiting the full 5 min).
function idleTeardownMs(): number {
  const override = (window as unknown as { __nvimIdleMs?: number }).__nvimIdleMs;
  return typeof override === "number" && override > 0 ? override : IDLE_TEARDOWN_MS;
}

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

// Keep nvim's grid sized to the frame. When the parent resizes the overlay
// iframe (it tracks the underlying field) — or the scratch window resizes — the
// iframe's own window fires a `resize` event. We recompute the grid from the new
// viewport and tell nvim to resize its UI; nvim replies with `grid_resize`, which
// the renderer applies (growing the canvas to fill). Debounced so dragging a
// resize handle doesn't flood the engine, and gated so it's a no-op when there's
// no live engine (pre-ready, sleeping, or memory-capped). References the current
// `client` binding, so it follows a safe-mode/resume swap.
let lastCols = cols;
let lastRows = rows;
let resizeDebounce: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    if (!debug.ready || debug.sleeping || debug.memoryCapped) return;
    const next = renderer.gridForSize(innerWidth, innerHeight);
    if (next.cols === lastCols && next.rows === lastRows) return;
    lastCols = next.cols;
    lastRows = next.rows;
    client.resize(next.cols, next.rows);
  }, 100);
});

document.addEventListener("keydown", (ev) => {
  // Both the escape chord AND the activation chord close the editor (the latter
  // makes the activation shortcut a toggle: press it inside nvim to return to
  // the field). isToggleChord is checked here because, once embedded nvim is
  // focused, the keystroke reaches this frame — not the host content script.
  if (isEscapeChord(ev) || isToggleChord(ev)) {
    ev.preventDefault();
    void deactivate();
    return;
  }
  // A sleeping (idle-torn-down) scratch instance wakes on any key: that key just
  // resumes the engine — it is NOT forwarded as input. Checked before IME/input
  // so the wake always wins.
  if (debug.sleeping) {
    ev.preventDefault();
    void resumeFromSleep?.();
    return;
  }
  // Editor stopped by the memory watchdog: swallow input, there is no live worker.
  if (debug.memoryCapped) {
    ev.preventDefault();
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
  // Any real input restarts the idle countdown (no-op outside scratch mode).
  armIdleTimer?.();
});

function decodeLine(line: unknown): string {
  return line instanceof Uint8Array ? new TextDecoder().decode(line) : String(line);
}

async function currentText(): Promise<string> {
  const lines = (await client.request("nvim_buf_get_lines", [0, 0, -1, false])) as unknown[];
  return lines.map(decodeLine).join("\n");
}

// Guard so the buffer is pulled + posted once, even if two close paths race
// (e.g. the frame keydown and a `nvim-request-close` from the parent).
let deactivating = false;
async function deactivate(): Promise<void> {
  if (deactivating) return;
  deactivating = true;
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
  c.onStat = (stat) => {
    debug.wakeupsPerSecond = stat.wakeupsPerSecond;
    debug.memoryBytes = stat.memoryBytes;
    console.log(
      `[nvim] poll wakeups/sec: ${stat.wakeupsPerSecond}, mem: ${stat.memoryBytes} bytes`,
    );
    // Memory watchdog: a runaway config/plugin that blows past the cap is stopped
    // outright. Dispose the worker, cancel any pending idle teardown, and show a
    // notice — deliberately NO respawn, so a memory-hungry config can't crash-loop.
    if (stat.memoryBytes > MEM_CAP_BYTES && !debug.memoryCapped) {
      debug.memoryCapped = true;
      debug.ready = false;
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      c.dispose();
      showMemoryCapNotice();
    }
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

// Resolve how to boot nvim from the persisted user config AND installed plugins.
// A single master switch (config meta.enabled) gates BOTH: when it is off, boot
// is byte-identical clean — no config files and no plugins, regardless of
// per-plugin flags. When it is on, the returned configFiles union the user's
// config (staged under /home/.config/nvim, included only when init.lua is
// non-empty) with every enabled-plugin file (staged into the site pack dir under
// pack/plugins/start via pluginsToConfigFiles), and the argv drops
// `-u NORC --noplugin` so nvim reads init.lua and auto-sources the pack. If the
// union is empty (no init.lua, no enabled plugins) it also falls back to the
// clean boot. Any IndexedDB failure degrades to a clean boot — persistence
// problems must never keep the editor from starting.
async function resolveBoot(): Promise<{
  argv?: string[];
  configFiles?: { path: string; data: Uint8Array }[];
  usedConfig: boolean;
}> {
  try {
    const configStore = openConfigStore();
    const pluginStore = openPluginStore();
    const [meta, files, plugins] = await Promise.all([
      configStore.getMeta(),
      configStore.loadFiles(),
      pluginStore.list(),
    ]);
    // Master switch: when the user has unchecked "load my config", boot is
    // byte-identical clean — no config files AND no plugins, regardless of
    // per-plugin flags.
    if (!meta.enabled) return { usedConfig: false };

    const encoder = new TextEncoder();
    const configFiles: { path: string; data: Uint8Array }[] = [];
    const initLua = files["init.lua"];
    if (typeof initLua === "string" && initLua.trim().length > 0) {
      for (const [relpath, content] of Object.entries(files)) {
        configFiles.push({ path: "/home/.config/nvim/" + relpath, data: encoder.encode(content) });
      }
    }
    // pluginsToConfigFiles already filters to enabled plugins.
    const pluginFiles = pluginsToConfigFiles(plugins);
    const allFiles = [...configFiles, ...pluginFiles];

    // Nothing to load (no init.lua, no enabled plugins) -> byte-identical clean.
    if (allFiles.length === 0) return { usedConfig: false };

    // `--cmd` runs BEFORE plugins/init load, so netrw's load-guard skips it.
    // Without this, nvim's WASI cwd is `/` (a directory), so the startup buffer
    // becomes a netrw directory listing — nomodifiable+readonly — which breaks
    // scratch-restore and overlay text-seed. The clean/default boot (NVIM_ARGV,
    // with --noplugin) already excludes netrw, so this only affects config/plugin
    // boots (which drop --noplugin so pack/plugins/start auto-loads).
    return {
      argv: [
        "nvim",
        "--cmd",
        "let g:loaded_netrw=1 | let g:loaded_netrwPlugin=1",
        "--embed",
        "-i",
        "NONE",
        "-n",
      ],
      configFiles: allFiles,
      usedConfig: true,
    };
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

// Memory-watchdog notice: the editor was stopped for exceeding MEM_CAP_BYTES.
// Best-effort banner; debug.memoryCapped is the authoritative signal for smokes.
function showMemoryCapNotice(): void {
  const notice = document.createElement("div");
  notice.textContent = "editor used too much memory and was stopped";
  notice.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:9999;padding:4px 8px;" +
    "font:12px system-ui,sans-serif;color:#fff;background:#c0392b;text-align:center;";
  document.body.appendChild(notice);
}

// Sleeping overlay: shown while an idle-torn-down scratch instance waits for a
// keydown/click to respawn. Created lazily and toggled (not recreated) so resume
// can simply hide it. The message is parameterized so a failed resume can reuse
// the same overlay to prompt a retry. debug.sleeping is the authoritative signal
// for smokes.
function showSleepingOverlay(message = "💤 sleeping — press any key to resume"): void {
  if (!sleepingOverlay) {
    sleepingOverlay = document.createElement("div");
    sleepingOverlay.style.cssText =
      "position:fixed;inset:0;z-index:9998;display:flex;align-items:center;" +
      "justify-content:center;font:16px system-ui,sans-serif;color:#eee;" +
      "background:rgba(0,0,0,0.72);cursor:pointer;";
    document.body.appendChild(sleepingOverlay);
  }
  sleepingOverlay.textContent = message;
  sleepingOverlay.style.display = "flex";
}

function hideSleepingOverlay(): void {
  if (sleepingOverlay) sleepingOverlay.style.display = "none";
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
  // Captured so the success path can clear the watchdog — otherwise a leaked 12s
  // closure fires on every successful config boot (harmless but wasteful).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("config boot timed out")), 12_000);
    });
    await Promise.race([
      (async () => {
        await client.start(cols, rows, { argv: boot.argv, configFiles: boot.configFiles });
        // A broken config can wedge nvim AFTER nvim_ui_attach resolves — e.g. an
        // init.lua that loops once startup finishes attaching the UI. start()
        // would still resolve, so prove the RPC channel is actually live with a
        // trivial round-trip; a post-attach hang then trips the same watchdog and
        // falls back to safe mode rather than leaving the editor silently wedged.
        await client.request("nvim_eval", ["1"]);
      })(),
      timeout,
    ]);
    clearTimeout(timeoutHandle);
    debug.safeMode = false;
  } catch (e) {
    clearTimeout(timeoutHandle);
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
      // Mirror yanks to the system clipboard on an explicit "+/"* yank, OR on an
      // unnamed yank when 'clipboard' contains unnamed/unnamedplus (those route to
      // + but report regname ''). setreg() does not fire TextYankPost, so the
      // paste-IN sync can't feed back into this.
      `autocmd TextYankPost * if v:event.regname ==# '+' || v:event.regname ==# '*' || (v:event.regname ==# '' && &clipboard =~# 'unnamed') | call rpcnotify(${channel}, 'clipboard_copy', v:event.regcontents) | endif`,
    ].join("\n"),
    {},
  ]);
  // Register a clipboard provider so `set clipboard=unnamedplus` works instead
  // of erroring with "clipboard: No provider". There is no pbcopy/xclip in the
  // sandbox, so this provider is a thin in-memory register cache: nvim writes
  // `+`/`*` into it and reads back from it. The REAL system-clipboard sync stays
  // where it already lives — the TextYankPost autocmd above mirrors yanks OUT to
  // navigator.clipboard, and syncClipboardIn() setreg's the system clipboard IN
  // (which now flows through this provider's copy fn). cache_enabled lets nvim
  // reuse the cached value between reads.
  await client.request("nvim_exec_lua", [
    [
      "local reg = { ['+'] = { { '' }, 'v' }, ['*'] = { { '' }, 'v' } }",
      "vim.g.clipboard = {",
      "  name = 'nvim-in-browser',",
      "  copy = {",
      "    ['+'] = function(lines, regtype) reg['+'] = { lines, regtype } end,",
      "    ['*'] = function(lines, regtype) reg['*'] = { lines, regtype } end,",
      "  },",
      "  paste = {",
      "    ['+'] = function() return reg['+'] end,",
      "    ['*'] = function() return reg['*'] end,",
      "  },",
      "  cache_enabled = 1,",
      "}",
    ].join("\n"),
    [],
  ]);
  // Auto-enable treesitter highlighting for the grammars STATICALLY LINKED into
  // the engine (c, lua, vim, vimdoc→help, markdown+markdown_inline, query). nvim
  // doesn't start treesitter on its own, so without this the bundled grammars go
  // unused. vim.treesitter.start() attaches the highlighter to a buffer; pcall
  // makes a filetype with no bundled grammar a silent no-op. Registered after the
  // user's config has booted, and fires on FileType (which the embed init triggers
  // via `setlocal filetype=…`) plus once for the already-loaded buffer.
  await client.request("nvim_exec_lua", [
    [
      "local BUNDLED = { c = true, lua = true, vim = true, help = true, markdown = true, query = true }",
      "vim.api.nvim_create_autocmd('FileType', {",
      "  group = vim.api.nvim_create_augroup('nib_treesitter', { clear = true }),",
      "  callback = function(ev) if BUNDLED[ev.match] then pcall(vim.treesitter.start, ev.buf) end end,",
      "})",
      "pcall(function() if BUNDLED[vim.bo.filetype] then vim.treesitter.start() end end)",
    ].join("\n"),
    [],
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
    // The content script asks us to close (the toggle chord fired while the host
    // page — not this frame — had focus). Run the same buffer-pull + sync path
    // the chord uses, so edits since the last debounce aren't lost.
    else if (m?.type === "nvim-request-close") void deactivate();
  });
} else {
  void startScratch();
}

// Boot one scratch instance: boot nvim (with safe-mode fallback), reinstall the
// buffer hooks, pull the clipboard, restore the saved draft, and wire the
// debounced autosave. Shared by the initial startScratch AND by the idle respawn
// (which first swaps in a fresh, freshly-wired client) so BOTH paths run the
// exact same init — no duplicated setup that could drift. The one-time global
// listeners (flush-on-hide, idle lifecycle) live in startScratch, not here, so
// respawn never stacks duplicates.
async function bootScratchInstance(store: ScratchStore): Promise<void> {
  let saved: string | null = null;
  try {
    saved = await store.load();
  } catch (e) {
    console.warn("[scratch] load failed, starting empty:", serializeError(e));
  }
  await bootWithSafeMode(cols, rows);
  debug.ready = true;
  await installBufferHooks();
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
  ime.focus();
}

// Each scratch TAB is opened with a distinct `?doc=<id>` on scratch.html so its
// draft is independent. engine-frame is scratch.html's same-origin child (full
// mode), so read the id from the parent. Empty → the shared default draft (e.g.
// scratch.html opened directly, or the browser smoke). Guarded because in embed
// mode the parent is a cross-origin host page.
function scratchDocId(): string {
  try {
    return new URLSearchParams(window.parent.location.search).get("doc") ?? "";
  } catch {
    return "";
  }
}

async function startScratch(): Promise<void> {
  const store = openScratchStore(scratchDocId());
  await bootScratchInstance(store);
  // Best-effort flush when the tab is hidden or closing. Registered once; it
  // reads the live module `client`, so it survives idle respawns transparently.
  const flush = () => {
    void currentText().then((t) => store.save(t)).catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("beforeunload", flush);
  // Idle-instance teardown + respawn (scratch/full mode only).
  installIdleLifecycle(store);
}

// Idle-instance teardown (scratch/full mode only — embed mode is already
// transient, torn down on deactivate). After IDLE_TEARDOWN_MS with no input, save
// the draft, dispose the worker to reclaim its wasm + thread, and show the
// sleeping overlay. The next keydown (see the document keydown handler) or a click
// respawns a fresh client and re-runs the full scratch init via bootScratchInstance,
// restoring the draft.
function installIdleLifecycle(store: ScratchStore): void {
  const sleep = async (): Promise<void> => {
    if (debug.sleeping || debug.memoryCapped) return;
    // Capture the draft while the client is still live (currentText needs it),
    // BEFORE flipping any state, so the read isn't racing a disposed worker.
    let draft: string | null = null;
    try {
      draft = await currentText();
    } catch (e) {
      console.warn("[scratch] idle read failed:", serializeError(e));
    }
    // If the memory watchdog tripped during the read await it already disposed the
    // worker and showed its notice — bail before transitioning to the (resurrectable)
    // sleeping state and before a second dispose.
    if (debug.memoryCapped) return;
    // Flip to sleeping (and show the overlay) BEFORE disposing/saving so a keydown
    // or click during the save window is routed to the wake path (resumeFromSleep)
    // rather than client.input() on the about-to-be-disposed client, which would
    // silently drop the keystroke and leave the restored draft one edit stale.
    debug.ready = false;
    debug.sleeping = true;
    showSleepingOverlay();
    client.dispose();
    if (draft !== null) {
      try {
        await store.save(draft);
      } catch (e) {
        console.warn("[scratch] idle save failed:", serializeError(e));
      }
    }
    // Re-check after the save await: if the watchdog capped memory in the meantime,
    // the memory-capped instance must NOT be resurrectable, so leave the cap notice
    // in place and drop out of the sleeping (respawnable) state.
    if (debug.memoryCapped) {
      debug.sleeping = false;
      hideSleepingOverlay();
    }
  };
  armIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void sleep(), idleTeardownMs());
  };
  // Reentrancy guard: rapid wakes (several keydowns before the respawn finishes)
  // must not kick off overlapping boots.
  let resuming = false;
  resumeFromSleep = async () => {
    // memoryCapped instances are deliberately non-resurrectable — the watchdog
    // stopped the editor to avoid a crash loop, so never respawn one.
    if (!debug.sleeping || debug.memoryCapped || resuming) return;
    resuming = true;
    // The prior instance is gone; the engine is not live until the respawn boot
    // below succeeds (which sets debug.ready true again). Clear it now so a failed
    // resume can't leave a stale ready=true alongside sleeping=true.
    debug.ready = false;
    // Fresh client + identical wiring, then the SAME init the first boot ran.
    client = makeClient();
    wireClient(client);
    try {
      await bootScratchInstance(store);
      // Respawn succeeded: instance is live again.
      debug.sleeping = false;
      hideSleepingOverlay();
      armIdleTimer?.();
    } catch (e) {
      // Respawn boot rejected (e.g. a transient RPC failure in installBufferHooks
      // or the draft restore). Terminate this failed worker before retrying, or
      // each retry would orphan a live Worker (makeClient spawns one eagerly).
      client.dispose();
      // Do NOT wedge: keep debug.sleeping true so the NEXT keydown/click re-enters
      // here and retries (which will makeClient() a fresh worker), and update the
      // overlay to say so. resuming is reset in finally, so the retry isn't blocked.
      console.warn("[scratch] resume failed, will retry on next input:", serializeError(e));
      showSleepingOverlay("⚠ resume failed — press any key to retry");
    } finally {
      resuming = false;
    }
  };
  // A click anywhere also wakes a sleeping instance (the overlay is clickable).
  // When awake, a click counts as input too, so it restarts the idle countdown —
  // matching the keydown path (the plan resets the idle timer on ANY input).
  document.addEventListener("click", () => {
    if (debug.sleeping) {
      void resumeFromSleep?.();
      return;
    }
    if (debug.memoryCapped) return;
    armIdleTimer?.();
  });
  armIdleTimer();
}
