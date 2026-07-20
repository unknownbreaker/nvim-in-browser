// firefox-smoke.mjs — automated Firefox install gate for the MV3 build.
//
// Runs `web-ext run` against dist/firefox under headless Firefox and asserts the
// extension installs cleanly (web-ext logs "Installed <dir> as a temporary
// add-on"). A clean install means Firefox accepted the transformed manifest —
// the event-page background AND the world:"MAIN" content script — with no
// manifest rejection. Then it tears down web-ext + Firefox and reports PASS.
//
// This is the required Firefox gate. It does NOT drive the extension (no wasm
// boot / overlay / T1 check) — that behavioral parity should be spot-checked
// manually or covered by a later Firefox behavioral smoke.
//
// Usage: node scripts/firefox-smoke.mjs
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, "dist", "firefox");

// Firefox Developer Edition (the `deved` alias's target). web-ext also accepts
// "firefox" / "deved" via its own resolver, but a login-shell alias is not
// visible to a spawned process, so pass the concrete binary path.
const FIREFOX_BIN =
  process.env.FIREFOX_BIN ||
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";

const INSTALL_MARKERS = ["Installed", "as a temporary add-on"];
const TIMEOUT_MS = 90_000;

function fail(message) {
  console.error(`smoke:firefox FAIL — ${message}`);
  process.exitCode = 1;
}

async function main() {
  try {
    await access(path.join(sourceDir, "manifest.json"));
  } catch {
    fail(`no dist/firefox/manifest.json — run \`npm run build\` first`);
    return;
  }
  try {
    await access(FIREFOX_BIN);
  } catch {
    fail(`Firefox binary not found at ${FIREFOX_BIN} (set FIREFOX_BIN to override)`);
    return;
  }

  const child = spawn(
    "web-ext",
    [
      "run",
      "--source-dir",
      sourceDir,
      "--firefox",
      FIREFOX_BIN,
      "--no-input",
      "--no-reload",
      "--start-url",
      "about:blank",
    ],
    { env: { ...process.env, MOZ_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  let settled = false;

  const cleanup = () => {
    // web-ext launches Firefox in a SEPARATE process tree (its own temp
    // profile). SIGINT lets web-ext gracefully close that Firefox; a plain
    // SIGTERM to the node process would orphan it. Follow up by sweeping both
    // the web-ext runner and any temp-profile Firefox it spawned.
    try {
      child.kill("SIGINT");
    } catch {}
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      try {
        spawn("pkill", ["-f", "web-ext run"], { stdio: "ignore" });
      } catch {}
      // web-ext's throwaway profiles are named `firefox-profile<random>`; this
      // pattern matches ONLY web-ext-launched Firefox, never the user's real
      // browser (which runs on a named profile like dev-edition-default).
      try {
        spawn("pkill", ["-f", "firefox-profile"], { stdio: "ignore" });
      } catch {}
    }, 1500);
  };

  const finish = (ok, message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
    if (ok) {
      console.log("smoke:firefox PASS — extension installed in Firefox as a temporary add-on");
      console.log("--- web-ext install line ---");
      for (const line of output.split("\n")) {
        if (line.includes("Installed") && line.includes("temporary add-on")) {
          console.log(line.trim());
        }
      }
    } else {
      fail(message);
      console.error("--- web-ext output (tail) ---");
      console.error(output.split("\n").slice(-40).join("\n"));
    }
  };

  const timer = setTimeout(() => {
    finish(false, `timed out after ${TIMEOUT_MS}ms without an install line`);
  }, TIMEOUT_MS);

  const onData = (buf) => {
    output += buf.toString();
    if (INSTALL_MARKERS.every((m) => output.includes(m))) {
      finish(true);
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("error", (err) => {
    finish(false, `failed to spawn web-ext: ${err.message}`);
  });

  child.on("exit", (code) => {
    // If web-ext exited before we saw the install markers, it's a failure.
    if (!settled) {
      finish(false, `web-ext exited (code ${code}) before installing the add-on`);
    }
  });
}

main();
