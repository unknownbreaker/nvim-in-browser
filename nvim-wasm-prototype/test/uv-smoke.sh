#!/usr/bin/env bash
# test/uv-smoke.sh — build and run the rung-3 libuv acceptance gate.
#
# Usage: bash test/uv-smoke.sh
#
# Compiles test/uv-smoke.c against build/deps/lib/libuv.a (build it first
# with `bash scripts/build-deps.sh libuv`), runs it under the Node WASI
# runner (test/run-wasi.mjs, kept unmodified) with a line piped on stdin,
# and verifies:
#   - exit code 0 (module's own PASS verdict: loop init, 10ms timer fired
#     after >= 10ms, line read from fd 0, clean teardown),
#   - the line comes back verbatim on stdout (fd 1) — case A: data already
#     buffered before the loop starts; case B: data arrives 300ms in,
#     which proves the poll_oneoff fd_read subscription wakes a *blocked*
#     loop.
#
# First step: the "link-all check" (test/uv-linkall.c) — compiles and LINKS
# (never runs) a TU that references one exported symbol from every
# shims/uv-wasi-*.c object plus a handful of upstream-heavy libuv symbols,
# so a duplicate strong symbol between the shim layer and upstream (e.g.
# Finding 1's uv_free_interface_addresses) fails the build right here
# instead of surfacing later in a real consumer.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/env.sh"

: "${PROTO_ROOT:?env.sh did not set PROTO_ROOT}"
: "${WASI_SDK:?env.sh did not set WASI_SDK}"

LIB="${PROTO_ROOT}/build/deps/lib"
INC="${PROTO_ROOT}/build/deps/include"
OUT="${PROTO_ROOT}/build/uv-smoke.wasm"

[[ -f "${LIB}/libuv.a" ]] || {
  echo "uv-smoke: ${LIB}/libuv.a missing; run scripts/build-deps.sh libuv first" >&2
  exit 1
}

LINKALL_OUT="${PROTO_ROOT}/build/uv-linkall.wasm"

echo "uv-smoke: link-all check (compiling + linking ${LINKALL_OUT})"
"${WASI_SDK}/bin/clang" --target=wasm32-wasi -O2 \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID \
  -I"${INC}" \
  -o "${LINKALL_OUT}" \
  "${SCRIPT_DIR}/uv-linkall.c" \
  "${LIB}/libuv.a" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -lwasi-emulated-mman -lwasi-emulated-getpid
echo "uv-smoke: link-all check OK (no duplicate/undefined symbols)"

echo "uv-smoke: compiling ${OUT}"
"${WASI_SDK}/bin/clang" --target=wasm32-wasi -O2 \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID \
  -I"${INC}" \
  -o "${OUT}" \
  "${SCRIPT_DIR}/uv-smoke.c" \
  "${LIB}/libuv.a" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -lwasi-emulated-mman -lwasi-emulated-getpid

run_case() {
  local label="$1" delay="$2" line="hello-from-uv-smoke"
  local out rc=0
  echo "uv-smoke: case ${label} (stdin delay ${delay}s)"
  out="$( ( sleep "${delay}"; printf '%s\n' "${line}" ) \
        | node "${PROTO_ROOT}/test/run-wasi.mjs" "${OUT}" 2>&2 )" || rc=$?
  if [[ ${rc} -ne 0 ]]; then
    echo "uv-smoke: case ${label} FAILED (exit ${rc})" >&2
    return 1
  fi
  if [[ "${out}" != "${line}" ]]; then
    echo "uv-smoke: case ${label} FAILED (stdout was '${out}', want '${line}')" >&2
    return 1
  fi
  echo "uv-smoke: case ${label} OK (echoed '${out}')"
}

run_case "A-immediate" 0
run_case "B-delayed" 0.3

echo "uv-smoke: PASS"
