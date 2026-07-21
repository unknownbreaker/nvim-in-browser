// firefox-behavioral-smoke.mjs — proves the WASM Neovim engine actually BOOTS
// and edits under real Firefox, not merely that the manifest installs.
//
// The install gate (scripts/firefox-smoke.mjs) confirms Firefox accepts the
// transformed manifest. THIS script goes further and exercises the whole
// runtime path in Firefox: content-script injection, overlay activation, the
// engine-frame iframe mount, wasm compile + boot, keystroke handling, and the
// debounced engine->field sync.
//
// Why it works around WebDriver BiDi:
//   BiDi refuses to navigate a tab to a privileged moz-extension:// URL, and it
//   surfaces cross-origin extension iframes as about:blank — so puppeteer cannot
//   read window.__nvim inside the engine frame directly. Instead we observe the
//   engine from the UNPRIVILEGED page world: when nvim edits, the overlay
//   debounce-syncs the buffer text back to the underlying textarea.value with a
//   synthetic input event. If a marker typed into the focused engine frame
//   reaches textarea.value, the engine booted, processed input, and synced.
//
// Self-contained: builds a NVIM_TEST_HOOKS=1 variant (so dist/firefox carries
// the nvim-activate-test postMessage hook the smoke uses to activate), runs the
// test, then rebuilds the production dist in a finally (so a failed run still
// leaves a production build behind, never a test one).
//
// Run: node scripts/firefox-behavioral-smoke.mjs
import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildDist } from "./lib/build-dist.mjs";
import { startFixtureServer } from "./lib/fixture-server.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(root, "dist", "firefox");
const pagesDir = path.join(root, "test-pages");
const FIREFOX_BIN =
  process.env.FIREFOX_BIN ||
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";
const MARKER = "FFBOOTPROOF";
const BOOT_WAIT_MS = 18_000; // first boot compiles a large wasm module
const SYNC_TIMEOUT_MS = 25_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[ff-behavioral] ${m}`);
const CT = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function build(testHooks) {
  buildDist({ testHooks, root });
}

async function run() {
  let browser, server;
  try {
    const contentJs = await readFile(path.join(DIST, "content.js"), "utf8");
    if (!contentJs.includes("nvim-activate-test")) {
      throw new Error("dist/firefox lacks the nvim-activate-test hook (test build failed?)");
    }

    const started = await startFixtureServer(pagesDir, {
      contentType: (file) => CT[path.extname(file)] || "text/plain",
    });
    server = started.server;
    const baseUrl = started.baseUrl;
    log(`fixture server at ${baseUrl}`);

    log("launching headless Firefox via BiDi...");
    browser = await puppeteer.launch({
      browser: "firefox",
      executablePath: FIREFOX_BIN,
      headless: true,
      protocol: "webDriverBiDi",
    });
    log(`installing extension: ${await browser.installExtension(DIST)}`);

    const page = await browser.newPage();
    await page.goto(`${baseUrl}/textarea.html`, { waitUntil: "load", timeout: 30_000 });
    await wait(700);

    log("activating overlay on #ta...");
    await page.evaluate(() => {
      // The test hook is gated on this data attribute (see overlay.ts).
      document.documentElement.dataset.nvimTestHook = "1";
      document.getElementById("ta").focus();
      window.postMessage({ type: "nvim-activate-test" }, "*");
    });

    await page.waitForFunction(
      () => !!document.querySelector('iframe[src*="engine-frame.html"]'),
      { timeout: 15_000, polling: 200 },
    );
    const frameSrc = await page.evaluate(
      () => document.querySelector('iframe[src*="engine-frame.html"]').src,
    );
    log(`engine-frame mounted: ${frameSrc}`);

    log(`waiting ~${BOOT_WAIT_MS / 1000}s for wasm engine boot...`);
    await wait(BOOT_WAIT_MS);

    // Click the overlay to focus the engine's hidden input, then type:
    // enter insert mode, type the marker, leave insert.
    const rect = await page.evaluate(() => {
      const r = document
        .querySelector('iframe[src*="engine-frame.html"]')
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(rect.x, rect.y);
    await wait(300);
    log("typing into the engine frame...");
    await page.keyboard.type("i");
    await wait(150);
    await page.keyboard.type(MARKER);
    await wait(150);
    await page.keyboard.press("Escape");

    log("polling textarea.value for the debounced engine sync...");
    let synced = "";
    let inputEvents = 0;
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        value: document.getElementById("ta").value,
        inputEvents: window.__inputEvents || 0,
      }));
      synced = state.value;
      inputEvents = state.inputEvents;
      if (synced.includes(MARKER)) break;
      await wait(500);
    }
    log(`textarea.value -> ${JSON.stringify(synced)}`);
    log(`synthetic input events -> ${inputEvents}`);

    if (synced.includes(MARKER) && inputEvents > 0) {
      console.log(
        `\nsmoke:firefox:behavioral PASS — WASM Neovim engine booted, accepted ` +
          `keystrokes, and synced the edit back to the field under Firefox ` +
          `(marker "${MARKER}" reached textarea.value via the debounced write path).`,
      );
      return true;
    }
    console.error(
      `\nsmoke:firefox:behavioral FAIL — marker did not reach the field. ` +
        `value=${JSON.stringify(synced)} inputEvents=${inputEvents}`,
    );
    return false;
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      if (server) server.close();
    } catch {}
  }
}

let ok = false;
try {
  console.log("building test-hooks dist (NVIM_TEST_HOOKS=1)...");
  build(true);
  ok = await run();
} catch (e) {
  console.error(`\nsmoke:firefox:behavioral FAIL — ${e && e.stack ? e.stack : e}`);
  ok = false;
} finally {
  // Always leave a production build behind, never a test build.
  console.log("restoring production dist...");
  build(false);
}
process.exit(ok ? 0 : 1);
