#!/usr/bin/env node
// Minimal, reusable WASI preview1 runner for nvim-wasm-prototype.
//
// Usage:
//   node run-wasi.mjs <path-to.wasm> [--preopen HOST_PATH:GUEST_PATH ...] [-- arg1 arg2 ...]
//
// Instantiates the given wasm32-wasi module, wires it to node:wasi
// (preview1), runs `_start`, and exits the Node process with the module's
// own exit code. Requires Node >= 20.

import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

function parseArgs(argv) {
  const wasmPath = argv[0];
  if (!wasmPath) {
    console.error('usage: run-wasi.mjs <path-to.wasm> [--preopen HOST:GUEST ...] [-- arg1 arg2 ...]');
    process.exit(2);
  }

  const preopens = {};
  const wasmArgs = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--preopen') {
      const spec = argv[++i];
      const sep = spec.indexOf(':');
      if (sep === -1) {
        console.error(`invalid --preopen spec (want HOST:GUEST): ${spec}`);
        process.exit(2);
      }
      const hostPath = spec.slice(0, sep);
      const guestPath = spec.slice(sep + 1);
      preopens[guestPath] = hostPath;
    } else if (arg === '--') {
      wasmArgs.push(...argv.slice(i + 1));
      break;
    } else {
      console.error(`unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }

  return { wasmPath, preopens, wasmArgs };
}

async function main() {
  const { wasmPath, preopens, wasmArgs } = parseArgs(process.argv.slice(2));

  const wasi = new WASI({
    version: 'preview1',
    args: [wasmPath, ...wasmArgs],
    env: process.env,
    preopens,
    returnOnExit: true,
  });

  const wasmBytes = await readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  const exitCode = wasi.start(instance);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
