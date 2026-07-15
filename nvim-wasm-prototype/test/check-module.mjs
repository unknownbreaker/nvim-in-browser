// Rung-4 gate check: the binary must be a WebAssembly module that compiles
// under the parent engine and exports _start (WASI command entry) + memory.
// Usage: node test/check-module.mjs <module.wasm>
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) {
  console.error('usage: node check-module.mjs <module.wasm>');
  process.exit(2);
}
const bytes = await readFile(path);
const mod = await WebAssembly.compile(bytes);
const exports = WebAssembly.Module.exports(mod);
const has = (kind, name) => exports.some((e) => e.kind === kind && e.name === name);
console.log(`check-module: WebAssembly.compile OK (${bytes.length} bytes, ${exports.length} exports)`);
if (!has('function', '_start')) {
  console.error('check-module: FAIL - no _start function export');
  process.exit(1);
}
if (!exports.some((e) => e.kind === 'memory')) {
  console.error('check-module: FAIL - no memory export');
  process.exit(1);
}
console.log('check-module: PASS (_start function + memory exported)');
