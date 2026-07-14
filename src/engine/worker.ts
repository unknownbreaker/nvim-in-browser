// Web Worker shell around the environment-agnostic nvim host (nvim-host.ts).
// It handles the browser-specific edges — fetching assets, gunzip via
// DecompressionStream, and the postMessage protocol — and delegates the actual
// WASI + Asyncify driving to startNvimHost.
//
// postMessage protocol (later tasks depend on these exact shapes):
//   page -> worker: { type: "start", wasmUrl, runtimeUrl } | { type: "stdin", chunk }
//   worker -> page: { type: "ready" } | { type: "stdout", chunk } |
//                   { type: "exit", code } | { type: "fatal", message } |
//                   { type: "stat", wakeupsPerSecond }  (every 5s)
import { startNvimHost, type NvimHost } from "./nvim-host";
import { untar } from "./untar";

interface StartMsg {
  type: "start";
  wasmUrl: string;
  runtimeUrl: string;
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

async function start(msg: StartMsg): Promise<void> {
  try {
    const [wasmBytes, runtimeGz] = await Promise.all([
      fetch(msg.wasmUrl).then((r) => r.arrayBuffer()),
      fetch(msg.runtimeUrl).then((r) => r.arrayBuffer()),
    ]);
    const entries = untar(await gunzip(new Uint8Array(runtimeGz)));
    host = await startNvimHost(new Uint8Array(wasmBytes), entries, {
      onStdout: (chunk) => ctx.postMessage({ type: "stdout", chunk }, [chunk.buffer]),
      onExit: (code) => ctx.postMessage({ type: "exit", code }),
      onFatal: (message) => ctx.postMessage({ type: "fatal", message }),
      onStat: (wakeupsPerSecond) => ctx.postMessage({ type: "stat", wakeupsPerSecond }),
    });
    // nvim has booted and is parked waiting for its first RPC input.
    ctx.postMessage({ type: "ready" });
  } catch (e) {
    ctx.postMessage({
      type: "fatal",
      message: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}
