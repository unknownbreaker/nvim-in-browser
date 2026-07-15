// Throwaway-but-useful Node smoke test for the engine core (src/engine/*.ts).
//
// It replicates worker.ts's boot path without a browser: gunzip (node:zlib) +
// untar + startNvimHost (the real WASI + Asyncify driver), then drives real
// Neovim over msgpack-RPC — ui_attach, input "ihello<Esc>", buf_get_lines — and
// asserts the buffer contains "hello". It also samples poll wake-ups over a
// short idle window to sanity-check the idle-CPU gate.
//
// Run: node scripts/smoke-nvim.mjs [idleSeconds]
//
// The engine modules are TypeScript, so we bundle them with esbuild (already a
// dependency) into a temp ESM file and import it — fully offline, no tsx needed.
import { build } from "esbuild";
import { readFile, writeFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IDLE_SECONDS = Number(process.argv[2] ?? 10);

const wasmPath = process.env.NVIM_WASM_PATH ?? path.join(root, "vendor", "nvim-wasm", "nvim-asyncify.wasm");
const runtimePath = process.env.NVIM_RUNTIME_PATH ?? path.join(root, "vendor", "nvim-wasm", "nvim-runtime.tar.gz");

function fail(msg) {
  console.error("SMOKE FAIL:", msg);
  process.exit(1);
}

async function bundleEngine() {
  const result = await build({
    stdin: {
      contents: [
        'export { startNvimHost } from "./src/engine/nvim-host.ts";',
        'export { untar } from "./src/engine/untar.ts";',
        'export { NvimRpc } from "./src/engine/rpc.ts";',
      ].join("\n"),
      resolveDir: root,
      sourcefile: "smoke-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const out = path.join(tmpdir(), `smoke-engine-${process.pid}.mjs`);
  await writeFile(out, result.outputFiles[0].text);
  return out;
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
  console.log(`Using WASM path: ${wasmPath}`);
  console.log(`Using runtime path: ${runtimePath}`);

  const bundlePath = await bundleEngine();
  const { startNvimHost, untar, NvimRpc } = await import(pathToFileURL(bundlePath).href);
  await rm(bundlePath, { force: true });

  const wasmBytes = new Uint8Array(await readFile(wasmPath));
  const runtimeEntries = untar(new Uint8Array(gunzipSync(await readFile(runtimePath))));
  console.log(`loaded wasm (${wasmBytes.length} bytes), ${runtimeEntries.length} runtime entries`);

  const statSamples = [];
  let fatal = null;
  let exited = null;
  let host = null;

  const rpc = new NvimRpc((bytes) => host.sendStdin(bytes.slice()));
  rpc.onNotification = () => {}; // redraw etc. — ignore

  host = await startNvimHost(wasmBytes, runtimeEntries, {
    onStdout: (chunk) => rpc.feed(chunk),
    onExit: (code) => (exited = code),
    onFatal: (message) => (fatal = message),
    onStat: (wakeupsPerSecond) => statSamples.push(wakeupsPerSecond),
  });

  console.log("nvim booted; sending RPC...");

  const withTimeout = (p, ms, what) =>
    Promise.race([
      p,
      wait(ms).then(() => {
        throw new Error(`timeout after ${ms}ms waiting for ${what}` + (fatal ? ` (fatal: ${fatal})` : ""));
      }),
    ]);

  // 1. ui_attach — establishes the UI so nvim processes input into a grid.
  const attach = await withTimeout(
    rpc.request("nvim_ui_attach", [80, 24, { ext_linegrid: true, rgb: true }]),
    8000,
    "nvim_ui_attach",
  );
  console.log("ui_attach ->", JSON.stringify(attach));

  // 2. Type into the buffer: enter insert mode, type hello, leave insert.
  await withTimeout(rpc.request("nvim_input", ["ihello"]), 8000, "nvim_input(ihello)");
  await withTimeout(rpc.request("nvim_input", ["<Esc>"]), 8000, "nvim_input(Esc)");

  // Give nvim a beat to apply the edit, then read the buffer back.
  await wait(200);
  const lines = await withTimeout(
    rpc.request("nvim_buf_get_lines", [0, 0, -1, false]),
    8000,
    "nvim_buf_get_lines",
  );
  const decoded = lines.map((l) => (l instanceof Uint8Array ? new TextDecoder().decode(l) : l));
  console.log("buffer lines ->", JSON.stringify(decoded));

  if (fatal) fail(`host reported fatal: ${fatal}`);
  if (!decoded.some((l) => typeof l === "string" && l.includes("hello"))) {
    fail(`buffer did not contain "hello": ${JSON.stringify(decoded)}`);
  }
  console.log('ASSERT OK: buffer contains "hello"');

  // 3. Idle window: nvim should park on poll_oneoff, not spin.
  const wakeupsBefore = host.wakeups();
  console.log(`\nidling ${IDLE_SECONDS}s to measure poll wake-ups...`);
  await wait(IDLE_SECONDS * 1000);
  const wakeupsDuringIdle = host.wakeups() - wakeupsBefore;
  const perSecond = wakeupsDuringIdle / IDLE_SECONDS;
  console.log(`idle wake-ups: ${wakeupsDuringIdle} over ${IDLE_SECONDS}s = ${perSecond.toFixed(2)}/s`);
  console.log(`stat samples (wakeups/s, every 5s): ${JSON.stringify(statSamples)}`);
  console.log(`total wake-ups since boot: ${host.wakeups()}`);

  if (exited !== null) fail(`nvim exited unexpectedly during idle (code ${exited})`);

  // Hard assert the idle-CPU gate: a healthy backed-off nvim parks on
  // poll_oneoff and wakes only a handful of times per second. Prefer the final
  // 5s stat sample; fall back to the measured average if the idle window was
  // too short to emit one.
  const IDLE_WAKEUP_LIMIT = 5;
  const finalSample = statSamples.length > 0 ? statSamples[statSamples.length - 1] : perSecond;
  if (finalSample > IDLE_WAKEUP_LIMIT) {
    fail(`idle wake-ups too high: final sample ${finalSample.toFixed(2)}/s > ${IDLE_WAKEUP_LIMIT}/s`);
  }
  console.log(`ASSERT OK: idle wake-ups ${finalSample.toFixed(2)}/s <= ${IDLE_WAKEUP_LIMIT}/s`);

  // 4. Responsiveness after idle: typing must still work promptly once nvim has
  // been sitting in the backed-off idle state (guards the idle optimization).
  const t0 = Date.now();
  const lap = (label) => console.log(`  [${Date.now() - t0}ms] ${label}`);
  await withTimeout(rpc.request("nvim_input", ["oworld"]), 8000, "post-idle nvim_input");
  lap("input(oworld) responded");
  await withTimeout(rpc.request("nvim_input", ["<Esc>"]), 8000, "post-idle Esc");
  lap("input(Esc) responded");
  await wait(200);
  const lines2 = await withTimeout(
    rpc.request("nvim_buf_get_lines", [0, 0, -1, false]),
    8000,
    "post-idle nvim_buf_get_lines",
  );
  const decoded2 = lines2.map((l) => (l instanceof Uint8Array ? new TextDecoder().decode(l) : l));
  console.log(`post-idle edit (${Date.now() - t0}ms) -> ${JSON.stringify(decoded2)}`);
  if (!decoded2.some((l) => typeof l === "string" && l.includes("world"))) {
    fail(`post-idle edit did not take effect: ${JSON.stringify(decoded2)}`);
  }
  console.log('ASSERT OK: buffer contains "world" after idle');

  host.dispose();
  console.log("\nSMOKE PASS");
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
