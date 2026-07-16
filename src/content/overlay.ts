// Content script: overlays a real-Neovim editing surface (the extension's
// engine-frame iframe, in ?mode=embed) onto the focused textarea / eligible
// text input of any page. Activation is driven by the background service worker
// (keyboard command -> chrome.tabs.sendMessage {type:"nvim-activate"}). Buffer
// edits stream back from the frame and are written into the underlying field
// through the native value setter so React/Vue controlled inputs notice.
//
// Bundled as an IIFE (see scripts/build.mjs) because content scripts cannot be
// ES modules.
import { isEscapeChord } from "../ui/keymap";

// Compile-time flag (see scripts/build.mjs). esbuild's `define` replaces this
// with a literal `false` in production builds, so the entire test-hook
// listener below is dead code that esbuild's minifier strips — the string
// "nvim-activate-test" does not ship in dist/chromium/content.js.
declare const __NVIM_TEST_HOOKS__: boolean;

const ELIGIBLE_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);

// Map the host page to a nvim filetype so syntax highlighting / treesitter
// engage on sites whose text fields are known to hold a particular markup.
// Exported so it can be unit-tested directly (the IIFE content bundle keeps it
// internal — the symbol just isn't exposed on the global, which is fine).
export function filetypeForHost(host: string): string | undefined {
  const h = host.replace(/^www\./, "");
  if (/(^|\.)(github|gitlab)\.com$/.test(h)) return "markdown";
  if (/(^|\.)(stackoverflow|stackexchange|reddit)\.com$/.test(h)) return "markdown";
  if (h === "news.ycombinator.com") return "markdown";
  return undefined;
}

// How long we wait, after creating the engine-frame iframe, to hear back from
// it (either "nvim-ready" once it boots, or a "nvim-text" sync) before giving
// up and tearing the overlay down. Without this, an engine that hangs/crashes
// before ready leaves an unremovable overlay: the only other deactivation
// paths are messages *from* that same frame.
const BOOT_WATCHDOG_MS = 20_000;

type Target = HTMLTextAreaElement | HTMLInputElement;
let active: { frame: HTMLIFrameElement; target: Target } | null = null;

function eligibleTarget(): Target | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && ELIGIBLE_INPUT_TYPES.has(el.type)) return el;
  return null;
}

// React/Vue controlled components ignore plain `.value` writes because they
// track their own state; go through the native prototype setter and fire a
// synthetic bubbling input event so the framework's onChange sees the change.
function setNativeValue(el: Target, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function positionFrame(frame: HTMLIFrameElement, target: Target): void {
  const rect = target.getBoundingClientRect();
  const minH = 220; // comfortable multi-row strip even over a small input
  frame.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "border:1px solid #45475a",
    "box-shadow:0 8px 32px rgba(0,0,0,.5)",
    "border-radius:6px",
    "background:#1e1e2e",
    `left:${Math.max(4, rect.left)}px`,
    `top:${Math.max(4, rect.top)}px`,
    `width:${Math.max(rect.width, 480)}px`,
    `height:${Math.max(rect.height, minH)}px`,
  ].join(";");
}

// The single reused toast element. Created lazily on first showNotice call and
// reused (with its contents rebuilt) thereafter, so a burst of activations
// never stacks overlapping pills.
let noticeEl: HTMLDivElement | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

// Dismissible, auto-fading fallback toast shown when activation can't proceed
// (no eligible field, focus trapped in a cross-origin iframe, etc.). Styled
// entirely inline — no external CSS, no dependency on the host page's styles —
// and pinned to the top layer. Must never throw: it runs on arbitrary pages
// and a thrown error here would surface as an unhandled content-script error.
function showNotice(message: string, withScratchAction: boolean): void {
  try {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    noticeEl?.remove();

    const pill = document.createElement("div");
    noticeEl = pill;
    pill.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "top:16px",
      "left:50%",
      "transform:translateX(-50%)",
      "display:flex",
      "align-items:center",
      "gap:12px",
      "max-width:min(90vw,520px)",
      "padding:10px 16px",
      "border-radius:9999px",
      "background:#1e1e2e",
      "color:#ffffff",
      "font:14px/1.4 system-ui,-apple-system,sans-serif",
      "box-shadow:0 8px 32px rgba(0,0,0,.5)",
      "cursor:pointer",
    ].join(";");

    const dismiss = (): void => {
      if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      pill.remove();
      if (noticeEl === pill) noticeEl = null;
    };

    const text = document.createElement("span");
    text.textContent = message;
    pill.appendChild(text);

    if (withScratchAction) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Open scratch page";
      button.style.cssText = [
        "flex:none",
        "padding:4px 12px",
        "border:0",
        "border-radius:9999px",
        "background:#89b4fa",
        "color:#1e1e2e",
        "font:600 13px/1.4 system-ui,-apple-system,sans-serif",
        "cursor:pointer",
      ].join(";");
      button.addEventListener("click", (ev) => {
        ev.stopPropagation();
        try {
          chrome.runtime.sendMessage({ type: "open-scratch" });
        } catch {
          // Extension context may be gone (reload/update); nothing to do.
        }
        dismiss();
      });
      pill.appendChild(button);
    }

    pill.addEventListener("click", dismiss);
    document.body.appendChild(pill);

    noticeTimer = setTimeout(dismiss, 5000);
  } catch {
    // Never let a notice failure bubble into the host page.
  }
}

function activate(): void {
  if (active) return;
  const target = eligibleTarget();
  if (!target) {
    if (document.activeElement?.tagName === "IFRAME") {
      showNotice("Can't edit fields inside embedded frames. Open the scratch page instead?", true);
    } else {
      showNotice("Focus a text field first, or open the scratch page.", true);
    }
    return;
  }

  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("engine-frame.html?mode=embed");
  frame.allow = "clipboard-read; clipboard-write";
  positionFrame(frame, target);
  document.body.appendChild(frame);
  active = { frame, target };

  // Boot watchdog: if the frame never checks in (hung/crashed before ready),
  // tear the overlay down instead of leaving it stuck forever.
  let watchdogTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    watchdogTimer = null;
    deactivate();
  }, BOOT_WATCHDOG_MS);
  const clearWatchdog = (): void => {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (m?.type === "nvim-ready" || m?.type === "nvim-text") clearWatchdog();
    if (m?.type === "nvim-text" && active) {
      setNativeValue(active.target, m.text);
    } else if (m?.type === "nvim-deactivate") {
      if (typeof m.text === "string" && active) setNativeValue(active.target, m.text);
      deactivate();
    }
  };
  window.addEventListener("message", onMessage);

  const onLoad = (): void => {
    frame.contentWindow?.postMessage(
      { type: "nvim-init", text: target.value, filetype: filetypeForHost(location.hostname) },
      "*",
    );
    frame.contentWindow?.focus();
  };
  frame.addEventListener("load", onLoad);

  const reposition = (): void => {
    if (active) positionFrame(active.frame, active.target);
  };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  // Escape-chord escape hatch: while the overlay is active the chord is
  // normally consumed inside the (focused) iframe, which posts back
  // "nvim-deactivate". But if focus ever escapes the frame back to this
  // document (e.g. the frame hung before it could grab focus), the chord
  // must still ALWAYS dismiss the overlay — from either side — so it can
  // never get stuck. Block it from reaching the host page's own keybindings
  // AND deactivate directly here.
  const guardEscape = (ev: KeyboardEvent): void => {
    if (active && isEscapeChord(ev)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      deactivate();
    }
  };
  window.addEventListener("keydown", guardEscape, true);

  function deactivate(): void {
    clearWatchdog();
    window.removeEventListener("message", onMessage);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("keydown", guardEscape, true);
    frame.removeEventListener("load", onLoad);
    const t = active?.target;
    active?.frame.remove();
    active = null;
    t?.focus();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "nvim-activate") activate();
});

// Test-only activation path for the headless browser smoke, where the real
// chrome.commands shortcut does not reliably register. Accept a same-window
// postMessage ONLY when the smoke has opted in by stamping the document root
// (`data-nvim-test-hook="1"`). This keeps the production attack surface minimal:
// with the attribute absent the branch is inert on real pages.
//
// Stripped entirely from production builds (see __NVIM_TEST_HOOKS__ above):
// any page controls its own DOM, so the dataset gate alone is not a strong
// enough guarantee to ship this listener at all in production — esbuild's
// `define` + minifier dead-code-eliminate this whole block instead.
if (__NVIM_TEST_HOOKS__) {
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window) return;
    if (ev.data?.type !== "nvim-activate-test") return;
    if (document.documentElement.dataset.nvimTestHook !== "1") return;
    activate();
  });
}
