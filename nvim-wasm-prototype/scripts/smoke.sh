#!/usr/bin/env bash
# Rung-8 acceptance gate for nvim-wasm-prototype: run the PARENT repo's real
# smoke harness (scripts/smoke-nvim.mjs — boots the engine host, ui_attach,
# "ihello" edit round-trip, idle wake-up assertion (<=5/s), post-idle
# "oworld" edit) against OUR clean-room artifacts:
#
#   dist/nvim-asyncify.wasm    (scripts/build-nvim.sh + scripts/asyncify.sh)
#   dist/nvim-runtime.tar.gz   (scripts/package-runtime.sh)
#
# Usage: bash scripts/smoke.sh [idleSeconds]   (idleSeconds defaults to the
# harness's own default, 10)
#
# PASS looks like: "SMOKE PASS" on stdout, exit 0.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/env.sh"

: "${PROTO_ROOT:?env.sh did not set PROTO_ROOT}"
PARENT_ROOT="$(cd "${PROTO_ROOT}/.." && pwd)"

WASM="${PROTO_ROOT}/dist/nvim-asyncify.wasm"
RUNTIME="${PROTO_ROOT}/dist/nvim-runtime.tar.gz"

die() { echo "smoke.sh: ERROR: $*" >&2; exit 1; }

[[ -f "${WASM}" ]] || die "missing ${WASM}; run scripts/build-nvim.sh && scripts/asyncify.sh"
[[ -f "${RUNTIME}" ]] || die "missing ${RUNTIME}; run scripts/package-runtime.sh"
[[ -f "${PARENT_ROOT}/scripts/smoke-nvim.mjs" ]] \
  || die "parent harness not found at ${PARENT_ROOT}/scripts/smoke-nvim.mjs"

exec env \
  NVIM_WASM_PATH="${WASM}" \
  NVIM_RUNTIME_PATH="${RUNTIME}" \
  node "${PARENT_ROOT}/scripts/smoke-nvim.mjs" "$@"
