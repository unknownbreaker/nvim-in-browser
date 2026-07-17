// Overlay browser smoke: boots the built extension in a real Chromium, serves
// the test-pages/ fixture over a loopback HTTP server (content scripts need a
// real origin — file:// requires "Allow access to file URLs", which cannot be
// toggled programmatically), then drives the full Task 7 activation loop and
// asserts each stage programmatically. No human is watching, so every expected
// behaviour from the brief's manual Step 5 is a hard assertion here.
//
// Asserted:
//   1. Activation overlays the extension engine-frame iframe over the textarea,
//      positioned over the field.
//   2. Keys typed into nvim reach the buffer.
//   3. CRITICAL: a mid-session edit syncs back to textarea.value via the
//      debounced `nvim-text` message (>300ms) — NOT only on deactivate.
//   4. The synthetic input event fires (fixture's window.__inputEvents rises),
//      proving the React/Vue-controlled-component write path works.
//   5. The escape chord deactivates: final text syncs, iframe is removed, and
//      focus returns to the underlying field.
//   6. Single-line input: overlay honours the min-height strip; edit syncs.
//   7. Password input: activation is a no-op (no overlay, value untouched).
//   8. `:q` final-sync: fresh text typed then quit within the debounce window
//      still reaches the field, proving the VimLeavePre final sync (not a
//      surviving debounce — the frame is torn down before it could fire).
//   9. IME: a real composition sequence dispatched on the frame's hidden #ime
//      input (compositionstart/update/end) forwards the composed non-ASCII text
//      (accented Latin + CJK) into the nvim buffer via the compositionend path.
//  10. Hostile page: activating with focus on a non-eligible element creates NO
//      engine-frame overlay and shows the fallback notice pill instead.
//  11. Filetype: __nvim.request can set + read `&filetype` in-browser (the apply
//      mechanism); the host->filetype mapping is unit-tested separately.
//  12. Field-resize tracking: growing the textarea ELEMENT (fires no window
//      "resize" event) grows the overlay to match (ResizeObserver-on-target),
//      AND the nvim grid canvas inside the frame grows to fill the enlarged
//      iframe (frame resize -> nvim_ui_try_resize -> grid_resize).
//  13. T1 bridge phase (fast, NO engine): on framework-editors.html, for each
//      mock editor (Monaco, CM5, CM6) the MAIN-world bridge resolves the tagged
//      container and returns the mock's initial text (+ filetype where the
//      adapter exposes one), and a bridge `write` updates the mock's recorded
//      value — proving all three read/write adapters end-to-end.
//  14. T1 integration (with engine): focusing the CM5 mock's hidden textarea and
//      activating seeds the engine buffer with the CM5 mock's initial text (the
//      bridge read reached the engine); a mid-session edit writes back through
//      the bridge to the mock's setValue; the escape chord removes the overlay.
//
// Browser + extension-load handling mirrors scripts/browser-smoke.mjs.
//
// This smoke needs the test-only activation hook (nvim-activate-test, see
// src/content/overlay.ts), which is stripped from production builds via
// esbuild `define` dead-code elimination (scripts/build.mjs). So this script
// builds its OWN test build (NVIM_TEST_HOOKS=1) before launching, and rebuilds
// the real production dist/chromium afterwards (in a `finally`, so a failed
// smoke still leaves a production build behind, not a test one). It also
// proves the elimination actually works: it builds production first and
// asserts the string "nvim-activate-test" is absent from the bundled
// content.js.
//
// Run: node scripts/overlay-smoke.mjs   (builds everything itself)
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(root, "dist", "chromium");
const pagesDir = path.join(root, "test-pages");
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const shotPath = path.join(root, ".superpowers", "sdd", "task-7-overlay.png");
const BOOT_TIMEOUT_MS = 60_000; // first boot compiles ~8MB wasm
const SYNC_WAIT_MS = 900; // > 300ms debounce + slack
const MIN_STRIP_H = 220;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

// Rebuild dist/chromium. `testHooks` selects whether the test-only activation
// hook (nvim-activate-test) is compiled in; production always sets it "false"
// unless the env var is set, so make sure it's absent here.
function buildProd() {
  const env = { ...process.env };
  delete env.NVIM_TEST_HOOKS;
  execFileSync("node", ["scripts/build.mjs"], { cwd: root, env, stdio: "inherit" });
}

function buildTestHooks() {
  execFileSync("node", ["scripts/build.mjs"], {
    cwd: root,
    env: { ...process.env, NVIM_TEST_HOOKS: "1" },
    stdio: "inherit",
  });
}

// Prove the dead-code elimination actually works: production build must not
// contain the test-only activation string anywhere in the bundled content
// script, since a page can trigger it via postMessage if it's shipped.
async function assertProdHasNoTestHook() {
  console.log("building production dist/chromium (test hooks disabled) for dead-code check...");
  buildProd();
  const contentJs = await readFile(path.join(extDir, "content.js"), "utf8");
  if (contentJs.includes("nvim-activate-test")) {
    fail(
      'production build (dist/chromium/content.js) contains "nvim-activate-test" — ' +
        "esbuild dead-code elimination failed (check define __NVIM_TEST_HOOKS__ in scripts/build.mjs)",
    );
  }
  console.log("ASSERT OK: production build has no test-activation hook string (dead-code eliminated)");
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findChromeForTesting() {
  const base = path.join(root, "chrome");
  if (!(await exists(base))) return null;
  const results = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (
        e.name === "Google Chrome for Testing" ||
        e.name === "chrome" ||
        e.name === "chrome.exe"
      )
        results.push(full);
    }
  }
  await walk(base, 0);
  return results[0] ?? null;
}

async function resolveBrowser() {
  const env = process.env.NVIM_SMOKE_CHROME;
  if (env) return { exec: env, label: `env NVIM_SMOKE_CHROME` };
  const cft = await findChromeForTesting();
  if (cft) return { exec: cft, label: "Chrome for Testing (./chrome)" };
  if (await exists(SYSTEM_CHROME)) return { exec: SYSTEM_CHROME, label: "system Google Chrome" };
  return null;
}

function unpackedExtensionId(dir) {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  let id = "";
  for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

async function launch(exec, headless) {
  const defaults = await puppeteer.defaultArgs();
  const defaultDisable = defaults.find((a) => a.startsWith("--disable-features="));
  const feats = defaultDisable ? defaultDisable.slice("--disable-features=".length) : "";
  const mergedDisable = `--disable-features=${feats ? feats + "," : ""}DisableLoadExtensionCommandLineSwitch`;
  return puppeteer.launch({
    executablePath: exec,
    headless,
    ignoreDefaultArgs: ["--disable-extensions", defaultDisable].filter(Boolean),
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      mergedDisable,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

async function extensionLoaded(browser, id) {
  const swTarget = await browser
    .waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${id}/`),
      { timeout: 8_000 },
    )
    .catch(() => null);
  return Boolean(swTarget);
}

// Minimal static server for the fixture directory on a random loopback port.
function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const file = path.join(pagesDir, rel === "/" ? "textarea.html" : rel.replace(/^\/+/, ""));
      if (!file.startsWith(pagesDir)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// Activate the overlay via the test-only postMessage hook: stamp the opt-in
// attribute, focus the field, then post the activation message. Waits for the
// freshly-attached extension frame to boot (__nvim.ready).
async function activateOn(page, fieldId) {
  await page.evaluate((id) => {
    document.documentElement.dataset.nvimTestHook = "1";
    document.getElementById(id).focus();
    window.postMessage({ type: "nvim-activate-test" }, "*");
  }, fieldId);
  const frame = await page.waitForFrame((f) => f.url().includes("engine-frame.html"), {
    timeout: 15_000,
  });
  await frame.waitForFunction("window.__nvim && window.__nvim.ready === true", {
    timeout: BOOT_TIMEOUT_MS,
    polling: 250,
  });
  return frame;
}

// Dispatch the Ctrl+Shift+Esc chord inside the engine frame (the frame owns the
// deactivate path; it pulls final buffer text and posts nvim-deactivate).
async function sendEscapeChord(frame) {
  await frame.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
  });
}

function overlayRectInfo(page) {
  return page.evaluate((fieldId) => {
    const frame = document.querySelector('iframe[src*="engine-frame.html"]');
    const field = document.getElementById(fieldId);
    if (!frame || !field) return null;
    const f = frame.getBoundingClientRect();
    const t = field.getBoundingClientRect();
    return { fLeft: f.left, fTop: f.top, fHeight: f.height, tLeft: t.left, tTop: t.top };
  }, page.__fieldId);
}

// Drive one full MAIN-world bridge round-trip from the PAGE (which is itself
// the main world, same as the bridge): tag the container with data-nvim-editor,
// post a `read` request, then a `write` request, and resolve with both
// responses. Mirrors exactly what the isolated overlay's bridgeRequest does,
// but without the engine — this exercises the bridge adapters directly.
function bridgeRoundtrip(page, selector, writeText) {
  return page.evaluate(
    ({ selector, writeText }) =>
      new Promise((resolve, reject) => {
        const nonce = "smoke-" + Math.random().toString(36).slice(2);
        const container = document.querySelector(selector);
        if (!container) {
          reject(new Error(`no element for selector ${selector}`));
          return;
        }
        container.setAttribute("data-nvim-editor", nonce);
        const out = {};
        const timer = setTimeout(() => {
          window.removeEventListener("message", onMsg);
          reject(new Error(`bridge timed out for ${selector}`));
        }, 3000);
        function onMsg(ev) {
          if (ev.source !== window) return;
          if (ev.data?.source !== "nvim-bridge-res") return;
          if (ev.data.id === 1) {
            out.read = ev.data;
            window.postMessage(
              { source: "nvim-bridge-req", id: 2, op: "write", nonce, text: writeText },
              "*",
            );
          } else if (ev.data.id === 2) {
            out.write = ev.data;
            clearTimeout(timer);
            window.removeEventListener("message", onMsg);
            container.removeAttribute("data-nvim-editor");
            resolve(out);
          }
        }
        window.addEventListener("message", onMsg);
        window.postMessage({ source: "nvim-bridge-req", id: 1, op: "read", nonce }, "*");
      }),
    { selector, writeText },
  );
}

async function run(exec, headless, id, baseUrl) {
  const browser = await launch(exec, headless);
  try {
    if (!(await extensionLoaded(browser, id))) {
      await browser.close();
      return { ok: false, reason: "no-extension" };
    }
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));
    page.on("console", (msg) => {
      const t = msg.text();
      if (/error|fail|Uncaught/i.test(t)) console.log(`  [console] ${t}`);
    });

    await page.goto(`${baseUrl}/textarea.html`, { waitUntil: "load" });
    // Give the document_idle content script a moment to register listeners.
    await wait(400);

    // ---- Case 1: textarea, mid-session debounced sync + deactivate ----
    console.log("[textarea] activating...");
    let frame = await activateOn(page, "ta");
    page.__fieldId = "ta";

    const pos = await overlayRectInfo(page);
    if (!pos) return { ok: false, reason: "no overlay iframe after textarea activation" };
    console.log(`[textarea] overlay rect ${JSON.stringify(pos)}`);
    if (Math.abs(pos.fLeft - pos.tLeft) > 6 || Math.abs(pos.fTop - pos.tTop) > 6) {
      return { ok: false, reason: `overlay not positioned over textarea: ${JSON.stringify(pos)}` };
    }
    console.log("[textarea] ASSERT OK: overlay positioned over field");

    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath });
    console.log(`[textarea] screenshot -> ${shotPath}`);

    // Edit: ciw on first word -> "slow", back to normal mode.
    await frame.evaluate(() => window.__nvim.input("ciwslow"));
    await frame.evaluate(() => window.__nvim.input("<Esc>"));
    const buf = await frame.evaluate(() => window.__nvim.getBufferText());
    console.log(`[textarea] nvim buffer -> ${JSON.stringify(buf)}`);
    if (!buf.includes("slow quick brown fox")) {
      return { ok: false, reason: `keys did not reach nvim: ${JSON.stringify(buf)}` };
    }

    // CRITICAL: debounced nvim-text sync must land in the field BEFORE deactivate.
    await wait(SYNC_WAIT_MS);
    const midValue = await page.evaluate(() => document.getElementById("ta").value);
    const inputEvents = await page.evaluate(() => window.__inputEvents);
    console.log(`[textarea] mid-session textarea.value -> ${JSON.stringify(midValue)}`);
    console.log(`[textarea] window.__inputEvents -> ${inputEvents}`);
    if (midValue !== "slow quick brown fox.") {
      return {
        ok: false,
        reason: `CRITICAL: debounced sync did not update textarea.value: ${JSON.stringify(midValue)}`,
      };
    }
    if (!(inputEvents > 0)) {
      return { ok: false, reason: "synthetic input event never fired (controlled-path broken)" };
    }
    console.log("[textarea] ASSERT OK: debounced sync + synthetic input event");

    // Deactivate via escape chord; assert final sync, removal, focus restore.
    await sendEscapeChord(frame);
    await wait(600);
    const afterDeact = await page.evaluate(() => {
      const frameGone = !document.querySelector('iframe[src*="engine-frame.html"]');
      return {
        frameGone,
        value: document.getElementById("ta").value,
        focusedId: document.activeElement?.id ?? null,
      };
    });
    console.log(`[textarea] after deactivate -> ${JSON.stringify(afterDeact)}`);
    if (!afterDeact.frameGone) return { ok: false, reason: "overlay iframe not removed on deactivate" };
    if (afterDeact.value !== "slow quick brown fox.")
      return { ok: false, reason: `final sync wrong: ${JSON.stringify(afterDeact.value)}` };
    if (afterDeact.focusedId !== "ta")
      return { ok: false, reason: `focus not restored to textarea: ${afterDeact.focusedId}` };
    console.log("[textarea] ASSERT OK: final sync + iframe removed + focus restored");

    // ---- Case 2: single-line input, min-height strip + sync ----
    console.log("[input] activating...");
    frame = await activateOn(page, "q");
    page.__fieldId = "q";
    const inputPos = await overlayRectInfo(page);
    console.log(`[input] overlay rect ${JSON.stringify(inputPos)}`);
    if (!inputPos || inputPos.fHeight < MIN_STRIP_H) {
      return { ok: false, reason: `min-height strip not honoured: ${JSON.stringify(inputPos)}` };
    }
    console.log(`[input] ASSERT OK: overlay height ${inputPos.fHeight} >= ${MIN_STRIP_H}`);

    await frame.evaluate(() => window.__nvim.input("A-edited"));
    await frame.evaluate(() => window.__nvim.input("<Esc>"));
    await sendEscapeChord(frame);
    await wait(600);
    const inputValue = await page.evaluate(() => document.getElementById("q").value);
    console.log(`[input] value after deactivate -> ${JSON.stringify(inputValue)}`);
    if (inputValue !== "single line-edited")
      return { ok: false, reason: `input did not sync: ${JSON.stringify(inputValue)}` };
    console.log("[input] ASSERT OK: single-line value synced");

    // ---- Case 3: password input -> activation is a no-op ----
    console.log("[password] attempting activation (expected no-op)...");
    await page.evaluate(() => {
      document.getElementById("pw").focus();
      window.postMessage({ type: "nvim-activate-test" }, "*");
    });
    await wait(800);
    const pw = await page.evaluate(() => ({
      overlay: Boolean(document.querySelector('iframe[src*="engine-frame.html"]')),
      value: document.getElementById("pw").value,
    }));
    console.log(`[password] state -> ${JSON.stringify(pw)}`);
    if (pw.overlay) return { ok: false, reason: "password field should not get an overlay" };
    if (pw.value !== "never-touch-me")
      return { ok: false, reason: `password value mutated: ${JSON.stringify(pw.value)}` };
    console.log("[password] ASSERT OK: activation is a no-op");

    // ---- Case 4: `:q` final-syncs via VimLeavePre (not the debounce) ----
    // Re-activate the textarea, type fresh text, then quit in the SAME input
    // feed — far under the 300ms debounce. VimLeavePre carries the final buffer
    // out on exit; the frame (and its pending debounce timer) is torn down
    // immediately, so the only way the fresh text can reach the field is the
    // final sync. (We force-quit with `:q!`: the buffer is modified, so a bare
    // `:q` would E37; VimLeavePre fires identically on any quit.)
    console.log("[quit] re-activating textarea for :q final-sync test...");
    frame = await activateOn(page, "ta");
    page.__fieldId = "ta";
    await frame.evaluate(() => window.__nvim.input("Gofresh-quit-marker<Esc>:q!<CR>"));
    await wait(600);
    const quitState = await page.evaluate(() => ({
      frameGone: !document.querySelector('iframe[src*="engine-frame.html"]'),
      value: document.getElementById("ta").value,
    }));
    console.log(`[quit] after :q -> ${JSON.stringify(quitState)}`);
    if (!quitState.frameGone)
      return { ok: false, reason: ":q did not quit nvim — overlay iframe still present" };
    if (!quitState.value.includes("fresh-quit-marker"))
      return {
        ok: false,
        reason: `:q lost edits since last debounce — VimLeavePre final sync missing: ${JSON.stringify(quitState.value)}`,
      };
    console.log("[quit] ASSERT OK: :q final-synced fresh text via VimLeavePre");

    // ---- Case 5: IME composition reaches the buffer -----------------------
    // Dispatch a real browser IME composition sequence
    // (compositionstart -> compositionupdate -> compositionend) on the frame's
    // hidden #ime input. This is the exact event path the browser fires when a
    // user composes CJK / accented text via a system IME; our compositionend
    // handler forwards ev.data to nvim as literal insert-mode input. Driving the
    // real events (rather than a synthetic keystroke) proves the composition ->
    // client.input path end-to-end. We compose an accented Latin string and a
    // CJK string to cover both non-ASCII shapes.
    console.log("[ime] re-activating textarea for composition test...");
    frame = await activateOn(page, "ta");
    page.__fieldId = "ta";
    // Open a fresh line and stay in insert mode so composed text is inserted
    // literally rather than interpreted as normal-mode commands.
    await frame.evaluate(() => window.__nvim.input("Go"));
    await wait(150);
    const composeInFrame = (data) =>
      frame.evaluate((text) => {
        const ime = document.getElementById("ime");
        ime.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        ime.dispatchEvent(new CompositionEvent("compositionupdate", { data: text }));
        ime.dispatchEvent(new CompositionEvent("compositionend", { data: text }));
      }, data);
    await composeInFrame("café");
    await wait(200);
    await composeInFrame("日本");
    await wait(200);
    await frame.evaluate(() => window.__nvim.input("<Esc>"));
    const imeBuf = await frame.evaluate(() => window.__nvim.getBufferText());
    console.log(`[ime] nvim buffer -> ${JSON.stringify(imeBuf)}`);
    if (!imeBuf.includes("café"))
      return { ok: false, reason: `IME accented composition did not reach buffer: ${JSON.stringify(imeBuf)}` };
    if (!imeBuf.includes("日本"))
      return { ok: false, reason: `IME CJK composition did not reach buffer: ${JSON.stringify(imeBuf)}` };
    console.log("[ime] ASSERT OK: composed café + 日本 reached the nvim buffer");
    await sendEscapeChord(frame);
    await wait(600);

    // ---- Case 6: hostile page (no eligible field) -> notice, no overlay ----
    // Focus a non-eligible element (document.body) and trigger activation. The
    // content script must NOT create an engine-frame iframe, and must instead
    // show its fallback notice pill (stable selector: [data-nvim-notice]).
    console.log("[notice] focusing body (non-eligible) and activating...");
    await page.evaluate(() => {
      document.documentElement.dataset.nvimTestHook = "1";
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.body.focus();
      window.postMessage({ type: "nvim-activate-test" }, "*");
    });
    await wait(800);
    const noticeState = await page.evaluate(() => {
      const overlay = Boolean(document.querySelector('iframe[src*="engine-frame.html"]'));
      const pill = document.querySelector("[data-nvim-notice]");
      return { overlay, hasPill: Boolean(pill), text: pill ? pill.textContent : null };
    });
    console.log(`[notice] state -> ${JSON.stringify(noticeState)}`);
    if (noticeState.overlay)
      return { ok: false, reason: "hostile activation created an engine-frame overlay (should be a no-op)" };
    if (!noticeState.hasPill)
      return { ok: false, reason: "no fallback notice pill shown on hostile activation" };
    if (!/scratch/i.test(noticeState.text ?? ""))
      return { ok: false, reason: `notice text unexpected: ${JSON.stringify(noticeState.text)}` };
    console.log("[notice] ASSERT OK: no overlay iframe + fallback notice pill shown");
    // Dismiss the pill so it can't linger into later cases.
    await page.evaluate(() => document.querySelector("[data-nvim-notice]")?.remove());

    // ---- Case 7: filetype apply mechanism (via __nvim.request) ------------
    // The host->filetype MAPPING is covered by the pure unit test
    // (src/content/overlay-filetype.test.ts); the fixture is served from
    // 127.0.0.1, which filetypeForHost maps to undefined, so no filetype flows
    // through the real activation path here. This case instead proves the APPLY
    // MECHANISM in-browser: __nvim.request can set and read &filetype through
    // the RPC channel, which is exactly what init() does with a mapped host.
    console.log("[filetype] re-activating textarea to exercise the apply mechanism...");
    frame = await activateOn(page, "ta");
    page.__fieldId = "ta";
    await frame.evaluate(() => window.__nvim.request("nvim_exec2", ["setlocal filetype=markdown", {}]));
    const ft = await frame.evaluate(() => window.__nvim.request("nvim_get_option_value", ["filetype", {}]));
    console.log(`[filetype] &filetype -> ${JSON.stringify(ft)}`);
    if (ft !== "markdown")
      return { ok: false, reason: `filetype not applied/read via __nvim.request: ${JSON.stringify(ft)}` };
    console.log("[filetype] ASSERT OK: __nvim.request set + read filetype=markdown");
    await sendEscapeChord(frame);
    await wait(600);

    // ---- Case 8: overlay tracks the FIELD's own resize (ResizeObserver) ----
    // Growing the textarea ELEMENT (not the window) must grow the overlay.
    // Resizing a field fires no window "resize" event, so this proves the
    // ResizeObserver-on-target path re-runs positionFrame and the overlay
    // follows the field's box in both dimensions.
    console.log("[resize] re-activating textarea for field-resize tracking...");
    frame = await activateOn(page, "ta");
    page.__fieldId = "ta";
    // Size the field past the overlay's 480x220 minimums so the FIELD drives the
    // overlay size, then grow it and confirm the overlay tracks the new box.
    await page.evaluate(() => {
      const ta = document.getElementById("ta");
      ta.style.width = "560px";
      ta.style.height = "300px";
    });
    await wait(200);
    const preResize = await page.evaluate(() => {
      const f = document.querySelector('iframe[src*="engine-frame.html"]').getBoundingClientRect();
      return { h: f.height, w: f.width };
    });
    // The nvim grid canvas inside the frame BEFORE the grow — its CSS box should
    // then grow to fill the enlarged iframe (grid resizes to fit).
    const preCanvas = await frame.evaluate(() => {
      const c = document.getElementById("grid").getBoundingClientRect();
      return { w: c.width, h: c.height };
    });
    await page.evaluate(() => {
      const ta = document.getElementById("ta");
      ta.style.width = "720px";
      ta.style.height = "560px";
    });
    await wait(200);
    const postResize = await page.evaluate(() => {
      const f = document.querySelector('iframe[src*="engine-frame.html"]').getBoundingClientRect();
      const t = document.getElementById("ta").getBoundingClientRect();
      return { fh: f.height, fw: f.width, th: t.height, tw: t.width };
    });
    console.log(`[resize] overlay before ${JSON.stringify(preResize)} after ${JSON.stringify(postResize)}`);
    if (!(postResize.fh > preResize.h + 200))
      return { ok: false, reason: `overlay did not grow with the field's height: before ${preResize.h} after ${postResize.fh}` };
    if (Math.abs(postResize.fh - postResize.th) > 8)
      return { ok: false, reason: `overlay height did not match field: overlay ${postResize.fh} field ${postResize.th}` };
    if (Math.abs(postResize.fw - postResize.tw) > 8)
      return { ok: false, reason: `overlay width did not match field: overlay ${postResize.fw} field ${postResize.tw}` };
    console.log("[resize] ASSERT OK: overlay followed the field's own resize (size matched in both dimensions)");

    // The nvim GRID must also grow to fill the enlarged iframe: the frame gets a
    // window resize -> nvim_ui_try_resize -> grid_resize -> the canvas grows.
    // Poll (debounce 100ms + engine round-trip + raf).
    let postCanvas = preCanvas;
    for (let i = 0; i < 20; i++) {
      await wait(200);
      postCanvas = await frame.evaluate(() => {
        const c = document.getElementById("grid").getBoundingClientRect();
        return { w: c.width, h: c.height };
      });
      if (postCanvas.w > preCanvas.w + 100 && postCanvas.h > preCanvas.h + 100) break;
    }
    console.log(`[resize] nvim canvas before ${JSON.stringify(preCanvas)} after ${JSON.stringify(postCanvas)}`);
    if (!(postCanvas.w > preCanvas.w + 100))
      return { ok: false, reason: `nvim grid did not widen with the frame: before ${preCanvas.w} after ${postCanvas.w}` };
    if (!(postCanvas.h > preCanvas.h + 100))
      return { ok: false, reason: `nvim grid did not grow taller with the frame: before ${preCanvas.h} after ${postCanvas.h}` };
    // The grid should roughly fill the iframe (cell-size remainder aside).
    if (postResize.fw - postCanvas.w > 24 || postResize.fh - postCanvas.h > 30)
      return { ok: false, reason: `nvim grid does not fill the iframe: canvas ${JSON.stringify(postCanvas)} vs frame ${postResize.fw}x${postResize.fh}` };
    console.log("[resize] ASSERT OK: nvim grid grew to fill the resized iframe");
    await sendEscapeChord(frame);
    await wait(600);

    // ---- Case 9: T1 bridge phase (fast, NO engine) ------------------------
    // Navigate to the framework-editors fixture, whose own main-world script
    // installs mock Monaco / CM5 / CM6 editors. The MAIN-world bridge (also main
    // world) must resolve each tagged container and read the mock's initial text
    // (+ filetype where the adapter exposes it), and a bridge `write` must reach
    // the mock's setValue/dispatch. No engine is booted for this phase.
    console.log("[bridge] navigating to framework-editors.html...");
    await page.goto(`${baseUrl}/framework-editors.html`, { waitUntil: "load" });
    await wait(400);
    await page.waitForFunction("window.__nvimBridgeInstalled === true", { timeout: 8_000 });
    const mocks = await page.evaluate(() => window.__mocks);

    const bridgeCases = [
      { name: "monaco", selector: ".monaco-editor", initial: mocks.monacoInitial, filetype: "javascript", lastSetKey: "monacoLastSet", write: "monaco written text" },
      { name: "cm5", selector: ".CodeMirror", initial: mocks.cm5Initial, filetype: "javascript", lastSetKey: "cm5LastSet", write: "cm5 written text" },
      // CM6's read adapter does not report a filetype (no reliable path), so we
      // don't assert one here.
      { name: "cm6", selector: ".cm-editor", initial: mocks.cm6Initial, filetype: undefined, lastSetKey: "cm6LastSet", write: "cm6 written text" },
    ];
    for (const c of bridgeCases) {
      const res = await bridgeRoundtrip(page, c.selector, c.write);
      console.log(`[bridge:${c.name}] read -> ${JSON.stringify(res.read)} write -> ${JSON.stringify(res.write)}`);
      if (!res.read?.ok || res.read.text !== c.initial)
        return { ok: false, reason: `bridge ${c.name} read wrong: ${JSON.stringify(res.read)}` };
      if (c.filetype !== undefined && res.read.filetype !== c.filetype)
        return { ok: false, reason: `bridge ${c.name} filetype wrong: ${JSON.stringify(res.read.filetype)}` };
      if (!res.write?.ok)
        return { ok: false, reason: `bridge ${c.name} write not ok: ${JSON.stringify(res.write)}` };
      const lastSet = await page.evaluate((k) => window.__mocks[k], c.lastSetKey);
      if (lastSet !== c.write)
        return { ok: false, reason: `bridge ${c.name} write did not update mock (${c.lastSetKey}=${JSON.stringify(lastSet)})` };
      console.log(`[bridge:${c.name}] ASSERT OK: read initial + write-back reached the mock`);
    }
    console.log("[bridge] ASSERT OK: Monaco + CM5 + CM6 adapters read/write end-to-end");

    // ---- Case 10: T1 integration (with engine) ----------------------------
    // Focus the CM5 mock's hidden textarea and activate. The overlay must
    // resolve the .CodeMirror container via the framework path, seed the engine
    // buffer from the bridge read (== the mock's initial text), and — on a
    // mid-session edit — write back through the bridge to the mock's setValue.
    // Reload the fixture so the mocks reset to their initial values (the bridge
    // phase above wrote into them), giving the integration a clean starting buffer.
    console.log("[t1-integration] reloading fixture + activating on CM5 mock's textarea...");
    await page.goto(`${baseUrl}/framework-editors.html`, { waitUntil: "load" });
    await wait(400);
    frame = await activateOn(page, "cm5ta");
    const t1Buf = await frame.evaluate(() => window.__nvim.getBufferText());
    console.log(`[t1-integration] engine buffer -> ${JSON.stringify(t1Buf)}`);
    if (t1Buf !== mocks.cm5Initial)
      return { ok: false, reason: `bridge read did not seed engine buffer: ${JSON.stringify(t1Buf)}` };
    console.log("[t1-integration] ASSERT OK: engine buffer seeded from CM5 mock via bridge read");

    // Append text in the engine, then wait past the 300ms debounce so the
    // nvim-text sync fires and the overlay writes back through the bridge.
    await frame.evaluate(() => window.__nvim.input("A EDITED"));
    await frame.evaluate(() => window.__nvim.input("<Esc>"));
    await wait(SYNC_WAIT_MS);
    const cm5Written = await page.evaluate(() => window.__mocks.cm5LastSet);
    console.log(`[t1-integration] CM5 mock setValue received -> ${JSON.stringify(cm5Written)}`);
    if (cm5Written !== `${mocks.cm5Initial} EDITED`)
      return { ok: false, reason: `bridge write-back did not reach CM5 setValue: ${JSON.stringify(cm5Written)}` };
    console.log("[t1-integration] ASSERT OK: mid-session edit wrote back through the bridge to CM5 setValue");

    await sendEscapeChord(frame);
    await wait(600);
    const t1Gone = await page.evaluate(() => !document.querySelector('iframe[src*="engine-frame.html"]'));
    if (!t1Gone)
      return { ok: false, reason: "T1 overlay iframe not removed on deactivate" };
    console.log("[t1-integration] ASSERT OK: escape chord removed the overlay");

    await browser.close();
    return { ok: true };
  } catch (e) {
    await browser.close().catch(() => {});
    return { ok: false, reason: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  }
}

async function main() {
  // Prove dead-code elimination works before touching the test build at all.
  await assertProdHasNoTestHook();

  // Everything from here on runs against a TEST build (test-only activation
  // hook compiled in). The `finally` below restores dist/chromium to a real
  // production build no matter how this turns out (pass, fail, or throw).
  try {
    console.warn(
      "WARNING: building with NVIM_TEST_HOOKS=1 for this smoke run — dist/chromium is now " +
        "a TEST build (test-only activation hook enabled), not for production use.",
    );
    buildTestHooks();

    if (!(await exists(path.join(extDir, "manifest.json")))) {
      throw new Error(`no build at ${extDir} after test build`);
    }
    const browser = await resolveBrowser();
    if (!browser) {
      throw new Error(
        "no Chromium found. Install Chrome for Testing: " +
          "`npx @puppeteer/browsers install chrome@stable`, or set $NVIM_SMOKE_CHROME.",
      );
    }
    const id = unpackedExtensionId(extDir);
    const { server, baseUrl } = await startFixtureServer();
    console.log(`browser: ${browser.label}`);
    console.log(`extension id: ${id}`);
    console.log(`fixture server: ${baseUrl}`);

    let result = await run(browser.exec, true, id, baseUrl);
    if (!result.ok && result.reason === "no-extension") {
      console.log("headless extension load failed; retrying headed (headless:false)...");
      result = await run(browser.exec, false, id, baseUrl);
    }
    server.close();

    if (!result.ok && result.reason === "no-extension") {
      throw new Error(
        `extension did not load in ${browser.label}. If this is a managed/MDM Chrome ` +
          "with developer mode disabled by policy, use Chrome for Testing instead.",
      );
    }
    if (!result.ok) throw new Error(result.reason);

    console.log(
      "\nPASS: overlay activation, debounced sync, deactivate, input + password cases, " +
        "IME composition, hostile-page notice, filetype-apply mechanism, field-resize tracking, " +
        "T1 bridge phase (Monaco + CM5 + CM6 read/write), and T1 engine integration (CM5)",
    );
  } finally {
    console.log("restoring production dist/chromium (test hooks disabled)...");
    buildProd();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
