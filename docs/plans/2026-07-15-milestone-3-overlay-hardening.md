# Milestone 3: Overlay Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the overlay usable on real pages: IME/composition input (non-ASCII + dead keys), a graceful fallback when the overlay can't attach, and per-site filetype so syntax highlighting works.

**Architecture:** All host-side (engine untouched). IME uses the standard canvas-editor pattern — a hidden focusable input positioned at the nvim cursor hosts composition; keydown is suppressed mid-composition; `compositionend` sends the composed string via `nvim_input`. Fallback + filetype live in the content script (`overlay.ts`) and the `nvim-init` handshake.

**Tech Stack:** existing (TypeScript, esbuild, vitest, puppeteer/CDP smokes). No new deps.

## Global Constraints
- Engine (nvim-wasi) and its API are NOT touched. Files: `src/engine-frame/*`, `src/ui/grid-renderer.ts`, `src/content/overlay.ts`, `src/manifest.json` (only if a new permission is truly needed — it isn't expected), smokes, docs.
- No regression: `npm test`, `npm run typecheck`, `node scripts/smoke-nvim.mjs`, `node scripts/browser-smoke.mjs`, `node scripts/overlay-smoke.mjs` stay green. The two browser smokes must run SEQUENTIALLY (each rebuilds dist).
- IME must work in BOTH surfaces (overlay embed mode + scratch full mode) since both live in engine-frame.
- The escape chord, existing sync, `:q` final-sync, single-line input, password no-op all continue to pass (overlay-smoke).
- Conventional commits. Shell rule: one command per Bash tool call. Branch: `feat/milestone-3`.

---

### Task 1: IME / composition input

**Files:**
- Modify: `src/ui/grid-renderer.ts` (expose cursor pixel position), `src/engine-frame/engine-frame.html` (hidden IME input), `src/engine-frame/engine-frame.ts` (composition handling, focus the IME input, reposition on cursor move).

**Interfaces:**
- Produces: `GridRenderer.cursorPixel(): { x: number; y: number; height: number }` returning the cursor's top-left pixel + cell height in canvas CSS pixels.

**This task is acceptance-gate defined** (IME has browser/edge-case nuance): done when the browser smoke can drive a composition and the composed text lands in the nvim buffer, AND ordinary ASCII typing + the escape chord still work. Below is the standard-pattern skeleton; the implementer fills edge cases and verifies against the smoke.

- [ ] **Step 1: `cursorPixel()` on the renderer.**
```ts
// add to GridRenderer
cursorPixel(): { x: number; y: number; height: number } {
  return { x: this.cursor.col * this.cellW, y: this.cursor.row * this.cellH, height: this.cellH };
}
```

- [ ] **Step 2: Hidden IME input in engine-frame.html.** Add, inside `<body>`, a text input that is focusable but visually inert (do NOT use `display:none`/`visibility:hidden` — those disable IME). Transparent, tiny, positioned absolutely; the script moves it to the cursor.
```html
<input id="ime" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
  style="position:absolute;left:0;top:0;width:1px;height:1em;padding:0;border:0;margin:0;
         background:transparent;color:transparent;caret-color:transparent;outline:none;
         z-index:1;opacity:0;" />
```
(Keep the canvas as the visual surface; the input sits on top invisibly. `opacity:0` still allows focus + IME + the candidate window.)

- [ ] **Step 3: engine-frame.ts — focus the IME input, suppress keys mid-composition, send composed text.**
  - Grab `const ime = document.getElementById("ime") as HTMLInputElement;`
  - Replace `canvas.focus()` calls with `ime.focus()` (the IME input is what must hold focus so composition + the candidate window work; keydown still bubbles to `document`).
  - In the existing `document` `keydown` handler: after the escape-chord check, add `if (ev.isComposing || ev.keyCode === 229) return;` BEFORE translating — so keystrokes that are feeding the IME are never forwarded to nvim.
  - Add composition handlers on `ime`:
    ```ts
    let composing = false;
    ime.addEventListener("compositionstart", () => { composing = true; });
    ime.addEventListener("compositionend", (ev) => {
      composing = false;
      const text = (ev as CompositionEvent).data ?? "";
      if (text) client.input(text);      // send the finished composition as literal input
      ime.value = "";                     // reset for the next composition
    });
    // Guard: if any stray text lands in the input outside composition, drop it.
    ime.addEventListener("input", () => { if (!composing) ime.value = ""; });
    ```
  - Reposition the IME input to the cursor on redraw so the candidate window appears at the caret. In the `client.onRedraw` path, after `renderer.apply(batch)`, add:
    ```ts
    const p = renderer.cursorPixel();
    ime.style.left = `${p.x}px`;
    ime.style.top = `${p.y}px`;
    ime.style.height = `${p.height}px`;
    ```
  - Keep `preventDefault()` for translated (non-composition) keys exactly as now, so ASCII typing is unchanged and never leaks into the input.

- [ ] **Step 4: Typecheck + build.** `npm run typecheck`; `npm run fetch-assets`; `npm run build`. (Runtime proof is Task 4's smoke.)
- [ ] **Step 5: Commit** `feat: IME composition input via hidden caret-tracking input`.

---

### Task 2: Hostile-page fallback

**Files:**
- Modify: `src/content/overlay.ts`.

Today `activate()` silently returns when there's no eligible target — no feedback. And fields inside cross-origin iframes are unreachable (the content script runs only in the top frame). Give the user a clear, dismissible notice with an escape to the scratch page.

**Interfaces:**
- Produces: `function showNotice(message: string, withScratchAction: boolean): void` — a fixed, top-layer, auto-dismissing toast (styled inline, `z-index:2147483647`), optionally with an "Open scratch page" button that does `chrome.runtime.sendMessage({type:"open-scratch"})`. Auto-dismiss ~5s; click-to-dismiss.

- [ ] **Step 1: Detect the unactivatable cases in `activate()`.** Before the current `if (!target) return;`:
  - No eligible target AND focus is on an `<iframe>` element (`document.activeElement?.tagName === "IFRAME"`): `showNotice("Can't edit fields inside embedded frames. Open the scratch page instead?", true); return;`
  - No eligible target otherwise: `showNotice("Focus a text field first (or open the scratch page).", true); return;`
  (Keep the existing password-field / ineligible-type behavior: those already fall through to `!target`.)

- [ ] **Step 2: Implement `showNotice`.** A single reused toast element (create once, reuse): a rounded dark pill, fixed near top-center, white text, with an optional button. Remove any prior notice before showing a new one. Auto-dismiss via setTimeout; clear on manual dismiss. Never throw.

- [ ] **Step 3: Wire the scratch action in background.ts.** Add to `background.ts`'s `chrome.runtime.onMessage` (or a new listener): `if (msg?.type === "open-scratch") chrome.tabs.create({ url: chrome.runtime.getURL("scratch.html") });`. (background.ts is the only file besides overlay.ts touched here.)

- [ ] **Step 4: Typecheck + build.** `npm run typecheck`; `npm run build` (content.js IIFE rebuilt).
- [ ] **Step 5: Commit** `feat: hostile-page fallback notice with scratch-page escape`.

---

### Task 3: Per-site filetype

**Files:**
- Modify: `src/content/overlay.ts` (compute filetype, pass in `nvim-init`), `src/engine-frame/engine-frame.ts` (apply filetype after seeding).

**Interfaces:**
- Extends the `nvim-init` message shape: `{ type:"nvim-init", text: string, filetype?: string }`. Full/scratch mode is unaffected (no filetype → no-op).

- [ ] **Step 1: filetype rule table in overlay.ts.**
```ts
function filetypeForHost(host: string): string | undefined {
  const h = host.replace(/^www\./, "");
  if (/(^|\.)(github|gitlab)\.com$/.test(h)) return "markdown";
  if (/(^|\.)(stackoverflow|stackexchange|reddit)\.com$/.test(h)) return "markdown";
  if (h === "news.ycombinator.com") return "markdown";
  return undefined;
}
```
Pass it in the init post: `frame.contentWindow?.postMessage({ type:"nvim-init", text: target.value, filetype: filetypeForHost(location.hostname) }, "*");`

- [ ] **Step 2: Apply it in engine-frame.ts `init()`.** After the buffer seed (`nvim_buf_set_lines`), if `typeof m.filetype === "string"`: `await client.request("nvim_exec2", ["setlocal filetype=" + safeFiletype, {}]);` where `safeFiletype` is validated against `/^[a-z0-9._-]+$/` (reject anything else — never interpolate untrusted text into an Ex command). Wire `filetype` through the `init(seedText, filetype)` signature.

- [ ] **Step 3: Typecheck + build.** `npm run typecheck`; `npm run build`.
- [ ] **Step 4: Commit** `feat: per-site filetype for overlay syntax highlighting`.

---

### Task 4: Verify (smokes) + docs

**Files:**
- Modify: `scripts/overlay-smoke.mjs` (IME + hostile-notice + filetype assertions), `src/engine-frame/engine-frame.ts` (extend the `window.__nvim` debug hook with a generic `request`), `README.md`, spec.

- [ ] **Step 1: Extend the debug hook.** In engine-frame.ts, add to the `__nvim` debug object: `request: (method: string, params: unknown[]) => client.request(method, params)` so the smoke can query nvim state (e.g. filetype). (Small, generic, test-only-ish but harmless — same spirit as the existing hook.)

- [ ] **Step 2: IME assertion (overlay-smoke).** After activating the textarea overlay, drive a composition via CDP on the engine-frame and assert the composed text reaches the buffer:
  - Get a CDP session for the frame's execution context (or use `Input.imeSetComposition` + `Input.insertText` at the page level with the IME input focused). Sequence: focus the `#ime` input in the frame, `Input.imeSetComposition` with a marker string + selection, then `Input.insertText` (or `Input.imeSetComposition` with empty to commit) to fire `compositionend`. Simplest reliable path: dispatch real `CompositionEvent`s in the frame via `frame.evaluate` — construct `new CompositionEvent("compositionstart")`, `compositionupdate`, then `compositionend` with `data:"にほんご"` (or an accented string like "café") on the `#ime` element, and assert `(await __nvim.getBufferText()).includes(...)`. (Dispatched CompositionEvents exercise the exact handler path; note in the report that this simulates the browser's composition sequence.)
  - Assert ASCII typing still works and the escape chord still deactivates (existing cases already cover these — keep them green).

- [ ] **Step 3: Hostile-notice assertion.** Blur any field / focus `document.body`, trigger activation (test hook), assert NO engine-frame iframe appears AND a notice element is present with the expected text. Then clean up.

- [ ] **Step 4: Filetype assertion.** Serve the fixture from a host the rule table matches is not possible (loopback IP), so instead: temporarily stub `location.hostname` is not feasible cross-context — instead assert the mechanism directly: activate on the textarea, and in the frame call `__nvim.request("nvim_get_option_value", ["filetype", {}])` after an init that passed `filetype:"markdown"`. To exercise the real path, have the smoke post its own `nvim-init` with `filetype:"markdown"` is already how activation works — simplest: add a dedicated fixture/among assertions that drives filetype through the actual overlay by making the test-activation set a known filetype. If wiring a real hostname is impractical in the loopback smoke, assert the `filetypeForHost` unit behavior in a vitest test instead (pure function) AND assert in-browser that a `nvim-init` carrying `filetype:"markdown"` results in `&filetype == "markdown"`. Document which path was used.
  - **Add a vitest unit test** `src/content/overlay-filetype.test.ts` for `filetypeForHost` (export it): github.com→markdown, www.github.com→markdown, example.com→undefined, news.ycombinator.com→markdown. (Pure, fast, no browser.)

- [ ] **Step 5: Full gate (sequential).** `npm test`; `npm run typecheck`; `node scripts/smoke-nvim.mjs`; `node scripts/browser-smoke.mjs`; then (separately) `node scripts/overlay-smoke.mjs`.

- [ ] **Step 6: Docs.** README: overlay now supports IME/composition input, shows a fallback notice when it can't attach, and highlights known sites by filetype. Spec: mark Milestone 3 done; update the impl-notes "IME NOT implemented" line to "implemented (hidden caret-tracking input)".

- [ ] **Step 7: Commit** `test: IME + hostile-notice + filetype; docs: milestone 3 done`.

---

## Self-review notes
- Engine untouched — all files host-side.
- IME is acceptance-gate-defined (browser nuance); the smoke's dispatched CompositionEvents exercise the real handler path.
- Deferred/documented: full cross-origin-iframe editing (needs all_frames + a frame-coordination protocol) — the notice + scratch escape is the M3 graceful degradation; automated copy-back from the scratch page is a later refinement; IME candidate-window positioning is best-effort (composition correctness doesn't depend on it).
- Interface consistency: `cursorPixel()`, `nvim-init {text, filetype}`, `init(seedText, filetype)`, `filetypeForHost`, `showNotice`, `__nvim.request` names consistent across tasks.
