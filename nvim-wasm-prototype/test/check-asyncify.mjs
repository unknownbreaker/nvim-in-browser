// Rung-5 gate check: the asyncified module must compile and export the full
// surface the parent engine host (src/engine/nvim-host.ts NvimExports)
// dereferences at boot: _start + memory, the Binaryen Asyncify ABI, and our
// scratch-region discovery helpers from shims/nvim-wasi-asyncify.c.
// Usage: node test/check-asyncify.mjs <module.wasm>
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) {
  console.error('usage: node check-asyncify.mjs <module.wasm>');
  process.exit(2);
}
const bytes = await readFile(path);
const mod = await WebAssembly.compile(bytes);
const exports = WebAssembly.Module.exports(mod);
console.log(`check-asyncify: WebAssembly.compile OK (${bytes.length} bytes, ${exports.length} exports)`);

const REQUIRED_FUNCTIONS = [
  '_start',
  'asyncify_get_state',
  'asyncify_start_unwind',
  'asyncify_stop_unwind',
  'asyncify_start_rewind',
  'asyncify_stop_rewind',
  'nvim_asyncify_get_data_ptr',
  'nvim_asyncify_get_stack_start',
  'nvim_asyncify_get_stack_end',
];

let ok = true;
for (const name of REQUIRED_FUNCTIONS) {
  if (!exports.some((e) => e.kind === 'function' && e.name === name)) {
    console.error(`check-asyncify: FAIL - missing function export ${name}`);
    ok = false;
  }
}
if (!exports.some((e) => e.kind === 'memory')) {
  console.error('check-asyncify: FAIL - no memory export');
  ok = false;
}
if (!ok) process.exit(1);
console.log('check-asyncify: PASS (asyncify ABI + scratch helpers + _start + memory)');
