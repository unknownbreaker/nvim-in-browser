// Page-side driver for the nvim engine worker. Spins up the module worker,
// frames msgpack-RPC over its stdin/stdout postMessage protocol, and exposes a
// small surface for attaching a UI, sending input, and issuing RPC requests.
//
// Runs in an extension page context (DOM + chrome.* available). It deliberately
// does not touch chrome.* itself — callers pass fully-resolved URLs — so it can
// also be exercised from plain page/test contexts.
//
// Worker protocol note: stdin sent before the worker emits "ready" is silently
// dropped, so `start()` defers nvim_ui_attach until the ready message arrives.
import { NvimRpc } from "./rpc";

export class NvimClient {
  onRedraw: (batch: unknown[]) => void = () => {};
  onExit: (code: number) => void = () => {};
  // Fired for a worker fatal that arrives AFTER start() has resolved. A pre-ready
  // fatal still rejects the start() promise; this covers the post-ready case,
  // where rejecting a settled promise would be a silent no-op.
  onFatal: (message: string) => void = () => {};
  onStat: (stat: { wakeupsPerSecond: number; memoryBytes: number }) => void = () => {};
  // Pass-through for non-redraw notifications (e.g. custom rpcnotify events like
  // `wasm_text_changed`). Redraw batches go to onRedraw and never reach here.
  onEvent: (method: string, args: unknown[]) => void = () => {};

  private readonly worker: Worker;
  private readonly rpc: NvimRpc;

  constructor(
    workerUrl: string,
    private readonly wasmUrl: string,
    private readonly runtimeUrl: string,
    // Keys the worker's compiled-module cache (the extension version). Optional
    // so non-extension callers can omit it (caching is then disabled).
    private readonly cacheKey?: string,
  ) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.rpc = new NvimRpc((bytes) => {
      const copy = bytes.slice();
      this.worker.postMessage({ type: "stdin", chunk: copy }, [copy.buffer]);
    });
    this.rpc.onNotification = (method, args) => {
      if (method === "redraw") this.onRedraw(args);
      else this.onEvent(method, args);
    };
  }

  start(
    cols: number,
    rows: number,
    opts?: { argv?: string[]; configFiles?: { path: string; data: Uint8Array }[] },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m.type === "ready") {
          void this.rpc
            .request("nvim_ui_attach", [cols, rows, { rgb: true, ext_linegrid: true }])
            .then(
              () => {
                settled = true;
                resolve();
              },
              (err) => {
                settled = true;
                reject(err);
              },
            );
        } else if (m.type === "stdout") {
          this.rpc.feed(m.chunk);
        } else if (m.type === "exit") {
          this.onExit(m.code);
        } else if (m.type === "fatal") {
          // Pre-ready: reject the start() promise. Post-ready: the promise is
          // already settled, so route to onFatal instead of no-op rejecting.
          if (settled) this.onFatal(m.message);
          else {
            settled = true;
            reject(new Error(m.message));
          }
        } else if (m.type === "stat") {
          this.onStat({ wakeupsPerSecond: m.wakeupsPerSecond, memoryBytes: m.memoryBytes });
        }
      };
      // configFiles data arrays are small; structured-clone copies them (no
      // transfer list) so the caller may keep/reuse the buffers afterward.
      this.worker.postMessage({
        type: "start",
        wasmUrl: this.wasmUrl,
        runtimeUrl: this.runtimeUrl,
        argv: opts?.argv,
        configFiles: opts?.configFiles,
        cacheKey: this.cacheKey,
      });
    });
  }

  input(keys: string): void {
    this.rpc.notify("nvim_input", [keys]);
  }

  // Resize the attached UI grid to `cols`x`rows` cells. Sent as a notification
  // (like input): nvim responds by emitting `grid_resize` redraw events, which
  // the renderer applies. Safe to call repeatedly; callers should debounce.
  resize(cols: number, rows: number): void {
    this.rpc.notify("nvim_ui_try_resize", [cols, rows]);
  }

  request(method: string, params: unknown[]): Promise<unknown> {
    return this.rpc.request(method, params);
  }

  dispose(): void {
    this.worker.terminate();
  }
}
