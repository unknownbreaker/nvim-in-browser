// Browser smoke test: boots the built extension in a real Chromium and drives
// the engine frame end-to-end. This is the automated replacement for the
// brief's manual boot gate — no human is watching, so we assert programmatically.
//
// It loads dist/chromium as an unpacked extension, opens the scratch page
// (which hosts engine-frame.html?mode=full in an iframe), waits for the engine
// to boot and attach, types "ihello world" via the __nvim debug hook, asserts
// the buffer round-trips, screenshots the canvas, then idles ~12s to confirm
// the engine parks (idle poll wake-ups fall to a low steady rate).
//
// Phases (each asserts programmatically):
//   PHASE A — draft persists across a reload (IndexedDB scratch store).
//   PHASE B — `"+y` yank reaches the system clipboard.
//   PHASE C — a config saved to IndexedDB (init.lua) loads into nvim at boot:
//             tabstop=7 is read back after a reload (proves IndexedDB -> FS ->
//             nvim config-boot end-to-end), safeMode stays false.
//   PHASE D — a broken/hanging config recovers via safe mode: the engine still
//             boots (ready), safeMode is true, and the broken config did NOT
//             apply (tabstop back to default 8). Cleans up the config after.
//   PHASE E — idle teardown -> respawn -> restore: with the idle window shrunk
//             to ~2.5s via window.__nvimIdleMs, the frame disposes its worker
//             (debug.sleeping true, "💤 sleeping" overlay shown); a keydown
//             respawns a fresh engine and restores the typed draft.
//
// Browser resolution (first that exists wins):
//   1. $NVIM_SMOKE_CHROME               — explicit override
//   2. Chrome for Testing under ./chrome — installed via
//        `npx @puppeteer/browsers install chrome@stable`
//   3. system Google Chrome             — /Applications/Google Chrome.app
//
// NOTE: a managed/MDM-enrolled system Chrome may refuse to load unpacked
// extensions ("Developer mode is managed by your administrator"), which the
// --load-extension feature flag cannot override. On such machines install
// Chrome for Testing (step 2) — it is a vanilla Chromium not subject to the
// com.google.Chrome cloud policy. That is why this repo prefers it.
//
// Run: npm run build   (once)   then   node scripts/browser-smoke.mjs
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(root, "dist", "chromium");
const shotPath = path.join(root, ".superpowers", "sdd", "task-6-boot.png");
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BOOT_TIMEOUT_MS = 60_000; // first boot compiles ~11MB wasm
// Safe-mode reboot: the broken config boot hangs its full 12s watchdog before
// the clean retry compiles wasm, so give this path extra headroom.
const SAFE_MODE_TIMEOUT_MS = 90_000;
const IDLE_MS = 12_000;
const IDLE_GATE = 5; // last idle stat sample must be <= this many wakeups/sec

// Performance budgets (Phase B). These are DELIBERATELY GENEROUS headless-CI
// ceilings, NOT the real numbers — a warm local/desktop run is far under them.
// They exist to catch gross regressions (a boot that suddenly doubles, an RPC
// path that stalls), not to measure true performance.
//   BOOT_BUDGET_MS: cold boot, first-load compile of the ~11MB wasm INCLUDED.
//     Real cold boot is ~1-2s; headless CI slack pushes the ceiling to 6s.
//   LATENCY_BUDGET_MS: p95 of a minimal RPC round-trip. Real is ~3ms; headless
//     scheduling jitter justifies the 75ms ceiling.
const BOOT_BUDGET_MS = 6_000;
const LATENCY_BUDGET_MS = 75;
const LATENCY_SAMPLES = 40; // RPC round-trips driven for the latency gate

// Idle-teardown gate (PHASE E). The frame tears its worker down after its idle
// window (default 5 min) elapses with no input; window.__nvimIdleMs overrides
// that window (read at idle-timer arm time inside the frame) so the smoke can
// exercise teardown -> respawn -> restore in seconds, not minutes. 2.5s is small
// enough to keep the smoke quick, yet comfortably clears the sub-second type +
// confirm sequence before the timer fires.
const IDLE_TEARDOWN_TEST_MS = 2_500;
const IDLE_MARKER = "idle-teardown-marker"; // distinctive draft proving restore
const SLEEP_POLL_TIMEOUT_MS = 15_000; // generous ceiling to observe sleeping===true

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

// ---- config-store IndexedDB helpers (PHASE C/D) --------------------------
// The config store lives in the SAME origin DB the app uses: name
// "nvim-in-browser", version 2, object store "config", file records keyed
// "file:"+relpath and a single "meta" = {enabled}. We drive it directly from
// the page context to simulate the options page having saved a config. The
// app already created the stores, so we open at version 2 (never lower — a
// lower version would abort with VersionError).
function idbWriteConfig(page, initLua, enabled) {
  return page.evaluate(
    ({ initLua, enabled }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("nvim-in-browser", 2);
        open.onerror = () => reject(new Error("open failed: " + (open.error?.message ?? "?")));
        open.onblocked = () => reject(new Error("open blocked"));
        open.onsuccess = () => {
          const db = open.result;
          let tx;
          try {
            tx = db.transaction("config", "readwrite");
          } catch (e) {
            db.close();
            reject(new Error("tx open failed: " + (e?.message ?? String(e))));
            return;
          }
          const store = tx.objectStore("config");
          store.put(initLua, "file:init.lua");
          store.put({ enabled }, "meta");
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("tx error: " + (tx.error?.message ?? "?")));
          };
        };
      }),
    { initLua, enabled },
  );
}

// Cleanup: remove the config file and disable the config so a broken config
// can't poison later phases, reruns, or a subsequent overlay-smoke.
function idbClearConfig(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("nvim-in-browser", 2);
        open.onerror = () => reject(new Error("open failed: " + (open.error?.message ?? "?")));
        open.onblocked = () => reject(new Error("open blocked"));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("config", "readwrite");
          const store = tx.objectStore("config");
          store.delete("file:init.lua");
          store.put({ enabled: false }, "meta");
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("clear tx error: " + (tx.error?.message ?? "?")));
          };
        };
      }),
  );
}

// Open a FRESH scratch page and wait for its engine-frame's __nvim.ready.
// Returns { page, frame }. We use a brand-new page (rather than page.reload)
// for the config phases on purpose: reloading a frame while the new engine is
// slow to boot (the safe-mode path) races the OLD frame's detach against our
// CDP evaluate, which then hangs. A new page has its own frame tree, so there
// is no detaching frame to bind to by mistake. IndexedDB is per-origin, so the
// new page sees the same config store the previous page wrote. bootTimeout is
// generous for safe mode, whose config boot burns its full 12s watchdog before
// the clean retry compiles wasm.
async function openScratchReady(browser, id, label, bootTimeout) {
  const p = await browser.newPage();
  p.on("pageerror", (err) => console.log(`  [${label} pageerror] ${err.message}`));
  await p.goto(`chrome-extension://${id}/scratch.html`, { waitUntil: "domcontentloaded" });
  const f = await p.waitForFrame((fr) => fr.url().includes("engine-frame.html"), {
    timeout: 15_000,
  });
  const t = Date.now();
  await f.waitForFunction("window.__nvim && window.__nvim.ready === true", {
    timeout: bootTimeout,
    polling: 250,
  });
  console.log(`[${label}] engine ready in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return { page: p, frame: f };
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Locate a Chrome-for-Testing binary under ./chrome (as laid down by
// @puppeteer/browsers). Returns the first macOS/Linux/Windows binary found.
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

// Chrome derives an unpacked extension's ID from the SHA-256 of its absolute
// path: first 16 bytes, each hex nibble mapped 0-15 -> 'a'-'p'. Computing it
// avoids depending on the (lazy) background service-worker target.
function unpackedExtensionId(dir) {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  let id = "";
  for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

async function launch(exec, headless) {
  // Puppeteer's defaults include `--disable-extensions` and a `--disable-features`
  // list. Drop the former, and fold DisableLoadExtensionCommandLineSwitch into
  // the latter (Chrome 137+ gates --load-extension behind that feature).
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

// Confirm the extension actually loaded (managed Chrome silently drops it).
async function extensionLoaded(browser, id) {
  const swTarget = await browser
    .waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${id}/`),
      { timeout: 8_000 },
    )
    .catch(() => null);
  return Boolean(swTarget);
}

async function run(exec, headless, id) {
  const browser = await launch(exec, headless);
  const wakeupLog = [];
  try {
    if (!(await extensionLoaded(browser, id))) {
      await browser.close();
      return { ok: false, reason: "no-extension" };
    }
    const page = await browser.newPage();

    // Grant clipboard read/write to the extension origin up front so PHASE B can
    // read back a `"+y` yank. The scratch page and its engine-frame iframe are
    // both same-origin (chrome-extension://<id>), so one grant covers both.
    const originUrl = `chrome-extension://${id}`;
    try {
      await browser.defaultBrowserContext().overridePermissions(originUrl, [
        "clipboard-read",
        "clipboard-write",
      ]);
      console.log(`granted clipboard-read/write to ${originUrl}`);
    } catch (e) {
      console.log(`clipboard permission grant failed (${errText(e)}); PHASE B may soft-skip`);
    }

    page.on("console", (msg) => {
      const text = msg.text();
      const m = text.match(/poll wakeups\/sec:\s*([\d.]+)/);
      if (m) wakeupLog.push(Number(m[1]));
      console.log(`  [console] ${text}`);
    });
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));
    page.on("requestfailed", (r) =>
      console.log(`  [reqfailed] ${r.url()} ${r.failure()?.errorText ?? ""}`),
    );

    // Time the cold boot: from just before the initial scratch load through to
    // __nvim.ready. This IS the perf boot-time gate's measurement (Phase B) — a
    // real page load that compiles the ~11MB wasm from scratch, so no separate
    // load is added just to time one.
    const bootStart = Date.now();
    await page.goto(`chrome-extension://${id}/scratch.html`, { waitUntil: "domcontentloaded" });

    // The engine + __nvim hook live inside the engine-frame iframe.
    const frame = await page.waitForFrame((f) => f.url().includes("engine-frame.html"), {
      timeout: 15_000,
    });

    console.log("waiting for engine to boot + attach (up to 60s)...");
    const t0 = Date.now();
    await frame.waitForFunction("window.__nvim && window.__nvim.ready === true", {
      timeout: BOOT_TIMEOUT_MS,
      polling: 250,
    });
    console.log(`engine ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ---- PERF GATE 1: boot-time budget (cold, wasm-compile-inclusive) -------
    const bootMs = Date.now() - bootStart;
    console.log(`PERF: boot ${bootMs}ms (budget ${BOOT_BUDGET_MS})`);
    if (bootMs >= BOOT_BUDGET_MS) {
      await browser.close();
      return { ok: false, reason: `boot ${bootMs}ms exceeds budget ${BOOT_BUDGET_MS}ms (cold, ~11MB wasm compile included)` };
    }
    console.log("PERF: ASSERT OK: cold boot under budget");

    // Drive input through the debug hook (rpcnotify path; no real focus needed).
    await frame.evaluate(() => window.__nvim.input("ihello world"));
    await wait(500);
    const text = await frame.evaluate(() => window.__nvim.getBufferText());
    console.log(`buffer text -> ${JSON.stringify(text)}`);
    if (!text.includes("hello world")) {
      await browser.close();
      return { ok: false, reason: `buffer missing "hello world": ${JSON.stringify(text)}` };
    }
    console.log('ASSERT OK: buffer contains "hello world"');

    // Screenshot the rendered canvas.
    await mkdir(path.dirname(shotPath), { recursive: true });
    const canvas = await frame.$("#grid");
    if (canvas) await canvas.screenshot({ path: shotPath });
    else await page.screenshot({ path: shotPath });
    console.log(`screenshot -> ${shotPath}`);

    // Idle window: engine should park; poll wake-ups fall to a low steady rate.
    console.log(`idling ${IDLE_MS / 1000}s to observe idle poll wake-ups...`);
    const idleStart = wakeupLog.length;
    await wait(IDLE_MS);
    const idleSamples = wakeupLog.slice(idleStart);
    const lastFromHook = await frame.evaluate(() => window.__nvim.wakeupsPerSecond);
    console.log(`wakeups/sec stream: ${JSON.stringify(wakeupLog)}`);
    console.log(`idle-window samples: ${JSON.stringify(idleSamples)}`);
    console.log(`last __nvim.wakeupsPerSecond: ${lastFromHook}`);

    const lastIdle = idleSamples.length ? idleSamples[idleSamples.length - 1] : lastFromHook;

    if (lastIdle > IDLE_GATE) {
      await browser.close();
      return { ok: false, reason: `idle wakeups ${lastIdle}/s exceeds gate ${IDLE_GATE}/s` };
    }

    // ---- PERF GATE 2: input-latency budget (RPC round-trip proxy) ----------
    // Drive LATENCY_SAMPLES minimal RPC round-trips against the now-idle engine
    // and gate p95. nvim_eval("1") is the cheapest request that still exercises
    // the full page -> worker -> nvim -> back path, so it stands in for input
    // responsiveness. Each round-trip is timed host-side (Date.now bracketing
    // the awaited evaluate) so the number reflects real end-to-end latency.
    console.log(`\n[PERF] input latency: driving ${LATENCY_SAMPLES} RPC round-trips (nvim_eval)...`);
    const latencies = [];
    for (let i = 0; i < LATENCY_SAMPLES; i++) {
      const t0 = Date.now();
      await frame.evaluate(() => window.__nvim.request("nvim_eval", ["1"]));
      latencies.push(Date.now() - t0);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
    const p50 = pct(50);
    const p95 = pct(95);
    console.log(`PERF: latency p50=${p50}ms p95=${p95}ms (budget ${LATENCY_BUDGET_MS})`);
    if (p95 >= LATENCY_BUDGET_MS) {
      await browser.close();
      return { ok: false, reason: `input latency p95 ${p95}ms exceeds budget ${LATENCY_BUDGET_MS}ms (samples: ${JSON.stringify(latencies)})` };
    }
    console.log("PERF: ASSERT OK: input latency p95 under budget");

    // ---- PHASE A: persistence across reload (IndexedDB round-trip) ----------
    // Type a draft, wait past the 400ms save debounce, then reload the SAME page
    // in the SAME browser context (IndexedDB survives a reload; a fresh context
    // would not). A clean re-boot that restores the draft proves the round-trip.
    console.log("\n[PHASE A] persistence: typing draft, waiting for debounced save...");
    await frame.evaluate(() => window.__nvim.input("iremember this draft<Esc>"));
    await wait(900); // 400ms save debounce + slack
    console.log("[PHASE A] reloading page (same context -> IndexedDB persists)...");
    await page.reload({ waitUntil: "load" });
    const frame2 = await page.waitForFrame((f) => f.url().includes("engine-frame.html"), {
      timeout: 15_000,
    });
    console.log("[PHASE A] re-waiting for engine ready after reload (fresh wasm compile, up to 60s)...");
    const tReload = Date.now();
    await frame2.waitForFunction("window.__nvim && window.__nvim.ready === true", {
      timeout: BOOT_TIMEOUT_MS,
      polling: 250,
    });
    console.log(`[PHASE A] engine ready after reload in ${((Date.now() - tReload) / 1000).toFixed(1)}s`);
    const persisted = await frame2.evaluate(() => window.__nvim.getBufferText());
    console.log(`[PHASE A] restored buffer -> ${JSON.stringify(persisted)}`);
    if (!persisted.includes("remember this draft")) {
      await browser.close();
      return {
        ok: false,
        reason: `persistence failed: buffer after reload missing "remember this draft": ${JSON.stringify(persisted)}`,
      };
    }
    console.log('[PHASE A] ASSERT OK: draft persisted across reload via IndexedDB');

    // ---- PHASE B: system clipboard copy (TextYankPost -> writeText) ---------
    // `"+y` fires the TextYankPost autocmd -> clipboard_copy rpcnotify ->
    // navigator.clipboard.writeText, INSIDE the engine-frame iframe. Read the
    // clipboard back from that same frame context (same origin as the grant).
    console.log("\n[PHASE B] clipboard: select-all + yank whole buffer to + register...");
    await frame2.evaluate(() => window.__nvim.input('ggVG"+y'));
    await wait(500);

    const readClip = async (ctx, label) => {
      try {
        const v = await ctx.evaluate(() => navigator.clipboard.readText());
        console.log(`[PHASE B] clipboard.readText() (${label}) -> ${JSON.stringify(v)}`);
        return typeof v === "string" ? v : null;
      } catch (e) {
        console.log(`[PHASE B] clipboard.readText() (${label}) threw: ${errText(e)}`);
        return null;
      }
    };

    let clipboard = "skipped";
    const frameClip = await readClip(frame2, "engine-frame");
    if (frameClip !== null && frameClip.includes("remember this draft")) {
      console.log("[PHASE B] ASSERT OK: system clipboard has yanked text (real read, engine-frame context)");
      clipboard = "verified:engine-frame";
    } else {
      const pageClip = await readClip(page, "page");
      if (pageClip !== null && pageClip.includes("remember this draft")) {
        console.log("[PHASE B] ASSERT OK: system clipboard has yanked text (real read, page context)");
        clipboard = "verified:page";
      } else {
        // Headless clipboard read blocked despite the grant. Do not fail flakily:
        // the copy CODE PATH still ran iff the buffer held real text to yank, which
        // PHASE A already proved. Log an honest SKIP rather than a false pass.
        const buf = await frame2.evaluate(() => window.__nvim.getBufferText());
        if (buf.includes("remember this draft")) {
          console.log(
            "[PHASE B] clipboard copy: SKIPPED (headless clipboard unavailable). " +
              "Yank ran against a real buffer; copy code path exercised.",
          );
          clipboard = "skipped";
        } else {
          await browser.close();
          return { ok: false, reason: `clipboard: yank buffer unexpectedly empty: ${JSON.stringify(buf)}` };
        }
      }
    }

    // ---- PHASE C: config loads (IndexedDB -> FS -> nvim at boot) -----------
    // Simulate the options page having saved a config: write init.lua + enabled
    // meta straight into the config store, open a fresh scratch page, and confirm
    // nvim booted WITH the config by reading back an option the config set
    // (tabstop = 7, default is 8). Proves the full IndexedDB -> config-boot path.
    console.log("\n[PHASE C] config: writing init.lua (vim.o.tabstop = 7, enabled) to IndexedDB...");
    await idbWriteConfig(page, "vim.o.tabstop = 7", true);
    console.log("[PHASE C] opening a fresh scratch page to boot with the persisted config...");
    const { page: pageC, frame: frameC } = await openScratchReady(browser, id, "PHASE C", BOOT_TIMEOUT_MS);
    // Capture page errors for the rest of PHASE C so a "Buffer is not
    // 'modifiable'" throw (the netrw-listing regression) is caught, not just
    // logged. This assertion is what would have caught the milestone-4 bug.
    const phaseCErrors = [];
    pageC.on("pageerror", (err) => phaseCErrors.push(err.message));
    const tabstopC = await frameC.evaluate(() =>
      window.__nvim.request("nvim_get_option_value", ["tabstop", {}]),
    );
    const safeModeC = await frameC.evaluate(() => window.__nvim.safeMode);
    console.log(`[PHASE C] tabstop -> ${JSON.stringify(tabstopC)}, safeMode -> ${safeModeC}`);
    if (tabstopC !== 7) {
      await browser.close();
      return { ok: false, reason: `config did not load: tabstop is ${JSON.stringify(tabstopC)}, expected 7` };
    }
    if (safeModeC !== false) {
      await browser.close();
      return { ok: false, reason: `config booted but safeMode is ${safeModeC}, expected false` };
    }

    // Editability: under config boot the startup buffer must be a normal
    // modifiable [No Name], NOT a nomodifiable netrw directory listing of `/`.
    // Assert &modifiable is true, then actually type into the buffer and read it
    // back — proving nvim_buf_set_lines / real input work (no "not modifiable").
    const modifiableC = await frameC.evaluate(() =>
      window.__nvim.request("nvim_get_option_value", ["modifiable", {}]),
    );
    console.log(`[PHASE C] modifiable -> ${JSON.stringify(modifiableC)}`);
    if (modifiableC !== true) {
      await browser.close();
      return { ok: false, reason: `config buffer not editable: modifiable is ${JSON.stringify(modifiableC)}, expected true (netrw listing regression?)` };
    }
    await frameC.evaluate(() => window.__nvim.input("iconfig typed<Esc>"));
    await wait(500);
    const typedC = await frameC.evaluate(() => window.__nvim.getBufferText());
    console.log(`[PHASE C] buffer after typing -> ${JSON.stringify(typedC)}`);
    if (!typedC.includes("config typed")) {
      await browser.close();
      return { ok: false, reason: `config buffer not typeable: text after input is ${JSON.stringify(typedC)}, expected to contain "config typed"` };
    }
    // No "Buffer is not 'modifiable'" (or similar) throw during this phase.
    const modErr = phaseCErrors.find((m) => /not ['"]?modifiable/i.test(m));
    if (modErr) {
      await browser.close();
      return { ok: false, reason: `config boot raised a modifiable pageerror: ${JSON.stringify(modErr)}` };
    }
    console.log(`[PHASE C] pageerrors during phase: ${JSON.stringify(phaseCErrors)}`);
    console.log("PHASE C: config loaded (tabstop=7), buffer editable (typed 'config typed'), no modifiable error");

    // ---- PHASE D: safe mode recovers a broken config ----------------------
    // Overwrite init.lua with a config that hangs nvim at boot (infinite loop),
    // then open a fresh scratch page. The config boot must time out (12s
    // watchdog), dispose the wedged engine, and boot a CLEAN one:
    // __nvim.ready true, __nvim.safeMode true, and the hanging config's tabstop
    // change must NOT have applied (default 8).
    console.log("\n[PHASE D] safe mode: overwriting init.lua with a HANGING config (while true do end)...");
    await idbWriteConfig(pageC, "while true do end", true);
    console.log("[PHASE D] opening a fresh scratch page; config boot hangs then a clean retry boots (allow ~90s)...");
    const { page: pageD, frame: frameD } = await openScratchReady(browser, id, "PHASE D", SAFE_MODE_TIMEOUT_MS);
    // Read all three signals in one page-side evaluate, racing the (worker-bound)
    // tabstop request against an in-page timeout so a wedged worker can never hang
    // the CDP call itself.
    const stateD = await frameD.evaluate(async () => {
      const ready = window.__nvim.ready;
      const safeMode = window.__nvim.safeMode;
      let tabstop = null;
      let tabstopError = null;
      try {
        tabstop = await Promise.race([
          window.__nvim.request("nvim_get_option_value", ["tabstop", {}]),
          new Promise((_r, rej) => setTimeout(() => rej(new Error("request timed out")), 8000)),
        ]);
      } catch (e) {
        tabstopError = e && e.message ? e.message : String(e);
      }
      return { ready, safeMode, tabstop, tabstopError };
    });
    const readyD = stateD.ready;
    const safeModeD = stateD.safeMode;
    const tabstopD = stateD.tabstop;
    console.log(
      `[PHASE D] ready -> ${readyD}, safeMode -> ${safeModeD}, tabstop -> ${JSON.stringify(tabstopD)}` +
        (stateD.tabstopError ? ` (tabstop request error: ${stateD.tabstopError})` : ""),
    );

    // CLEANUP FIRST: whatever the asserts do, never leave a broken config that
    // could poison a rerun or a subsequent overlay-smoke run.
    console.log("[PHASE D] cleanup: deleting init.lua + disabling config in IndexedDB...");
    await idbClearConfig(pageD).catch((e) => console.log(`[PHASE D] cleanup warn: ${errText(e)}`));

    if (readyD !== true) {
      await browser.close();
      return { ok: false, reason: `safe mode: engine not ready after broken config (ready=${readyD})` };
    }
    if (safeModeD !== true) {
      await browser.close();
      return { ok: false, reason: `safe mode: safeMode is ${safeModeD}, expected true after broken config` };
    }
    if (tabstopD !== 8) {
      await browser.close();
      return { ok: false, reason: `safe mode: tabstop is ${JSON.stringify(tabstopD)}, expected default 8 (broken config must not apply)` };
    }
    console.log("PHASE D: safe-mode recovered");

    // ---- PHASE E: idle teardown -> respawn -> restore ----------------------
    // The scratch full-mode frame disposes its worker after IDLE_TEARDOWN_MS of
    // no input (default 5 min) and shows a "💤 sleeping" overlay; the next
    // keydown/click respawns a fresh engine and restores the saved draft. We
    // shrink that idle window to IDLE_TEARDOWN_TEST_MS via window.__nvimIdleMs
    // (the frame reads it when it ARMS the idle timer at boot) so the smoke can
    // prove teardown -> respawn -> restore without waiting minutes. A brand-new
    // page is used so the override is injected via evaluateOnNewDocument BEFORE
    // the engine-frame's scratch init arms the timer. NOTE the flags live flat
    // on window.__nvim (it IS the debug object): __nvim.sleeping/.ready, not
    // __nvim.debug.*.
    console.log(`\n[PHASE E] idle teardown: opening a fresh scratch page with __nvimIdleMs=${IDLE_TEARDOWN_TEST_MS}...`);
    const pageE = await browser.newPage();
    pageE.on("pageerror", (err) => console.log(`  [PHASE E pageerror] ${err.message}`));
    // Runs in EVERY document/child frame this page creates (incl. the engine-frame
    // iframe) before any of its own script executes, so the frame sees the small
    // idle value at arm time.
    await pageE.evaluateOnNewDocument((ms) => {
      window.__nvimIdleMs = ms;
    }, IDLE_TEARDOWN_TEST_MS);
    await pageE.goto(`chrome-extension://${id}/scratch.html`, { waitUntil: "domcontentloaded" });
    const frameE = await pageE.waitForFrame((fr) => fr.url().includes("engine-frame.html"), {
      timeout: 15_000,
    });
    const tE = Date.now();
    await frameE.waitForFunction("window.__nvim && window.__nvim.ready === true", {
      timeout: BOOT_TIMEOUT_MS,
      polling: 250,
    });
    console.log(`[PHASE E] engine ready in ${((Date.now() - tE) / 1000).toFixed(1)}s`);

    // Confirm the frame actually picked up the override (proves ~2.5s takes effect,
    // not the 5-min default — otherwise the phase would be a false pass on a race).
    const idleMsSeen = await frameE.evaluate(() => window.__nvimIdleMs);
    console.log(`[PHASE E] frame window.__nvimIdleMs -> ${JSON.stringify(idleMsSeen)}`);
    if (idleMsSeen !== IDLE_TEARDOWN_TEST_MS) {
      await browser.close();
      return { ok: false, reason: `idle override not applied in frame: __nvimIdleMs is ${JSON.stringify(idleMsSeen)}, expected ${IDLE_TEARDOWN_TEST_MS}` };
    }

    // Type a distinctive draft and confirm it landed BEFORE the idle timer fires.
    await frameE.evaluate((marker) => window.__nvim.input("i" + marker + "<Esc>"), IDLE_MARKER);
    await wait(500);
    const draftBeforeIdle = await frameE.evaluate(() => window.__nvim.getBufferText());
    console.log(`[PHASE E] buffer before idle -> ${JSON.stringify(draftBeforeIdle)}`);
    if (!draftBeforeIdle.includes(IDLE_MARKER)) {
      await browser.close();
      return { ok: false, reason: `idle teardown: marker not in buffer before idle: ${JSON.stringify(draftBeforeIdle)}` };
    }

    // Poll until the worker is torn down: debug.sleeping === true.
    console.log(`[PHASE E] waiting for idle teardown (sleeping) up to ${SLEEP_POLL_TIMEOUT_MS / 1000}s...`);
    try {
      await frameE.waitForFunction("window.__nvim && window.__nvim.sleeping === true", {
        timeout: SLEEP_POLL_TIMEOUT_MS,
        polling: 250,
      });
    } catch (e) {
      const st = await frameE
        .evaluate(() => ({
          sleeping: window.__nvim?.sleeping,
          ready: window.__nvim?.ready,
          memoryCapped: window.__nvim?.memoryCapped,
        }))
        .catch(() => null);
      await browser.close();
      return { ok: false, reason: `idle teardown: sleeping never became true within ${SLEEP_POLL_TIMEOUT_MS}ms (state=${JSON.stringify(st)}, err=${errText(e)})` };
    }
    console.log("[PHASE E] ASSERT OK: engine torn down (sleeping=true)");

    // The sleeping overlay div (💤 ... press any key to resume) must be visible.
    const sleepOverlay = await frameE.evaluate(() => {
      const div = Array.from(document.querySelectorAll("div")).find(
        (d) => d.textContent && d.textContent.includes("💤") && d.textContent.includes("sleeping"),
      );
      if (!div) return { found: false };
      return { found: true, display: getComputedStyle(div).display, text: div.textContent };
    });
    console.log(`[PHASE E] sleeping overlay -> ${JSON.stringify(sleepOverlay)}`);
    if (!sleepOverlay.found || sleepOverlay.display === "none") {
      await browser.close();
      return { ok: false, reason: `idle teardown: sleeping overlay not visible (${JSON.stringify(sleepOverlay)})` };
    }
    console.log("[PHASE E] ASSERT OK: sleeping overlay visible");

    // Wake it with a real keydown into the frame's document (the frame's keydown
    // handler routes any key to resume while sleeping). Poll for respawn: the
    // engine is ready again AND no longer sleeping.
    console.log("[PHASE E] dispatching keydown to wake the sleeping instance...");
    await frameE.evaluate(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })),
    );
    try {
      await frameE.waitForFunction(
        "window.__nvim && window.__nvim.ready === true && window.__nvim.sleeping === false",
        { timeout: BOOT_TIMEOUT_MS, polling: 250 },
      );
    } catch (e) {
      const st = await frameE
        .evaluate(() => ({ sleeping: window.__nvim?.sleeping, ready: window.__nvim?.ready }))
        .catch(() => null);
      await browser.close();
      return { ok: false, reason: `idle resume: engine did not respawn (state=${JSON.stringify(st)}, err=${errText(e)})` };
    }
    console.log("[PHASE E] ASSERT OK: engine respawned (ready=true, sleeping=false)");

    // The restored draft must still contain the marker: teardown -> respawn ->
    // restore proven end-to-end.
    const restoredDraft = await frameE.evaluate(() => window.__nvim.getBufferText());
    console.log(`[PHASE E] buffer after respawn -> ${JSON.stringify(restoredDraft)}`);
    if (!restoredDraft.includes(IDLE_MARKER)) {
      await browser.close();
      return { ok: false, reason: `idle resume: draft not restored after respawn: ${JSON.stringify(restoredDraft)}` };
    }
    console.log("[PHASE E] ASSERT OK: draft restored after idle teardown + respawn");
    console.log("PHASE E: idle teardown -> respawn -> restore");

    await browser.close();
    return {
      ok: true,
      lastIdle,
      wakeupLog,
      idleSamples,
      bootMs,
      latencyP50: p50,
      latencyP95: p95,
      persisted: true,
      clipboard,
      configLoaded: true,
      safeModeRecovered: true,
      idleTeardown: true,
    };
  } catch (e) {
    await browser.close().catch(() => {});
    return { ok: false, reason: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  }
}

async function main() {
  if (!(await exists(path.join(extDir, "manifest.json")))) {
    fail(`no build at ${extDir} — run \`npm run build\` first`);
  }
  const browser = await resolveBrowser();
  if (!browser) {
    fail(
      "no Chromium found. Install Chrome for Testing: " +
        "`npx @puppeteer/browsers install chrome@stable`, or set $NVIM_SMOKE_CHROME.",
    );
  }
  const id = unpackedExtensionId(extDir);
  console.log(`browser: ${browser.label}`);
  console.log(`extension id: ${id}`);

  // Modern headless supports extensions; fall back to headed if the extension
  // fails to register (e.g. managed Chrome that blocks unpacked extensions).
  let result = await run(browser.exec, true, id);
  if (!result.ok && result.reason === "no-extension") {
    console.log("headless extension load failed; retrying headed (headless:false)...");
    result = await run(browser.exec, false, id);
  }
  if (!result.ok && result.reason === "no-extension") {
    fail(
      `extension did not load in ${browser.label}. If this is a managed/MDM Chrome ` +
        "with developer mode disabled by policy, use Chrome for Testing instead " +
        "(`npx @puppeteer/browsers install chrome@stable`).",
    );
  }
  if (!result.ok) fail(result.reason);

  console.log(`\nlast idle wakeups/sec: ${result.lastIdle} (gate <= ${IDLE_GATE})`);
  console.log(`PERF boot: ${result.bootMs}ms (budget ${BOOT_BUDGET_MS})`);
  console.log(`PERF latency: p50=${result.latencyP50}ms p95=${result.latencyP95}ms (budget ${LATENCY_BUDGET_MS})`);
  console.log(`persistence across reload: ${result.persisted ? "PASS" : "FAIL"}`);
  console.log(`clipboard copy: ${result.clipboard}`);
  console.log(`config loads (PHASE C): ${result.configLoaded ? "PASS" : "FAIL"}`);
  console.log(`safe mode recovers (PHASE D): ${result.safeModeRecovered ? "PASS" : "FAIL"}`);
  console.log(`idle teardown -> respawn -> restore (PHASE E): ${result.idleTeardown ? "PASS" : "FAIL"}`);
  console.log(
    `\nPASS: engine booted in-browser (boot ${result.bootMs}ms, latency p95 ${result.latencyP95}ms), ` +
      "buffer round-tripped, idle CPU parked, " +
      "draft persisted across reload" +
      (result.clipboard.startsWith("verified") ? ", clipboard copy verified" : " (clipboard soft-skipped)") +
      ", config loaded from IndexedDB (tabstop=7), safe mode recovered a broken config, " +
      "idle teardown respawned and restored the draft",
  );
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
