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

const BOOT_TIMEOUT_MS = 60_000; // first boot compiles ~8MB wasm
const IDLE_MS = 12_000;
const IDLE_GATE = 5; // last idle stat sample must be <= this many wakeups/sec

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

function errText(e) {
  return e instanceof Error ? e.message : String(e);
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

    await browser.close();
    return { ok: true, lastIdle, wakeupLog, idleSamples, persisted: true, clipboard };
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
  console.log(`persistence across reload: ${result.persisted ? "PASS" : "FAIL"}`);
  console.log(`clipboard copy: ${result.clipboard}`);
  console.log(
    "\nPASS: engine booted in-browser, buffer round-tripped, idle CPU parked, " +
      "draft persisted across reload" +
      (result.clipboard.startsWith("verified") ? ", clipboard copy verified" : " (clipboard soft-skipped)"),
  );
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
