// Main-world bridge for T1 framework-editor support.
//
// Content scripts run in the ISOLATED world and cannot see the page's own JS
// objects (`window.monaco`, a DOM node's `.CodeMirror`, a CM6 EditorView).
// Those live in the page's MAIN world. This script is injected into the MAIN
// world (manifest content_scripts entry with `"world":"MAIN"`, Chrome 111+;
// target is chrome120) so it can reach the live editor instance and do the text
// read/write on its behalf.
//
// The two worlds SHARE the DOM but not JS state, so the isolated overlay
// (src/content/overlay.ts) tags the target container with
// `data-nvim-editor="<nonce>"` and this script resolves it via querySelector.
// The two talk over `window.postMessage` — both worlds' `message` listeners
// receive a same-window post, so a `source` tag disambiguates the protocol:
//
//   request  { source:"nvim-bridge-req", id, op:"read"|"write", nonce, text? }
//   response { source:"nvim-bridge-res", id, ok, text?, filetype?, reason? }
//
// This runs in the page's own world on arbitrary sites, so it must NEVER throw
// into the page: every message handler body is wrapped in try/catch.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface EditorAdapter {
  read(el: HTMLElement): { text: string; filetype?: string } | null;
  write(el: HTMLElement, text: string): boolean;
}

// --- Monaco -----------------------------------------------------------------
// Match the editor instance whose container node is (or contains, or is
// contained by) the tagged element, then read/write via its model.
function monacoEditorFor(el: HTMLElement): any {
  const m = (window as any).monaco;
  if (typeof m?.editor?.getEditors !== "function") return null;
  for (const ed of m.editor.getEditors()) {
    const node = ed.getContainerDomNode?.() ?? ed.getDomNode?.();
    if (!node) continue;
    if (node === el || node.contains(el) || el.contains(node)) return ed;
  }
  return null;
}

const monaco: EditorAdapter = {
  read(el) {
    const ed = monacoEditorFor(el);
    if (!ed) return null;
    const model = ed.getModel?.();
    return {
      text: model ? model.getValue() : ed.getValue(),
      filetype: model?.getLanguageId?.(),
    };
  },
  write(el, text) {
    const ed = monacoEditorFor(el);
    if (!ed) return false;
    const model = ed.getModel?.();
    if (model?.setValue) model.setValue(text);
    else if (ed.setValue) ed.setValue(text);
    else return false;
    return true;
  },
};

// --- CodeMirror 5 -----------------------------------------------------------
// The `.CodeMirror` DOM node carries its instance as a `.CodeMirror` property.
function cm5InstanceFor(el: HTMLElement): any {
  const node = el.closest?.(".CodeMirror") as any;
  const cm = node?.CodeMirror;
  if (!(cm && typeof cm.getValue === "function" && typeof cm.setValue === "function")) return null;
  return cm;
}

// CM5 `mode` option is a string, or an object like `{ name: "javascript", ... }`.
function cmMode(mode: any): string | undefined {
  if (typeof mode === "string") return mode;
  if (mode && typeof mode.name === "string") return mode.name;
  return undefined;
}

const cm5: EditorAdapter = {
  read(el) {
    const cm = cm5InstanceFor(el);
    if (!cm) return null;
    return { text: cm.getValue(), filetype: cmMode(cm.getOption?.("mode")) };
  },
  write(el, text) {
    const cm = cm5InstanceFor(el);
    if (!cm) return false;
    cm.setValue(text);
    return true;
  },
};

// --- CodeMirror 6 (BEST-EFFORT) ---------------------------------------------
// CM6 has NO official DOM->EditorView path. We probe a few known, UNDOCUMENTED
// attach points and verify the shape (a live `state.doc` + a `dispatch`
// function) before trusting one. This path is version-dependent and should be
// validated on a real CM6 page — it can break with a CM6 internals change.
function cm6ViewFor(el: HTMLElement): any {
  const root = (el.closest?.(".cm-editor") ?? el) as any;
  const content = root.querySelector?.(".cm-content") as any;
  for (const v of [root.cmView?.view, content?.cmView?.view, content?.cmView?.editorView]) {
    if (v?.state?.doc && typeof v.dispatch === "function") return v;
  }
  return null;
}

const cm6: EditorAdapter = {
  read(el) {
    const view = cm6ViewFor(el);
    if (!view) return null;
    return { text: view.state.doc.toString() };
  },
  write(el, text) {
    const view = cm6ViewFor(el);
    if (!view) return false;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    return true;
  },
};

const ADAPTERS: EditorAdapter[] = [monaco, cm5, cm6];

// Resolve the tagged container and the first adapter whose read() succeeds.
function resolve(
  nonce: string,
): { el: HTMLElement; adapter: EditorAdapter; read: { text: string; filetype?: string } } | null {
  const el = document.querySelector(
    '[data-nvim-editor="' + CSS.escape(nonce) + '"]',
  ) as HTMLElement | null;
  if (!el) return null;
  for (const adapter of ADAPTERS) {
    const read = adapter.read(el);
    if (read) return { el, adapter, read };
  }
  return null;
}

// Guard against double-injection: a page navigation or a re-inject must not
// stack a second listener (it would double-reply to every request).
if (!(window as any).__nvimBridgeInstalled) {
  (window as any).__nvimBridgeInstalled = true;

  window.addEventListener("message", (ev: MessageEvent) => {
    // Ignore anything that isn't our own same-window request.
    if (ev.source !== window) return;
    const data = ev.data;
    if (data?.source !== "nvim-bridge-req") return;

    const id = data.id;
    const reply = (extra: Record<string, unknown>): void => {
      window.postMessage({ source: "nvim-bridge-res", id, ...extra }, "*");
    };

    try {
      const resolved = resolve(data.nonce);
      if (!resolved) {
        reply({ ok: false, reason: "no-editor" });
        return;
      }
      if (data.op === "read") {
        reply({ ok: true, text: resolved.read.text, filetype: resolved.read.filetype });
        return;
      }
      if (data.op === "write") {
        const ok = resolved.adapter.write(resolved.el, String(data.text ?? ""));
        reply({ ok, reason: ok ? undefined : "write-failed" });
        return;
      }
      reply({ ok: false, reason: "bad-op" });
    } catch (e) {
      // Never let a page-world error surface as an unhandled content-script
      // error. Report it as a failed response instead.
      reply({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  });
}
