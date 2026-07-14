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
  onStat: (wps: number) => void = () => {};
  // Pass-through for non-redraw notifications (e.g. custom rpcnotify events like
  // `wasm_text_changed`). Redraw batches go to onRedraw and never reach here.
  onEvent: (method: string, args: unknown[]) => void = () => {};

  private readonly worker: Worker;
  private readonly rpc: NvimRpc;

  constructor(
    workerUrl: string,
    private readonly wasmUrl: string,
    private readonly runtimeUrl: string,
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

  start(cols: number, rows: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m.type === "ready") {
          void this.rpc
            .request("nvim_ui_attach", [cols, rows, { rgb: true, ext_linegrid: true }])
            .then(() => resolve(), reject);
        } else if (m.type === "stdout") {
          this.rpc.feed(m.chunk);
        } else if (m.type === "exit") {
          this.onExit(m.code);
        } else if (m.type === "fatal") {
          reject(new Error(m.message));
        } else if (m.type === "stat") {
          this.onStat(m.wakeupsPerSecond);
        }
      };
      this.worker.postMessage({ type: "start", wasmUrl: this.wasmUrl, runtimeUrl: this.runtimeUrl });
    });
  }

  input(keys: string): void {
    this.rpc.notify("nvim_input", [keys]);
  }

  request(method: string, params: unknown[]): Promise<unknown> {
    return this.rpc.request(method, params);
  }

  dispose(): void {
    this.worker.terminate();
  }
}
