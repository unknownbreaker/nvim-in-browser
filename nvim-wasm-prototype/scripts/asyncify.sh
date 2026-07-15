#!/usr/bin/env bash
# Asyncify the linked Neovim wasm module (ladder rung 5 of
# nvim-wasm-prototype). Produces dist/nvim-asyncify.wasm from
# build/nvim/bin/nvim.
#
# The parent engine host (src/engine/nvim-host.ts) asyncifies ONLY
# wasi_snapshot_preview1.poll_oneoff: when nothing is ready it unwinds the
# whole wasm call stack (standard Binaryen Asyncify ABI), parks on a JS
# Promise, and rewinds when stdin arrives or a timer fires. So the module
# must be instrumented so that every call path that can reach the
# poll_oneoff import is unwindable.
#
# Flags (verified against the pinned binaryen-130 `wasm-opt --help`):
#   -O2                    optimize first: fewer/smaller functions before the
#                          (size-doubling) asyncify instrumentation
#   --asyncify             the transform itself; also injects the
#                          asyncify_{get_state,start_unwind,stop_unwind,
#                          start_rewind,stop_rewind} exports the host drives
#   --pass-arg=asyncify-imports@wasi_snapshot_preview1.poll_oneoff
#                          ONLY poll_oneoff may suspend (default would treat
#                          every import as suspendable, bloating the output)
#
# Feature flags: the linked module carries a target_features section
# (exception handling for the setjmp/longjmp runtime, plus the LLVM
# defaults); wasm-opt reads it automatically, so no explicit --enable-*
# flags are passed unless binaryen proves unable to detect them.
#
# Clean-room provenance: flag set derived from the installed wasm-opt
# --help and the Binaryen Asyncify pass documentation. No excluded project
# consulted.

set -Eeuo pipefail

CURRENT_STEP="startup"
trap 'echo "asyncify.sh: FAILED during step: ${CURRENT_STEP}" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/env.sh"

: "${PROTO_ROOT:?env.sh did not set PROTO_ROOT}"
: "${WASM_OPT:?env.sh did not set WASM_OPT}"

IN="${PROTO_ROOT}/build/nvim/bin/nvim"
OUT_DIR="${PROTO_ROOT}/dist"
OUT="${OUT_DIR}/nvim-asyncify.wasm"

log() { echo "asyncify.sh: $*"; }
die() { echo "asyncify.sh: ERROR (step: ${CURRENT_STEP}): $*" >&2; exit 1; }

[[ -f "${IN}" ]] || die "missing ${IN}; run scripts/build-nvim.sh first"
[[ -x "${WASM_OPT}" ]] || die "missing wasm-opt at ${WASM_OPT}; run scripts/fetch-toolchain.sh"

if [[ -f "${OUT}" && "${OUT}" -nt "${IN}" ]]; then
  log "already asyncified (${OUT} newer than ${IN}), skipping"
  exit 0
fi

mkdir -p "${OUT_DIR}"

CURRENT_STEP="wasm-opt --asyncify"
log "running wasm-opt (this can take a while on a ~6 MB module)..."
time "${WASM_OPT}" \
  -O2 \
  --asyncify \
  --pass-arg=asyncify-imports@wasi_snapshot_preview1.poll_oneoff \
  "${IN}" \
  -o "${OUT}"

CURRENT_STEP="verify"
node "${PROTO_ROOT}/test/check-asyncify.mjs" "${OUT}"

BYTES=$(wc -c < "${OUT}" | tr -d ' ')
IN_BYTES=$(wc -c < "${IN}" | tr -d ' ')
log "OK -- ${OUT} (${BYTES} bytes, from ${IN_BYTES} pre-asyncify)"
