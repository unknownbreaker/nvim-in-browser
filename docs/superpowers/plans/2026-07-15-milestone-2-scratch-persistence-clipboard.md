# Milestone 2: Scratch Persistence + Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The scratch page remembers your draft across reloads, and `"+y`/`"+p` bridge to the system clipboard.

**Architecture:** Both features are host/frame-side (no engine change — nvim-wasi stays a sealed API). Persistence: the scratch full-mode frame snapshots the buffer text to IndexedDB (debounced + on unload) and restores it on boot. Clipboard: a `TextYankPost` autocmd rpcnotifies yanked `+`/`*` register content to the frame, which writes `navigator.clipboard`; and the frame syncs the system clipboard into nvim's `+`/`*` registers on focus so `"+p` pastes it.

**Tech Stack:** existing (TypeScript, esbuild, vitest, puppeteer smokes). No new runtime deps. Adds `clipboardRead`/`clipboardWrite` to the MV3 manifest.

## Global Constraints
- The engine (nvim-wasi artifact) and its API are NOT touched. All work is in the extension host: `src/engine-frame/`, `src/scratch/`, `src/manifest.json`, smokes.
- The overlay (embed mode) and its sync semantics must not regress: `npm test`, `node scripts/smoke-nvim.mjs`, `node scripts/browser-smoke.mjs`, `node scripts/overlay-smoke.mjs` all stay green.
- Persistence is a single scratch document (buffer text). Multi-note is out of scope (YAGNI).
- Clipboard paste freshness caveat is acceptable: paste reflects the system clipboard as of the last focus/visibility sync (always-fresh rpcrequest paste is a documented future refinement, needs incoming-RPC handling).
- Threaded/SharedArrayBuffer build is explicitly DEFERRED (perf-only; the Asyncify build already runs the scratch page at ~0/s idle). Note it, don't build it.
- Conventional commits. Shell rule: one command per Bash tool call.
- Branch: `feat/milestone-2`.

---

### Task 1: Scratch persistence store (`src/scratch/scratch-store.ts`)

**Files:**
- Create: `src/scratch/scratch-store.ts`, `src/scratch/scratch-store.test.ts`

**Interfaces:**
- Produces:
  - `interface ScratchStore { load(): Promise<string | null>; save(text: string): Promise<void> }`
  - `function openScratchStore(dbName?: string): ScratchStore` — IndexedDB-backed, object store `docs`, single key `"scratch"`. `load()` resolves `null` when nothing stored. Errors (quota, blocked) reject with a descriptive Error — callers decide (the frame degrades to non-persistent, never loses the live buffer).
  - `function serializeError(e: unknown): string` — small pure helper mapping an IndexedDB error/event to a message (unit-testable without IndexedDB).

- [ ] **Step 1: Failing test for the pure helper.** IndexedDB isn't available in vitest's node env, so unit-test only the pure `serializeError` here; the IndexedDB round-trip is proven in Task 4's browser smoke (documented in the test file header).

```ts
// src/scratch/scratch-store.test.ts
import { describe, expect, it } from "vitest";
import { serializeError } from "./scratch-store";

describe("serializeError", () => {
  it("uses an Error's message", () => {
    expect(serializeError(new Error("quota exceeded"))).toBe("quota exceeded");
  });
  it("reads a DOMException-like name/message", () => {
    expect(serializeError({ name: "QuotaExceededError", message: "no space" })).toContain("no space");
  });
  it("falls back to String() for unknown shapes", () => {
    expect(serializeError(42)).toBe("42");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run src/scratch/scratch-store.test.ts`).
- [ ] **Step 3: Implement.**

```ts
// src/scratch/scratch-store.ts
// IndexedDB-backed persistence for the scratch page's single draft. The store
// holds one document under key "scratch". The IndexedDB round-trip is exercised
// by scripts/browser-smoke.mjs (reload-persistence assertion); only the pure
// serializeError helper is unit-tested (vitest's node env has no IndexedDB).
export interface ScratchStore {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

const STORE = "docs";
const KEY = "scratch";

export function serializeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const name = "name" in e ? `${(e as { name: unknown }).name}: ` : "";
    return `${name}${(e as { message: unknown }).message}`;
  }
  return String(e);
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(serializeError(req.error)));
    req.onblocked = () => reject(new Error("scratch store open blocked"));
  });
}

export function openScratchStore(dbName = "nvim-in-browser"): ScratchStore {
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await openDb(dbName);
    try {
      return await new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(new Error(serializeError(req.error)));
      });
    } finally {
      db.close();
    }
  };
  return {
    async load() {
      const v = await tx<unknown>("readonly", (s) => s.get(KEY));
      return typeof v === "string" ? v : null;
    },
    async save(text) {
      await tx<IDBValidKey>("readwrite", (s) => s.put(text, KEY));
    },
  };
}
```

- [ ] **Step 4: Run — expect 3 passed. Typecheck.** (`npx vitest run src/scratch/scratch-store.test.ts`; `npm run typecheck`)
- [ ] **Step 5: Commit** `feat: IndexedDB-backed scratch persistence store`.

---

### Task 2: Wire persistence + full-mode channel into the scratch frame

**Files:**
- Modify: `src/engine-frame/engine-frame.ts`

**Interfaces:**
- Consumes: `openScratchStore` (Task 1); the existing `NvimClient` (`start`, `request`, `input`, `onEvent`), the existing `currentText()` and the `wasm_text_changed`/`nvim_get_api_info` machinery (currently only wired in embed mode).

Full mode today just calls `client.start()` on an empty buffer with no channel/autocmds. This task gives full mode: (a) a channel + `TextChanged` notify (reusing the embed pattern), (b) restore-on-boot from the store, (c) debounced save on change + `visibilitychange`(hidden)/`beforeunload`.

- [ ] **Step 1: Extract the channel+autocmd setup so full mode can reuse it.** Refactor `init()` so the "query channel, install TextChanged/VimLeavePre autocmds, get channel id" part is a helper `installBufferHooks(): Promise<number>` returning the channel id. Embed mode keeps its current behavior (seed text + hooks + `nvim-ready`). No behavior change to embed — verify by re-reading.

- [ ] **Step 2: Implement full-mode persistence.** Replace the `else` branch (lines ~134-139) with:

```ts
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
  scratchOnChange = scheduleSave; // consumed by the onEvent handler (see Step 3)
  // Best-effort flush when the tab is hidden or closing.
  const flush = () => {
    void currentText().then((t) => store.save(t)).catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("beforeunload", flush);
  void channel; // channel already used by installBufferHooks; kept for clarity
  canvas.focus();
}
```

- [ ] **Step 3: Route the change notification to the scratch saver.** The existing `client.onEvent` handles `wasm_text_changed` for embed mode (posts `nvim-text` to parent). Full mode has no parent. Make `onEvent` also invoke a module-level `scratchOnChange` hook when set:

Add near the top: `let scratchOnChange: (() => void) | null = null;`
In the `onEvent` `wasm_text_changed` branch, after the existing embed logic, add: `if (scratchOnChange) scratchOnChange();` (guard so embed mode, where scratchOnChange stays null, is unaffected).

- [ ] **Step 4: Import** `openScratchStore, serializeError` from `../scratch/scratch-store`.
- [ ] **Step 5: Typecheck + build.** `npm run typecheck`; `npm run fetch-assets` (idempotent); `npm run build`. Confirm `dist/chromium/scratch.html` + engine-frame bundle build.
- [ ] **Step 6: Commit** `feat: scratch page persists and restores its draft`.

---

### Task 3: Clipboard bridge (`"+y` out, `"+p` in)

**Files:**
- Modify: `src/engine-frame/engine-frame.ts`, `src/manifest.json`

**Interfaces:**
- Consumes: the channel id from `installBufferHooks` (Task 2); `NvimClient` request/onEvent.

- [ ] **Step 1: Manifest clipboard permissions.** In `src/manifest.json` add a top-level `"permissions": ["clipboardRead", "clipboardWrite"]` (create the array if absent; keep any existing entries).

- [ ] **Step 2: Copy — mirror yanks of `+`/`*` to the system clipboard.** In `installBufferHooks()`, extend the `nvim_exec2` autocmd block with a `TextYankPost` hook:

```
autocmd TextYankPost * if v:event.regname ==# '+' || v:event.regname ==# '*' | call rpcnotify(<chan>, 'clipboard_copy', v:event.regcontents) | endif
```

In `client.onEvent`, add a branch:

```ts
if (method === "clipboard_copy") {
  const lines = (args[0] as unknown[]).map((l) => (l instanceof Uint8Array ? new TextDecoder().decode(l) : String(l)));
  void navigator.clipboard.writeText(lines.join("\n")).catch((e) =>
    console.warn("[clipboard] write failed:", serializeError(e)),
  );
  return;
}
```

- [ ] **Step 3: Paste — sync the system clipboard into nvim's `+`/`*` registers on focus.** Add a helper used by both surfaces after boot:

```ts
async function syncClipboardIn(): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return; // no permission / not focused — leave registers as-is
  }
  const lines = text.split("\n");
  // setreg with 'c'/'l' regtype: use characterwise unless it ends in newline.
  await client.request("nvim_call_function", ["setreg", ["+", lines, "c"]]);
  await client.request("nvim_call_function", ["setreg", ["*", lines, "c"]]);
}
```

Call it once after `installBufferHooks()` (both modes), and on `document`'s `visibilitychange`→visible and `window` `focus`. Debounce/guard so overlapping calls don't stack (a simple in-flight boolean).

- [ ] **Step 4: Typecheck + build.** `npm run typecheck`; `npm run build`. Confirm `dist/chromium/manifest.json` has the clipboard permissions.

- [ ] **Step 5: Commit** `feat: clipboard bridge for + and * registers`.

---

### Task 4: Verify (browser smokes) + docs

**Files:**
- Modify: `scripts/browser-smoke.mjs` (add persistence + clipboard assertions), `README.md`, `docs/superpowers/specs/2026-07-14-nvim-in-browser-design.md` (mark Milestone 2 done).

- [ ] **Step 1: Persistence assertion in browser-smoke.** After the existing scratch boot, drive `__nvim.input("iremember this<Esc>")`, wait for the 400ms save debounce + slack (~800ms), then RELOAD the scratch page (`page.reload()` or reopen the scratch URL in a fresh page), wait for `__nvim.ready`, and assert `(await __nvim.getBufferText()).includes("remember this")`. This proves the IndexedDB round-trip. (IndexedDB persists across reloads within the same browser profile/userDataDir — puppeteer's default persists for the session; if the smoke uses a fresh context per run that's fine, the reload is same-context.)

- [ ] **Step 2: Clipboard-copy assertion.** Grant clipboard permissions to the page's origin via CDP (`Browser.grantPermissions` with `clipboardReadWrite` for the extension origin, or puppeteer `context.overridePermissions`). Drive `__nvim.input('ggVG"+y')` (yank whole buffer to `+`), wait ~300ms, then read `navigator.clipboard.readText()` in the page and assert it contains the buffer text. (If headless clipboard access is unreliable, assert instead that the `clipboard_copy` path ran by exposing a tiny `window.__lastClipboardWrite` hook set in the onEvent copy branch under the test-hooks flag — prefer the real navigator.clipboard read; fall back to the hook only if the environment blocks it, and document which was used.)

- [ ] **Step 3: Run the full gate.** `npm test`; `npm run typecheck`; `node scripts/smoke-nvim.mjs`; `node scripts/browser-smoke.mjs` (now includes persistence + clipboard); `node scripts/overlay-smoke.mjs` (unchanged — must still pass).

- [ ] **Step 4: Docs.** README: note the scratch page persists drafts and supports system clipboard (`"+y`/`"+p`), with the paste-freshness caveat. Spec: mark Milestone 2 done with a short implementation note (buffer-text persistence chosen over write-through FS; clipboard via TextYankPost + focus-sync; threaded build deferred).

- [ ] **Step 5: Commit** `test: persistence + clipboard browser smokes; docs: milestone 2 done`.

---

## Self-review notes
- Engine untouched — confirmed: all files are host-side (`src/engine-frame`, `src/scratch`, `src/manifest.json`, smokes). No `src/engine/*` or nvim-wasi changes.
- Embed-mode regression guard: Task 2 refactors `init()` but must preserve embed behavior; Task 4 re-runs overlay-smoke to prove it.
- Deferred + documented: threaded build; always-fresh rpcrequest paste (needs incoming-RPC handling); multi-note scratch.
- Interface consistency: `installBufferHooks(): Promise<number>`, `scratchOnChange`, `openScratchStore()/ScratchStore`, `serializeError` names match across tasks.
