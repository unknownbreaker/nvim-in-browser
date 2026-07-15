#!/usr/bin/env bash
# Package the pinned Neovim runtime/ tree as dist/nvim-runtime.tar.gz for the
# parent engine host (ladder rungs 5-8 of nvim-wasm-prototype).
#
# Layout contract (verified against the parent's own code, both ours):
#   * src/engine/nvim-host.ts mounts the tarball's entries as the wasm root
#     preopen ("/"), then sets VIMRUNTIME=/runtime -- so the tarball must
#     contain a single top-level `runtime/` directory.
#   * src/engine/untar.ts is a minimal ustar reader: it understands classic
#     file ("0"/NUL) and dir ("5") entries plus the ustar prefix field, and
#     SKIPS pax extended headers (x/g) and GNU longname (L) records. So the
#     tarball must be plain ustar -- no pax headers -- or entries with long
#     paths would silently vanish. `tar --format=ustar` guarantees that (and
#     errors loudly if any path cannot be represented, rather than emitting
#     an extension record).
#   * COPYFILE_DISABLE=1 stops macOS bsdtar from adding AppleDouble (._*)
#     sidecar entries.
#
# The whole source runtime/ tree ships (~26 MB, no symlinks). Build-time
# generated runtime artifacts (doc tags, syntax/vim/generated.vim) are NOT
# produced by our nvim_bin-only build and are not required by the embedded
# RPC path this prototype targets.
#
# Clean-room provenance: layout derived from the parent repo's own engine
# sources listed above. No excluded project consulted.

set -Eeuo pipefail

CURRENT_STEP="startup"
trap 'echo "package-runtime.sh: FAILED during step: ${CURRENT_STEP}" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/env.sh"

: "${PROTO_ROOT:?env.sh did not set PROTO_ROOT}"

RUNTIME_SRC="${PROTO_ROOT}/src-cache/neovim/runtime"
OUT_DIR="${PROTO_ROOT}/dist"
OUT="${OUT_DIR}/nvim-runtime.tar.gz"

log() { echo "package-runtime.sh: $*"; }
die() { echo "package-runtime.sh: ERROR (step: ${CURRENT_STEP}): $*" >&2; exit 1; }

[[ -d "${RUNTIME_SRC}" ]] || die "missing ${RUNTIME_SRC}; run scripts/fetch-sources.sh"

CURRENT_STEP="tar"
mkdir -p "${OUT_DIR}"
COPYFILE_DISABLE=1 tar --format=ustar \
  --exclude '.DS_Store' \
  -czf "${OUT}" \
  -C "${PROTO_ROOT}/src-cache/neovim" \
  runtime

CURRENT_STEP="verify"
# Plain-ustar sanity: listing must succeed and every entry must live under
# runtime/ (a stray absolute or ./-prefixed path would land outside the
# host's /runtime mount).
BAD_PATHS=$(tar -tzf "${OUT}" | grep -cv '^runtime/' || true)
[[ "${BAD_PATHS}" == "0" ]] || die "${BAD_PATHS} entries do not start with runtime/"
ENTRIES=$(tar -tzf "${OUT}" | wc -l | tr -d ' ')
BYTES=$(wc -c < "${OUT}" | tr -d ' ')
log "OK -- ${OUT} (${BYTES} bytes, ${ENTRIES} entries, all under runtime/)"
