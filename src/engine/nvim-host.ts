// Core engine host: boots real Neovim (wasm32-wasi, Binaryen-asyncified) and
// speaks msgpack-RPC over its stdin/stdout. Environment-agnostic — it takes
// already-decompressed tar entries and raw wasm bytes plus callbacks, so it can
// be driven both from a Web Worker (worker.ts) and from a Node smoke test.
//
// The wasm has ONLY `wasi_snapshot_preview1.poll_oneoff` asyncified. We supply
// our own poll_oneoff that suspends the whole call stack (Asyncify unwind) when
// no subscription is ready, awaits the relevant wake source (stdin arrival or a
// timer), then resumes (Asyncify rewind). This is what keeps idle CPU near zero:
// while nvim is waiting for input we are parked on a Promise, not spinning.
import {
  Directory,
  Fd,
  File,
  PreopenDirectory,
  WASI,
  WASIProcExit,
  wasi,
  type Inode,
} from "@bjorn3/browser_wasi_shim";
import type { TarEntry } from "./untar";

const NVIM_ARGV = ["nvim", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"];
const NVIM_ENV = [
  "HOME=/home",
  "VIMRUNTIME=/runtime",
  "TMPDIR=/tmp",
  "NVIM_LOG_FILE=/tmp/nvim.log",
  "XDG_CONFIG_HOME=/home/.config",
  "XDG_DATA_HOME=/home/.local/share",
  "XDG_STATE_HOME=/home/.local/state",
  "XDG_CACHE_HOME=/home/.cache",
];
// node/browser setTimeout clamps delays > ~2^31 ms (fires immediately instead),
// which would busy-loop. Any longer nvim timer is treated as "effectively never"
// during a session; stdin still breaks the block.
const MAX_TIMER_MS = 2_147_483_647;
// Idle backoff (see waitFor): keep honoring nvim's ~1ms poll for this long after
// the last real stdin/stdout I/O so input bursts process at full speed, then ramp
// the poll interval up exponentially toward the cap while genuinely idle.
const IDLE_GRACE_MS = 250;
const IDLE_BACKOFF_CAP_MS = 1000;

// WASI preview1 ABI struct sizes/offsets (cross-checked against the shim's own
// Subscription/Event readers in wasi_defs.js).
const SUBSCRIPTION_SIZE = 48;
const EVENT_SIZE = 32;

export interface NvimHostCallbacks {
  onStdout(chunk: Uint8Array): void;
  onExit(code: number): void;
  onFatal(message: string): void;
  onStat?(stat: { wakeupsPerSecond: number; memoryBytes: number }): void;
}

export interface NvimHost {
  /** Feed a chunk of RPC bytes to nvim's stdin. Takes ownership of `chunk`. */
  sendStdin(chunk: Uint8Array): void;
  /** Total poll wake-ups since boot (the idle-CPU instrument). */
  wakeups(): number;
  /** Stop the stat timer; call when done with the host. */
  dispose(): void;
}

interface NvimExports {
  memory: WebAssembly.Memory;
  _start(): void;
  asyncify_get_state(): number;
  asyncify_start_unwind(dataPtr: number): void;
  asyncify_stop_unwind(): void;
  asyncify_start_rewind(dataPtr: number): void;
  asyncify_stop_rewind(): void;
  nvim_asyncify_get_data_ptr(): number;
  nvim_asyncify_get_stack_start(): number;
  nvim_asyncify_get_stack_end(): number;
}

interface NormalizedSub {
  userdata: bigint;
  type: number; // wasi.EVENTTYPE_*
  fd: number; // valid for FD_READ/FD_WRITE
  deadlineNs: bigint | null; // absolute monotonic deadline for CLOCK
}

const ASYNCIFY_NORMAL = 0;
const ASYNCIFY_UNWINDING = 1;
const ASYNCIFY_REWINDING = 2;

function nowNs(): bigint {
  return BigInt(Math.round(performance.now() * 1e6));
}

function buildTree(entries: TarEntry[]): Map<string, Inode> {
  const root = new Map<string, Inode>();
  const dirFor = (segments: string[]): Map<string, Inode> => {
    let cur = root;
    for (const seg of segments) {
      const existing = cur.get(seg);
      const dir = existing instanceof Directory ? existing : new Directory(new Map());
      if (dir !== existing) cur.set(seg, dir);
      cur = dir.contents;
    }
    return cur;
  };
  for (const e of entries) {
    const parts = e.path.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length === 0) continue;
    if (e.type === "dir") {
      dirFor(parts);
      continue;
    }
    const parent = dirFor(parts.slice(0, -1));
    parent.set(parts[parts.length - 1], new File(e.data));
  }
  return root;
}

function makeHome(): Directory {
  const home = new Directory(new Map());
  const dirs = [
    [".config"],
    [".cache"],
    [".local"],
    [".local", "share"],
    [".local", "state"],
    [".local", "share", "nvim"],
    [".local", "state", "nvim"],
  ];
  for (const parts of dirs) {
    let cur = home.contents;
    for (const seg of parts) {
      const existing = cur.get(seg);
      const dir = existing instanceof Directory ? existing : new Directory(new Map());
      if (dir !== existing) cur.set(seg, dir);
      cur = dir.contents;
    }
  }
  return home;
}

// WTF-8 byte length of a UTF-16 buffer in wasm memory. libuv imports this from
// env; it is only exercised on certain path operations, but we implement it
// faithfully rather than stubbing so those paths don't silently corrupt.
function wtf8Length(memory: WebAssembly.Memory, ptr: number, len: number): number {
  const dv = new DataView(memory.buffer);
  const unit = (i: number) => dv.getUint16(ptr + i * 2, true);
  const nullTerminated = len < 0;
  let bytes = 0;
  let i = 0;
  while (nullTerminated || i < len) {
    const c = unit(i);
    if (nullTerminated && c === 0) break;
    i++;
    if (c >= 0xd800 && c <= 0xdbff && (nullTerminated || i < len)) {
      const c2 = unit(i);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        bytes += 4;
        continue;
      }
    }
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else bytes += 3; // BMP and lone surrogates (WTF-8)
  }
  return bytes;
}

// Write a config file into the in-memory WASI tree at an absolute path,
// creating any missing parent directories. Mirrors makeHome's dir-walk exactly
// (reuse-or-create Directory per segment), overwriting an existing leaf.
function writeConfigFile(root: Map<string, Inode>, path: string, data: Uint8Array): void {
  if (!path.startsWith("/")) return; // only absolute WASI paths
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return;
  let cur = root;
  for (const seg of parts.slice(0, -1)) {
    const existing = cur.get(seg);
    const dir = existing instanceof Directory ? existing : new Directory(new Map());
    if (dir !== existing) cur.set(seg, dir);
    cur = dir.contents;
  }
  cur.set(parts[parts.length - 1], new File(data));
}

export async function startNvimHost(
  // Either raw wasm bytes (compiled here — the Node smoke path) or an
  // already-compiled module (the worker passes a cached one to skip recompiling).
  wasm: WebAssembly.Module | BufferSource,
  runtimeEntries: TarEntry[],
  cb: NvimHostCallbacks,
  opts?: { argv?: string[]; configFiles?: { path: string; data: Uint8Array }[] },
): Promise<NvimHost> {
  const stdinQueue: Uint8Array[] = [];
  let stdinWaker: (() => void) | null = null;
  let wakeupCount = 0;
  let wasmExports: NvimExports;
  let asyncifyDataPtr = 0;
  let wakePromise: Promise<void> | null = null;
  // Idle-backoff bookkeeping (see waitFor). `lastIoMs` is the timestamp of the
  // last real stdin read / stdout write; `idleTicks` ramps the backoff.
  let lastIoMs = performance.now();
  let idleTicks = 0;

  const view = () => new DataView(wasmExports.memory.buffer);
  const charDevFdstat = (rights: number) => {
    const st = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, wasi.FDFLAGS_NONBLOCK);
    st.fs_rights_base = BigInt(rights);
    return { ret: 0, fdstat: st };
  };

  class StdinFd extends Fd {
    override fd_fdstat_get() {
      return charDevFdstat(wasi.RIGHTS_FD_READ);
    }
    override fd_read(size: number) {
      const head = stdinQueue[0];
      if (head === undefined) return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array(0) };
      lastIoMs = performance.now();
      if (head.length <= size) {
        stdinQueue.shift();
        return { ret: 0, data: head };
      }
      stdinQueue[0] = head.subarray(size);
      return { ret: 0, data: head.subarray(0, size) };
    }
  }

  class StdoutFd extends Fd {
    override fd_fdstat_get() {
      return charDevFdstat(wasi.RIGHTS_FD_WRITE);
    }
    override fd_write(data: Uint8Array) {
      lastIoMs = performance.now();
      cb.onStdout(data.slice());
      return { ret: 0, nwritten: data.byteLength };
    }
  }

  class StderrFd extends Fd {
    override fd_fdstat_get() {
      return charDevFdstat(wasi.RIGHTS_FD_WRITE);
    }
    override fd_write(data: Uint8Array) {
      // nvim diagnostics / log spill — not part of the RPC stream.
      console.warn("[nvim stderr]", new TextDecoder().decode(data));
      return { ret: 0, nwritten: data.byteLength };
    }
  }

  const root = buildTree(runtimeEntries);
  root.set("tmp", new Directory(new Map()));
  root.set("home", makeHome());
  // User config files (if any) land in the tree BEFORE instantiation so nvim's
  // startup sees them. Absent opts.configFiles, the tree is byte-for-byte as before.
  for (const entry of opts?.configFiles ?? []) {
    writeConfigFile(root, entry.path, entry.data);
  }

  const fds: Fd[] = [
    new StdinFd(),
    new StdoutFd(),
    new StderrFd(),
    new PreopenDirectory("/", root),
  ];
  const argv = opts?.argv ?? NVIM_ARGV;
  const wasiInst = new WASI([...argv], [...NVIM_ENV], fds, { debug: false });

  function parseSubs(inPtr: number, nsubs: number): NormalizedSub[] {
    const dv = view();
    const now = nowNs();
    const subs: NormalizedSub[] = [];
    for (let i = 0; i < nsubs; i++) {
      const s = wasi.Subscription.read_bytes(dv, inPtr + i * SUBSCRIPTION_SIZE);
      if (s.eventtype === wasi.EVENTTYPE_CLOCK) {
        const abstime = (s.flags & wasi.SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0;
        const deadline = abstime ? s.timeout : now + s.timeout;
        subs.push({ userdata: s.userdata, type: s.eventtype, fd: -1, deadlineNs: deadline });
      } else {
        // For FD subscriptions the file descriptor sits where the parser reads
        // `clockid` (both at struct offset +16).
        subs.push({ userdata: s.userdata, type: s.eventtype, fd: s.clockid, deadlineNs: null });
      }
    }
    return subs;
  }

  const subReady = (sub: NormalizedSub, now: bigint): boolean => {
    if (sub.type === wasi.EVENTTYPE_CLOCK) return sub.deadlineNs !== null && now >= sub.deadlineNs;
    if (sub.type === wasi.EVENTTYPE_FD_READ) return sub.fd === 0 && stdinQueue.length > 0;
    if (sub.type === wasi.EVENTTYPE_FD_WRITE) return true; // stdout/stderr always writable
    return false;
  };

  function writeEvents(outPtr: number, neventsPtr: number, subs: NormalizedSub[]): number {
    const dv = view();
    const now = nowNs();
    const avail = stdinQueue.reduce((a, c) => a + c.length, 0);
    let n = 0;
    const emit = (sub: NormalizedSub) => {
      const evt = outPtr + n * EVENT_SIZE;
      dv.setBigUint64(evt, sub.userdata, true);
      dv.setUint16(evt + 8, wasi.ERRNO_SUCCESS, true);
      dv.setUint8(evt + 10, sub.type);
      if (sub.type === wasi.EVENTTYPE_FD_READ) {
        dv.setBigUint64(evt + 16, BigInt(avail), true);
        dv.setUint16(evt + 24, 0, true);
      } else if (sub.type === wasi.EVENTTYPE_FD_WRITE) {
        dv.setBigUint64(evt + 16, BigInt(1 << 20), true);
        dv.setUint16(evt + 24, 0, true);
      }
      n++;
    };
    for (const sub of subs) {
      if (subReady(sub, now)) emit(sub);
    }
    // We only resume after a wake source fired, so at least one sub should be
    // ready. Guard the rounding edge: if none matched, fire the earliest clock
    // so poll_oneoff never returns zero events (which would busy-loop nvim).
    if (n === 0 && subs.length > 0) {
      let earliest: NormalizedSub | null = null;
      for (const sub of subs) {
        if (sub.type === wasi.EVENTTYPE_CLOCK && sub.deadlineNs !== null) {
          if (!earliest || sub.deadlineNs < earliest.deadlineNs!) earliest = sub;
        }
      }
      if (earliest) emit(earliest);
    }
    dv.setUint32(neventsPtr, n, true);
    return wasi.ERRNO_SUCCESS;
  }

  function waitFor(subs: NormalizedSub[], now: bigint): Promise<void> {
    let minDelayMs: number | null = null;
    let hasFdSub = false;
    for (const sub of subs) {
      if (sub.type === wasi.EVENTTYPE_CLOCK && sub.deadlineNs !== null) {
        const deltaNs = sub.deadlineNs - now;
        const ms = deltaNs <= 0n ? 0 : Number(deltaNs / 1_000_000n);
        if (minDelayMs === null || ms < minDelayMs) minDelayMs = ms;
      } else if (sub.type === wasi.EVENTTYPE_FD_READ || sub.type === wasi.EVENTTYPE_FD_WRITE) {
        hasFdSub = true;
      }
    }

    // Adaptive idle backoff. This vendored nvim-wasm build reads stdin by
    // busy-polling with a lone ~1ms relative clock (no fd subscription) rather
    // than blocking on an fd_read, so a faithful driver would wake ~1000×/s
    // forever (~700/s measured in Node). But stdin arrival ALWAYS wakes us
    // out-of-band (stdinWaker), and nvim does real work as bursts of stdin reads
    // / stdout writes. So once no real I/O has happened for IDLE_GRACE_MS, nvim
    // is genuinely idle and we stretch this timer-only sleep exponentially up to
    // the cap — deferring only timer-driven work, never RPC latency. Any stdin
    // read or stdout write resets lastIoMs and snaps the interval back to ~1ms,
    // so input bursts (and the ticks that process them) run at full speed. This
    // takes steady-state idle from ~700/s down to ~1/s.
    if (!hasFdSub && minDelayMs !== null && performance.now() - lastIoMs > IDLE_GRACE_MS) {
      idleTicks++;
      const grow = Math.min(idleTicks, 20);
      minDelayMs = Math.min(IDLE_BACKOFF_CAP_MS, Math.max(1, minDelayMs) * 2 ** grow);
    } else {
      idleTicks = 0;
    }

    const waiters: Promise<void>[] = [];
    // stdin can always break the block; writeEvents only emits it if subscribed.
    waiters.push(new Promise<void>((res) => (stdinWaker = res)));
    if (minDelayMs !== null) {
      const clamped = Math.min(minDelayMs, MAX_TIMER_MS);
      waiters.push(new Promise<void>((res) => setTimeout(res, clamped)));
    }
    return Promise.race(waiters);
  }

  function pollOneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number): number {
    if (wasmExports.asyncify_get_state() === ASYNCIFY_REWINDING) {
      // Resuming from a suspend: stop the rewind, then report ready events.
      wasmExports.asyncify_stop_rewind();
      wakeupCount++;
      return writeEvents(outPtr, neventsPtr, parseSubs(inPtr, nsubs));
    }
    if (nsubs === 0) {
      view().setUint32(neventsPtr, 0, true);
      return wasi.ERRNO_SUCCESS;
    }
    const subs = parseSubs(inPtr, nsubs);
    const now = nowNs();
    if (subs.some((s) => subReady(s, now))) {
      return writeEvents(outPtr, neventsPtr, subs);
    }
    // Nothing ready — suspend the entire call stack until a wake source fires.
    wakePromise = waitFor(subs, now);
    wasmExports.asyncify_start_unwind(asyncifyDataPtr);
    return wasi.ERRNO_SUCCESS;
  }

  const wasiImport: Record<string, (...args: number[]) => unknown> = {
    ...wasiInst.wasiImport,
    poll_oneoff: pollOneoff,
  };
  const envImport = {
    flock: (_fd: number, _op: number) => 0,
    getpid: () => 42,
    clock: () => 0,
    uv_utf16_length_as_wtf8: (ptr: number, len: number) =>
      wtf8Length(wasmExports.memory, ptr, len),
  };

  const module =
    wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasiImport as WebAssembly.ModuleImports,
    env: envImport as unknown as WebAssembly.ModuleImports,
  });
  wasmExports = instance.exports as unknown as NvimExports;
  wasiInst.inst = instance as unknown as typeof wasiInst.inst;

  // Initialize the Asyncify data descriptor: [current, end] i32 pair pointing at
  // the wasm's built-in reserved stack region (no memory.grow needed).
  asyncifyDataPtr = wasmExports.nvim_asyncify_get_data_ptr();
  const dv = view();
  dv.setUint32(asyncifyDataPtr, wasmExports.nvim_asyncify_get_stack_start(), true);
  dv.setUint32(asyncifyDataPtr + 4, wasmExports.nvim_asyncify_get_stack_end(), true);

  let lastStatWakeups = 0;
  const statTimer = setInterval(() => {
    const delta = wakeupCount - lastStatWakeups;
    lastStatWakeups = wakeupCount;
    cb.onStat?.({ wakeupsPerSecond: delta / 5, memoryBytes: wasmExports.memory.buffer.byteLength });
  }, 5000);

  const cleanup = () => clearInterval(statTimer);

  async function drive(): Promise<void> {
    try {
      wasmExports._start();
      while (wasmExports.asyncify_get_state() === ASYNCIFY_UNWINDING) {
        wasmExports.asyncify_stop_unwind();
        await wakePromise;
        wasmExports.asyncify_start_rewind(asyncifyDataPtr);
        wasmExports._start();
      }
      cleanup();
      cb.onExit(0);
    } catch (e) {
      cleanup();
      if (e instanceof WASIProcExit) cb.onExit(e.code);
      else cb.onFatal(e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
    void ASYNCIFY_NORMAL; // state constant kept for documentation/symmetry
  }

  const handle: NvimHost = {
    sendStdin(chunk: Uint8Array) {
      stdinQueue.push(chunk);
      const wake = stdinWaker;
      stdinWaker = null;
      wake?.();
    },
    wakeups: () => wakeupCount,
    dispose: cleanup,
  };

  // Kick off the driver: the first _start() runs nvim's init synchronously up to
  // its first poll (waiting for RPC input), then parks on wakePromise.
  void drive();
  return handle;
}
