// Content script (ISOLATED world): overlays a real-Neovim editing surface (the
// extension's engine-frame iframe, in ?mode=embed) onto the focused editing
// surface of any page. Activation is driven by the background service worker
// (keyboard command -> chrome.tabs.sendMessage {type:"nvim-activate"}). Buffer
// edits stream back from the frame and are written into the underlying surface.
//
// Two kinds of target are supported behind a single `TextTarget` abstraction:
//   T0  plain value fields — <textarea> / eligible <input>. Read via `.value`,
//       written via the native value setter + synthetic input event so
//       React/Vue controlled inputs notice.
//   T1  framework code editors — Monaco / CodeMirror 5 / CodeMirror 6. Their
//       live instances live in the page's MAIN world, which a content script
//       cannot see, so read/write is delegated to a MAIN-world bridge
//       (src/content/editor-bridge-main.ts) over same-window postMessage. The
//       target element is handed across the world boundary by tagging it with
//       `data-nvim-editor="<nonce>"`; the bridge resolves it via querySelector.
//
// Bundled as an IIFE (see scripts/build.mjs) because content scripts cannot be
// ES modules.
import { isEscapeChord } from "../ui/keymap";
import { filetypeForHost } from "./filetype";

// Compile-time flag (see scripts/build.mjs). esbuild's `define` replaces this
// with a literal `false` in production builds, so the entire test-hook
// listener below is dead code that esbuild's minifier strips — the string
// "nvim-activate-test" does not ship in dist/chromium/content.js.
declare const __NVIM_TEST_HOOKS__: boolean;

const ELIGIBLE_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);

// How long we wait, after creating the engine-frame iframe, to hear back from
// it (either "nvim-ready" once it boots, or a "nvim-text" sync) before giving
// up and tearing the overlay down. Without this, an engine that hangs/crashes
// before ready leaves an unremovable overlay: the only other deactivation
// paths are messages *from* that same frame.
const BOOT_WATCHDOG_MS = 20_000;

// How long the isolated overlay waits for the MAIN-world bridge to answer a
// read/write request. If the bridge script never loaded (or the page has no
// live editor at the tagged element), resolveTarget must not hang forever.
const BRIDGE_TIMEOUT_MS = 3000;

// A uniform handle over whatever the overlay is editing. `element` is the box
// the overlay is positioned + size-tracked against; `write` applies buffer text
// back to the underlying surface; `cleanup` releases any per-target state (e.g.
// the framework path's `data-nvim-editor` tag) on deactivate.
interface TextTarget {
  element: HTMLElement;
  initialText: string;
  filetype: string | undefined;
  write(text: string): void;
  cleanup(): void;
  // Restore focus to the underlying editable on deactivate. For a framework
  // editor this is the originally-focused input (a hidden textarea / the
  // contenteditable), NOT the container element (which is usually not
  // focusable), so the cursor returns to the editor when the overlay closes.
  refocus(): void;
}

let active: { frame: HTMLIFrameElement; target: TextTarget } | null = null;

// React/Vue controlled components ignore plain `.value` writes because they
// track their own state; go through the native prototype setter and fire a
// synthetic bubbling input event so the framework's onChange sees the change.
function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Descend through OPEN shadow roots to the truly-focused element. Monaco / CM
// (and many web components) place the real editing surface inside a shadow
// root, so document.activeElement stops at the host. We do NOT cross iframe
// boundaries here (a cross-origin iframe can't be reached, and same-origin
// iframe focus is handled by the "embedded frames" notice path).
function deepActiveElement(): HTMLElement | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el instanceof HTMLElement ? el : null;
}

// One-shot request/response to the MAIN-world bridge over same-window
// postMessage. Resolves with the bridge's response object, or a synthetic
// `{ok:false, reason:"timeout"}` if it never answers within BRIDGE_TIMEOUT_MS.
// Always tears down its own listener + timer so a slow/absent bridge can't leak.
let bridgeReqSeq = 0;
function bridgeRequest(
  op: "read" | "write",
  nonce: string,
  text?: string,
): Promise<{ ok: boolean; text?: string; filetype?: string; reason?: string }> {
  const id = ++bridgeReqSeq;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (res: { ok: boolean; text?: string; filetype?: string; reason?: string }): void => {
      window.removeEventListener("message", onMessage);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(res);
    };
    const onMessage = (ev: MessageEvent): void => {
      if (ev.source !== window) return;
      if (ev.data?.source !== "nvim-bridge-res" || ev.data.id !== id) return;
      done(ev.data);
    };
    window.addEventListener("message", onMessage);
    timer = setTimeout(() => done({ ok: false, reason: "timeout" }), BRIDGE_TIMEOUT_MS);
    window.postMessage({ source: "nvim-bridge-req", id, op, nonce, text }, "*");
  });
}

// Resolve the current activation target, if any. Order matters: framework code
// editors (Monaco/CM) focus a HIDDEN <textarea> or contenteditable, so the
// framework check MUST precede the plain value-field check — otherwise we would
// treat Monaco's hidden inputarea as a plain textarea and write into a `.value`
// the editor ignores.
async function resolveTarget(): Promise<TextTarget | null> {
  const el = deepActiveElement();

  // 1. Framework code editors (Monaco / CM5 / CM6) via the MAIN-world bridge.
  const container = el?.closest?.(".monaco-editor, .CodeMirror, .cm-editor");
  if (container instanceof HTMLElement) {
    const nonce = crypto.randomUUID();
    container.setAttribute("data-nvim-editor", nonce);
    const res = await bridgeRequest("read", nonce);
    if (!res.ok || typeof res.text !== "string") {
      container.removeAttribute("data-nvim-editor");
      return null;
    }
    return {
      element: container,
      initialText: res.text,
      filetype: res.filetype || filetypeForHost(location.hostname),
      write: (t) => void bridgeRequest("write", nonce, t),
      cleanup: () => container.removeAttribute("data-nvim-editor"),
      // Refocus the actual editor input (el), not the container.
      refocus: () => el?.focus?.(),
    };
  }

  // 2. Plain value field: <textarea> or an eligible <input>.
  if (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && ELIGIBLE_INPUT_TYPES.has(el.type))
  ) {
    const field = el;
    return {
      element: field,
      initialText: field.value,
      filetype: filetypeForHost(location.hostname),
      write: (t) => setNativeValue(field, t),
      cleanup: () => {},
      refocus: () => field.focus(),
    };
  }

  return null;
}

function positionFrame(frame: HTMLIFrameElement, target: HTMLElement): void {
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
    // Stable selector for the overlay smoke's hostile-notice assertion.
    pill.dataset.nvimNotice = "1";
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

// Synchronous re-entrancy guard for activate(). `active` alone is not enough:
// resolveTarget() awaits the bridge, so two activations could both pass the
// `if (active)` check before either sets it. This flag closes that window.
let activating = false;

async function activate(): Promise<void> {
  // Toggle: pressing the activation chord while the overlay is up closes it and
  // returns to the field. Ask the frame to close (rather than ripping the
  // iframe) so it pulls + syncs the final buffer text first. Covers the case
  // where the Chrome command reaches this content script; when embedded nvim has
  // focus instead, the frame's own keydown handles the chord.
  if (active) {
    active.frame.contentWindow?.postMessage({ type: "nvim-request-close" }, "*");
    return;
  }
  if (activating) return;
  activating = true;
  try {
    const target = await resolveTarget();
    if (!target) {
      if (document.activeElement?.tagName === "IFRAME") {
        showNotice(
          "Can't edit fields inside embedded frames. Open the scratch page instead?",
          true,
        );
      } else {
        showNotice(
          "Focus a text field or a supported code editor first, or open the scratch page.",
          true,
        );
      }
      return;
    }
    startOverlay(target);
  } finally {
    activating = false;
  }
}

// Build the engine-frame overlay for a resolved target and wire its full
// lifecycle: boot watchdog, message plumbing, seed on load, reposition/resize
// tracking, escape-chord guard, and deactivate. This is the T0 overlay body,
// generalized to drive `target` (element / initialText / filetype / write /
// cleanup) instead of a bare textarea.
function startOverlay(target: TextTarget): void {
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("engine-frame.html?mode=embed");
  frame.allow = "clipboard-read; clipboard-write";
  positionFrame(frame, target.element);
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
      active.target.write(m.text);
    } else if (m?.type === "nvim-deactivate") {
      if (typeof m.text === "string" && active) active.target.write(m.text);
      deactivate();
    }
  };
  window.addEventListener("message", onMessage);

  const onLoad = (): void => {
    frame.contentWindow?.postMessage(
      { type: "nvim-init", text: target.initialText, filetype: target.filetype },
      "*",
    );
    frame.contentWindow?.focus();
  };
  frame.addEventListener("load", onLoad);

  const reposition = (): void => {
    if (active) positionFrame(active.frame, active.target.element);
  };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  // Track the target ELEMENT's own size, not just the viewport. Dragging a
  // textarea's resize grip, a responsive relayout, or a JS-driven size change
  // fires no window "resize" event, so a ResizeObserver on the target is what
  // keeps the overlay matching the field's box across all of those. (The scroll
  // + window-resize listeners above still handle the field MOVING when the page
  // reflows or scrolls.) positionFrame recomputes width/height too, so the
  // overlay follows both size and position from one callback.
  const sizeObserver = new ResizeObserver(reposition);
  sizeObserver.observe(target.element);

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
    sizeObserver.disconnect();
    frame.removeEventListener("load", onLoad);
    const t = active?.target;
    active?.frame.remove();
    active = null;
    t?.cleanup();
    t?.refocus();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "nvim-activate") void activate();
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
    void activate();
  });
}
