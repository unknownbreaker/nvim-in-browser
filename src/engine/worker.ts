// Web Worker shell around the environment-agnostic nvim host (nvim-host.ts).
// It handles the browser-specific edges — fetching assets, gunzip via
// DecompressionStream, and the postMessage protocol — and delegates the actual
// WASI + Asyncify driving to startNvimHost.
//
// postMessage protocol (later tasks depend on these exact shapes):
//   page -> worker: { type: "start", wasmUrl, runtimeUrl, argv?, configFiles? } |
//                   { type: "stdin", chunk }
//     - argv?: string[] overrides the default nvim argv (e.g. drop -u NORC to load config)
//     - configFiles?: { path: string; data: Uint8Array }[] written into the WASI FS at boot
//   worker -> page: { type: "ready" } | { type: "stdout", chunk } |
//                   { type: "exit", code } | { type: "fatal", message } |
//                   { type: "stat", wakeupsPerSecond, memoryBytes }  (every 5s)
import { startNvimHost, type NvimHost } from "./nvim-host";
import { loadCachedModule, saveCachedModule } from "./module-cache";
import { untar } from "./untar";

interface StartMsg {
  type: "start";
  wasmUrl: string;
  runtimeUrl: string;
  argv?: string[];
  configFiles?: { path: string; data: Uint8Array }[];
  // Extension version used to key the compiled-module cache. Absent (e.g. Node
  // smoke, which doesn't use this worker) disables caching -> always compile.
  cacheKey?: string;
}
interface StdinMsg {
  type: "stdin";
  chunk: Uint8Array;
}
type InboundMsg = StartMsg | StdinMsg;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let host: NvimHost | null = null;

ctx.onmessage = (ev: MessageEvent<InboundMsg>) => {
  const msg = ev.data;
  if (msg.type === "start") {
    void start(msg);
  } else if (msg.type === "stdin" && host) {
    host.sendStdin(msg.chunk);
  }
};

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The compiled module, from the IndexedDB cache when possible (skips fetching +
// recompiling the ~11 MB wasm — the dominant boot cost); otherwise fetch, compile,
// and cache it for next time. All cache failures fall back to a plain compile.
async function loadModule(wasmUrl: string, cacheKey?: string): Promise<WebAssembly.Module> {
  if (cacheKey) {
    const cached = await loadCachedModule(cacheKey);
    if (cached) return cached;
  }
  const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
  const module = await WebAssembly.compile(new Uint8Array(wasmBytes));
  if (cacheKey) void saveCachedModule(cacheKey, module);
  return module;
}

async function start(msg: StartMsg): Promise<void> {
  try {
    // Runtime tarball is always fetched; the wasm is fetched only on a cache miss.
    const [module, runtimeGz] = await Promise.all([
      loadModule(msg.wasmUrl, msg.cacheKey),
      fetch(msg.runtimeUrl).then((r) => r.arrayBuffer()),
    ]);
    const entries = untar(await gunzip(new Uint8Array(runtimeGz)));
    host = await startNvimHost(
      module,
      entries,
      {
        onStdout: (chunk) => ctx.postMessage({ type: "stdout", chunk }, [chunk.buffer]),
        onExit: (code) => ctx.postMessage({ type: "exit", code }),
        onFatal: (message) => ctx.postMessage({ type: "fatal", message }),
        onStat: (stat) =>
          ctx.postMessage({
            type: "stat",
            wakeupsPerSecond: stat.wakeupsPerSecond,
            memoryBytes: stat.memoryBytes,
          }),
      },
      { argv: msg.argv, configFiles: msg.configFiles },
    );
    // nvim has booted and is parked waiting for its first RPC input.
    ctx.postMessage({ type: "ready" });
  } catch (e) {
    ctx.postMessage({
      type: "fatal",
      message: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}
