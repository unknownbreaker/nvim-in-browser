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

const ELIGIBLE_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);

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

function activate(): void {
  if (active) return;
  const target = eligibleTarget();
  if (!target) return;

  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("engine-frame.html?mode=embed");
  frame.allow = "clipboard-read; clipboard-write";
  positionFrame(frame, target);
  document.body.appendChild(frame);
  active = { frame, target };

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (m?.type === "nvim-text" && active) {
      setNativeValue(active.target, m.text);
    } else if (m?.type === "nvim-deactivate") {
      if (typeof m.text === "string" && active) setNativeValue(active.target, m.text);
      deactivate();
    }
  };
  window.addEventListener("message", onMessage);

  const onLoad = (): void => {
    frame.contentWindow?.postMessage({ type: "nvim-init", text: target.value }, "*");
    frame.contentWindow?.focus();
  };
  frame.addEventListener("load", onLoad);

  const reposition = (): void => {
    if (active) positionFrame(active.frame, active.target);
  };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  // Defence in depth: while the overlay is active the escape chord is normally
  // consumed inside the (focused) iframe and never reaches this document. If
  // focus ever escapes the frame, block the chord in the capture phase so the
  // host page's own keybindings can't fire.
  const guardEscape = (ev: KeyboardEvent): void => {
    if (active && isEscapeChord(ev)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  };
  window.addEventListener("keydown", guardEscape, true);

  function deactivate(): void {
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
window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  if (ev.data?.type !== "nvim-activate-test") return;
  if (document.documentElement.dataset.nvimTestHook !== "1") return;
  activate();
});
