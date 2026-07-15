#!/usr/bin/env node
// Parity gate for the nvim-wasm-prototype clean-room build.
//
// Boots our real Neovim (wasm32-wasi, Binaryen-asyncified) headless under
// `--embed`, drives it over msgpack-RPC, and runs a set of named parity
// checks that assert observable behaviours the prototype must match a native
// nvim on (e.g. `v:progpath` being populated). Prints a PASS/FAIL line per
// check plus a final `PARITY PASS`/`PARITY FAIL`, and exits nonzero on any
// failure so it can gate CI.
//
//   Usage: node test/parity-check.mjs <wasm> <runtime-tarball>
//
// STANDALONE by design: this harness imports NOTHING from the parent repo's
// engine (src/engine/*). It mirrors the parent host's WASI + Asyncify boot
// arrangement (see scripts/smoke-nvim.mjs / src/engine/nvim-host.ts) but
// re-implements the small amount it needs inline, so the prototype stays a
// self-contained artifact. The only third-party imports are
// @bjorn3/browser_wasi_shim (the WASI substrate) and @msgpack/msgpack (RPC
// framing) — both resolve from the parent repo's node_modules via normal
// upward module resolution, regardless of cwd.
//
// Checks are declared in the CHECKS array as { name, fn(rpc) }. `fn` returns
// { ok: boolean, detail: string } (or throws). Later tasks append entries to
// CHECKS; the runner runs whatever checks exist.

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  Directory,
  Fd,
  File,
  PreopenDirectory,
  WASI,
  WASIProcExit,
  wasi,
} from "@bjorn3/browser_wasi_shim";
import { Decoder, encode } from "@msgpack/msgpack";

// ---------------------------------------------------------------------------
// Boot configuration — mirrors the parent host (src/engine/nvim-host.ts).
// ---------------------------------------------------------------------------

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

const MAX_TIMER_MS = 2_147_483_647;
const IDLE_GRACE_MS = 250;
const IDLE_BACKOFF_CAP_MS = 1000;
const SUBSCRIPTION_SIZE = 48;
const EVENT_SIZE = 32;
const ASYNCIFY_UNWINDING = 1;
const ASYNCIFY_REWINDING = 2;

const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Minimal ustar reader. The runtime tarball is produced by
// scripts/package-runtime.sh with `tar --format=ustar` (plain ustar, no
// pax/GNU records), so a 512-byte-header walk is sufficient. Mirrors the
// parent's untar.ts TarEntry shape { path, type, data } without importing it.
// ---------------------------------------------------------------------------

function field(bytes, off, len) {
  return dec.decode(bytes.subarray(off, off + len)).replace(/\0.*$/, "");
}
function octal(bytes, off, len) {
  return parseInt(field(bytes, off, len).trim() || "0", 8);
}
function untar(bytes) {
  const out = [];
  let pos = 0;
  while (pos + 512 <= bytes.length) {
    const header = bytes.subarray(pos, pos + 512);
    if (header.every((x) => x === 0)) break; // two zero blocks terminate
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const fullPath = prefix ? `${prefix}/${name}` : name;
    pos += 512;
    const dataEnd = pos + size;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      out.push({ path: fullPath, type: "file", data: bytes.slice(pos, dataEnd) });
    } else if (typeflag === "5") {
      out.push({ path: fullPath, type: "dir", data: new Uint8Array(0) });
    }
    pos += Math.ceil(size / 512) * 512;
  }
  return out;
}

function buildTree(entries) {
  const root = new Map();
  const dirFor = (segments) => {
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

function makeHome() {
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

// WTF-8 byte length of a UTF-16 buffer in wasm memory (libuv imports this).
function wtf8Length(memory, ptr, len) {
  const dv = new DataView(memory.buffer);
  const unit = (i) => dv.getUint16(ptr + i * 2, true);
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
    else bytes += 3;
  }
  return bytes;
}

function nowNs() {
  return BigInt(Math.round(performance.now() * 1e6));
}

// ---------------------------------------------------------------------------
// The nvim host: WASI + Asyncify poll_oneoff driver. Faithful port of the
// parent host's driver, trimmed to what the parity harness needs.
// ---------------------------------------------------------------------------

async function startNvimHost(wasmBytes, runtimeEntries, cb) {
  const stdinQueue = [];
  let stdinWaker = null;
  let wasmExports;
  let asyncifyDataPtr = 0;
  let wakePromise = null;
  let lastIoMs = performance.now();
  let idleTicks = 0;

  const view = () => new DataView(wasmExports.memory.buffer);
  const charDevFdstat = (rights) => {
    const st = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, wasi.FDFLAGS_NONBLOCK);
    st.fs_rights_base = BigInt(rights);
    return { ret: 0, fdstat: st };
  };

  class StdinFd extends Fd {
    fd_fdstat_get() {
      return charDevFdstat(wasi.RIGHTS_FD_READ);
    }
    fd_read(size) {
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
    fd_fdstat_get() {
      return charDevFdstat(wasi.RIGHTS_FD_WRITE);
    }
    fd_write(data) {
      lastIoMs = performance.now();
      cb.onStdout(data.slice());
      return { ret: 0, nwritten: data.byteLength };
    }
  }

  class StderrFd extends Fd {
    fd_fdstat_get() {
      return charDevFdstat(wasi.RIGHTS_FD_WRITE);
    }
    fd_write(data) {
      console.warn("[nvim stderr]", dec.decode(data));
      return { ret: 0, nwritten: data.byteLength };
    }
  }

  const root = buildTree(runtimeEntries);
  root.set("tmp", new Directory(new Map()));
  root.set("home", makeHome());

  const fds = [new StdinFd(), new StdoutFd(), new StderrFd(), new PreopenDirectory("/", root)];
  const wasiInst = new WASI([...NVIM_ARGV], [...NVIM_ENV], fds, { debug: false });

  function parseSubs(inPtr, nsubs) {
    const dv = view();
    const now = nowNs();
    const subs = [];
    for (let i = 0; i < nsubs; i++) {
      const s = wasi.Subscription.read_bytes(dv, inPtr + i * SUBSCRIPTION_SIZE);
      if (s.eventtype === wasi.EVENTTYPE_CLOCK) {
        const abstime = (s.flags & wasi.SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0;
        const deadline = abstime ? s.timeout : now + s.timeout;
        subs.push({ userdata: s.userdata, type: s.eventtype, fd: -1, deadlineNs: deadline });
      } else {
        subs.push({ userdata: s.userdata, type: s.eventtype, fd: s.clockid, deadlineNs: null });
      }
    }
    return subs;
  }

  const subReady = (sub, now) => {
    if (sub.type === wasi.EVENTTYPE_CLOCK) return sub.deadlineNs !== null && now >= sub.deadlineNs;
    if (sub.type === wasi.EVENTTYPE_FD_READ) return sub.fd === 0 && stdinQueue.length > 0;
    if (sub.type === wasi.EVENTTYPE_FD_WRITE) return true;
    return false;
  };

  function writeEvents(outPtr, neventsPtr, subs) {
    const dv = view();
    const now = nowNs();
    const avail = stdinQueue.reduce((a, c) => a + c.length, 0);
    let n = 0;
    const emit = (sub) => {
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
    for (const sub of subs) if (subReady(sub, now)) emit(sub);
    if (n === 0 && subs.length > 0) {
      let earliest = null;
      for (const sub of subs) {
        if (sub.type === wasi.EVENTTYPE_CLOCK && sub.deadlineNs !== null) {
          if (!earliest || sub.deadlineNs < earliest.deadlineNs) earliest = sub;
        }
      }
      if (earliest) emit(earliest);
    }
    dv.setUint32(neventsPtr, n, true);
    return wasi.ERRNO_SUCCESS;
  }

  function waitFor(subs, now) {
    let minDelayMs = null;
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

    if (!hasFdSub && minDelayMs !== null && performance.now() - lastIoMs > IDLE_GRACE_MS) {
      idleTicks++;
      const grow = Math.min(idleTicks, 20);
      minDelayMs = Math.min(IDLE_BACKOFF_CAP_MS, Math.max(1, minDelayMs) * 2 ** grow);
    } else {
      idleTicks = 0;
    }

    const waiters = [];
    waiters.push(new Promise((res) => (stdinWaker = res)));
    if (minDelayMs !== null) {
      const clamped = Math.min(minDelayMs, MAX_TIMER_MS);
      waiters.push(new Promise((res) => setTimeout(res, clamped)));
    }
    return Promise.race(waiters);
  }

  function pollOneoff(inPtr, outPtr, nsubs, neventsPtr) {
    if (wasmExports.asyncify_get_state() === ASYNCIFY_REWINDING) {
      wasmExports.asyncify_stop_rewind();
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
    wakePromise = waitFor(subs, now);
    wasmExports.asyncify_start_unwind(asyncifyDataPtr);
    return wasi.ERRNO_SUCCESS;
  }

  const wasiImport = { ...wasiInst.wasiImport, poll_oneoff: pollOneoff };
  const envImport = {
    flock: () => 0,
    getpid: () => 42,
    clock: () => 0,
    uv_utf16_length_as_wtf8: (ptr, len) => wtf8Length(wasmExports.memory, ptr, len),
  };

  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasiImport,
    env: envImport,
  });
  wasmExports = instance.exports;
  wasiInst.inst = instance;

  asyncifyDataPtr = wasmExports.nvim_asyncify_get_data_ptr();
  const dv = view();
  dv.setUint32(asyncifyDataPtr, wasmExports.nvim_asyncify_get_stack_start(), true);
  dv.setUint32(asyncifyDataPtr + 4, wasmExports.nvim_asyncify_get_stack_end(), true);

  async function drive() {
    try {
      wasmExports._start();
      while (wasmExports.asyncify_get_state() === ASYNCIFY_UNWINDING) {
        wasmExports.asyncify_stop_unwind();
        await wakePromise;
        wasmExports.asyncify_start_rewind(asyncifyDataPtr);
        wasmExports._start();
      }
      cb.onExit(0);
    } catch (e) {
      if (e instanceof WASIProcExit) cb.onExit(e.code);
      else cb.onFatal(e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
  }

  const handle = {
    sendStdin(chunk) {
      stdinQueue.push(chunk);
      const wake = stdinWaker;
      stdinWaker = null;
      wake?.();
    },
  };

  void drive();
  return handle;
}

// ---------------------------------------------------------------------------
// Minimal msgpack-RPC framing (nvim --embed speaks msgpack-RPC over stdio).
// Self-contained port of the parent's rpc.ts.
// ---------------------------------------------------------------------------

class NvimRpc {
  onNotification = () => {};

  constructor(send) {
    this.send = send;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = new Uint8Array(0);
    this.decoder = new Decoder();
  }

  request(method, params) {
    const id = this.nextId++;
    this.send(encode([0, id, method, params]));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  feed(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : concatBytes(this.buffer, chunk);
    let consumed = 0;
    try {
      for (const msg of this.decoder.decodeMulti(this.buffer)) {
        consumed = this.decoder.pos;
        this.dispatch(msg);
      }
      this.buffer = new Uint8Array(0);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      this.buffer = this.buffer.subarray(consumed);
    }
  }

  dispatch(msg) {
    const arr = msg;
    if (arr[0] === 1) {
      const [, id, err, result] = arr;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (err) p.reject(new Error(String(err[1] ?? err)));
      else p.resolve(result);
    } else if (arr[0] === 2) {
      this.onNotification(arr[1], arr[2]);
    }
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// Coerce an nvim RPC string result (which may arrive as msgpack str -> JS
// string, or as msgpack bin -> Uint8Array) to a JS string.
function asString(v) {
  return v instanceof Uint8Array ? dec.decode(v) : v;
}

// ---------------------------------------------------------------------------
// Checks. Each is { name, fn(rpc) -> { ok, detail } | throws }. Later tasks
// append entries here; the runner runs whatever checks exist.
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    // A native nvim exposes v:progpath as the ABSOLUTE path to its own
    // executable (derived from uv_exepath). Under WASI, if uv_exepath returns
    // ENOSYS, neovim falls back to path_guess_exepath(), which with no $PATH
    // set copies argv[0] ("nvim") verbatim — a bare, non-absolute string. So a
    // non-empty check alone is not enough: we require a non-empty ABSOLUTE
    // path ending in "nvim", which fails on the bare fallback and passes once
    // the synthetic uv_exepath ("/nvim/bin/nvim") is in place.
    name: "progpath",
    async fn(rpc) {
      const raw = await rpc.request("nvim_eval", ["v:progpath"]);
      const value = asString(raw);
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, detail: `v:progpath is empty/non-string: ${JSON.stringify(value)}` };
      }
      if (!value.startsWith("/")) {
        return { ok: false, detail: `v:progpath is not an absolute path: ${JSON.stringify(value)}` };
      }
      if (!value.endsWith("nvim")) {
        return { ok: false, detail: `v:progpath does not end with "nvim": ${JSON.stringify(value)}` };
      }
      return { ok: true, detail: `v:progpath = ${JSON.stringify(value)}` };
    },
  },
];

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

function fail(msg) {
  console.error("PARITY FAIL:", msg);
  process.exit(1);
}

async function main() {
  const wasmPath = process.argv[2];
  const runtimePath = process.argv[3];
  if (!wasmPath || !runtimePath) {
    console.error("usage: node test/parity-check.mjs <wasm> <runtime-tarball>");
    process.exit(2);
  }

  console.log(`wasm:    ${wasmPath}`);
  console.log(`runtime: ${runtimePath}`);

  const wasmBytes = new Uint8Array(await readFile(wasmPath));
  const runtimeEntries = untar(new Uint8Array(gunzipSync(await readFile(runtimePath))));
  console.log(`loaded wasm (${wasmBytes.length} bytes), ${runtimeEntries.length} runtime entries`);

  let fatal = null;
  let exited = null;
  let host = null;

  const rpc = new NvimRpc((bytes) => host.sendStdin(bytes.slice()));
  rpc.onNotification = () => {}; // redraw etc. — ignore

  host = await startNvimHost(wasmBytes, runtimeEntries, {
    onStdout: (chunk) => rpc.feed(chunk),
    onExit: (code) => (exited = code),
    onFatal: (message) => (fatal = message),
  });

  const withTimeout = (p, ms, what) =>
    Promise.race([
      p,
      wait(ms).then(() => {
        throw new Error(`timeout after ${ms}ms waiting for ${what}` + (fatal ? ` (fatal: ${fatal})` : ""));
      }),
    ]);

  // Establish a fully booted UI-attached session, matching the smoke boot.
  const attach = await withTimeout(
    rpc.request("nvim_ui_attach", [80, 24, { ext_linegrid: true, rgb: true }]),
    8000,
    "nvim_ui_attach",
  );
  console.log(`ui_attach -> ${JSON.stringify(attach)}`);
  if (fatal) fail(`host reported fatal during boot: ${fatal}`);

  let passed = 0;
  let failed = 0;
  for (const check of CHECKS) {
    try {
      const result = await withTimeout(Promise.resolve(check.fn(rpc)), 8000, `check ${check.name}`);
      if (result.ok) {
        passed++;
        console.log(`PASS ${check.name}: ${result.detail}`);
      } else {
        failed++;
        console.log(`FAIL ${check.name}: ${result.detail}`);
      }
    } catch (e) {
      failed++;
      console.log(`FAIL ${check.name}: threw ${e instanceof Error ? e.message : String(e)}`);
    }
    if (fatal) fail(`host reported fatal: ${fatal}`);
  }

  if (exited !== null) fail(`nvim exited unexpectedly (code ${exited})`);

  console.log(`\n${CHECKS.length} checks: ${passed} passed, ${failed} failed`);
  if (failed > 0) fail(`${failed} check(s) failed`);
  console.log("PARITY PASS");
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
