// Shared Chrome launch + extension-load plumbing for the puppeteer-core
// smoke scripts. Consumed by: scripts/browser-smoke.mjs, scripts/overlay-smoke.mjs.
//
// Hoisted verbatim from those two scripts, which carried byte-identical
// copies of every helper below (verified by diff before extraction; only
// their surrounding comments differed). `root`/`extDir` are not hardcoded
// here since the two callers derive them differently — pass what's needed as
// arguments.
//
// Browser resolution order (first that exists wins):
//   1. $NVIM_SMOKE_CHROME               — explicit override
//   2. Chrome for Testing under <root>/chrome — installed via
//        `npx @puppeteer/browsers install chrome@stable`
//   3. system Google Chrome             — /Applications/Google Chrome.app
//
// NOTE: a managed/MDM-enrolled system Chrome may refuse to load unpacked
// extensions ("Developer mode is managed by your administrator"), which the
// --load-extension feature flag cannot override. On such machines install
// Chrome for Testing (step 2) — it is a vanilla Chromium not subject to the
// com.google.Chrome cloud policy. That is why this repo prefers it.
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Locate a Chrome-for-Testing binary under <root>/chrome (as laid down by
// @puppeteer/browsers). Returns the first macOS/Linux/Windows binary found.
export async function findChromeForTesting(root) {
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

export async function resolveBrowser(root) {
  const env = process.env.NVIM_SMOKE_CHROME;
  if (env) return { exec: env, label: `env NVIM_SMOKE_CHROME` };
  const cft = await findChromeForTesting(root);
  if (cft) return { exec: cft, label: "Chrome for Testing (./chrome)" };
  if (await exists(SYSTEM_CHROME)) return { exec: SYSTEM_CHROME, label: "system Google Chrome" };
  return null;
}

// Chrome derives an unpacked extension's ID from the SHA-256 of its absolute
// path: first 16 bytes, each hex nibble mapped 0-15 -> 'a'-'p'. Computing it
// avoids depending on the (lazy) background service-worker target.
export function unpackedExtensionId(dir) {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  let id = "";
  for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

export async function launch(exec, headless, extDir) {
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
export async function extensionLoaded(browser, id) {
  const swTarget = await browser
    .waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${id}/`),
      { timeout: 8_000 },
    )
    .catch(() => null);
  return Boolean(swTarget);
}

// Try headless first; if the extension never registered ("no-extension"),
// retry once headed — some managed/MDM Chrome configurations silently drop
// unpacked extensions under headless but allow them headed. This is the
// "headless launch -> retry headed" block that lived near the end of each
// script's main flow. It returns the final result and leaves what to do with
// a still-failing result to the caller, since browser-smoke exits immediately
// on failure while overlay-smoke must throw so its `finally` can restore the
// production build first.
export async function runWithHeadlessRetry(runFn) {
  let result = await runFn(true);
  if (!result.ok && result.reason === "no-extension") {
    console.log("headless extension load failed; retrying headed (headless:false)...");
    result = await runFn(false);
  }
  return result;
}
