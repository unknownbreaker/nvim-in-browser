#!/usr/bin/env bash
# Fetch and pin the wasi-sdk + Binaryen toolchains used by nvim-wasm-prototype.
#
# Usage:
#   scripts/fetch-toolchain.sh                # verify pins, download+extract if needed
#   scripts/fetch-toolchain.sh --print-hashes # download (unverified) and print
#                                              # sha256 digests for VERSIONS.md,
#                                              # then exit without extracting
#
# Idempotent: re-running skips the download when a cached tarball already
# matches the pinned sha256, and skips extraction when the toolchain is
# already installed.
#
# Clean-room note: the only third-party sources this script touches are the
# official GitHub release assets of WebAssembly/wasi-sdk and
# WebAssembly/binaryen (both on the project's clean-room whitelist).

set -Eeuo pipefail

CURRENT_STEP="startup"
trap 'echo "fetch-toolchain.sh: FAILED during step: ${CURRENT_STEP}" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TOOLCHAIN_DIR="${PROTO_ROOT}/.toolchain"
DOWNLOAD_DIR="${TOOLCHAIN_DIR}/downloads"
VERSIONS_FILE="${PROTO_ROOT}/VERSIONS.md"

# --- Pinned toolchain definitions (macOS arm64 assets) ----------------------

WASI_SDK_RELEASE="wasi-sdk-33"
WASI_SDK_PKG_VERSION="33.0"
WASI_SDK_ASSET="wasi-sdk-${WASI_SDK_PKG_VERSION}-arm64-macos.tar.gz"
WASI_SDK_URL="https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/${WASI_SDK_ASSET}"
WASI_SDK_INSTALL_DIR="${TOOLCHAIN_DIR}/wasi-sdk"
WASI_SDK_MARKER="${WASI_SDK_INSTALL_DIR}/bin/clang"

BINARYEN_RELEASE="version_130"
BINARYEN_ASSET="binaryen-${BINARYEN_RELEASE}-arm64-macos.tar.gz"
BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_RELEASE}/${BINARYEN_ASSET}"
BINARYEN_INSTALL_DIR="${TOOLCHAIN_DIR}/binaryen"
BINARYEN_MARKER="${BINARYEN_INSTALL_DIR}/bin/wasm-opt"

PRINT_HASHES=0
if [[ "${1:-}" == "--print-hashes" ]]; then
  PRINT_HASHES=1
fi

# --- Helpers -----------------------------------------------------------------

die() {
  echo "fetch-toolchain.sh: ERROR (step: ${CURRENT_STEP}): $*" >&2
  exit 1
}

sha256_of() {
  local file="$1"
  shasum -a 256 "${file}" | awk '{print $1}'
}

# Reads the sha256 pin recorded in VERSIONS.md for a given asset name.
# VERSIONS.md format (per component block):
#   - asset: `<asset-name>`
#   - sha256: `<hex-or-UNPINNED>`
read_pinned_sha256() {
  local asset="$1"
  CURRENT_STEP="reading pinned sha256 for ${asset} from VERSIONS.md"
  [[ -f "${VERSIONS_FILE}" ]] || die "VERSIONS.md not found at ${VERSIONS_FILE}"

  awk -v asset="${asset}" '
    $0 ~ "asset: `" asset "`" { found=1; next }
    found && /sha256:/ {
      line=$0
      gsub(/.*sha256: `/, "", line)
      gsub(/`.*/, "", line)
      print line
      exit
    }
  ' "${VERSIONS_FILE}"
}

download_asset() {
  local url="$1" dest="$2"
  CURRENT_STEP="downloading ${url}"
  mkdir -p "$(dirname "${dest}")"
  echo "fetch-toolchain.sh: downloading ${url}"
  curl --fail --location --show-error --retry 3 --continue-at - \
    --connect-timeout 30 --max-time 1800 \
    --output "${dest}.partial" "${url}" \
    || die "curl failed for ${url}"
  mv "${dest}.partial" "${dest}"
}

# Ensures a verified-good tarball exists at ${DOWNLOAD_DIR}/<asset>.
# In --print-hashes mode: downloads unconditionally (no pin to check against
# yet) and prints the computed digest.
# In normal mode: reuses the cached tarball if its digest already matches the
# pin; otherwise (re-)downloads and hard-fails if the digest still mismatches.
ensure_verified_tarball() {
  local asset="$1" url="$2"
  local dest="${DOWNLOAD_DIR}/${asset}"

  if [[ "${PRINT_HASHES}" -eq 1 ]]; then
    CURRENT_STEP="print-hashes download of ${asset}"
    if [[ ! -f "${dest}" ]]; then
      download_asset "${url}" "${dest}"
    fi
    local digest
    digest="$(sha256_of "${dest}")"
    echo "${asset}  sha256:${digest}"
    return 0
  fi

  CURRENT_STEP="verifying pinned sha256 for ${asset}"
  local pinned
  pinned="$(read_pinned_sha256 "${asset}")"
  [[ -n "${pinned}" ]] || die "no sha256 entry found in VERSIONS.md for asset ${asset}"
  if [[ "${pinned}" == "UNPINNED" ]]; then
    die "VERSIONS.md sha256 for ${asset} is still UNPINNED; run with --print-hashes and pin it first"
  fi

  if [[ -f "${dest}" ]]; then
    local existing_digest
    existing_digest="$(sha256_of "${dest}")"
    if [[ "${existing_digest}" == "${pinned}" ]]; then
      echo "fetch-toolchain.sh: cached ${asset} already matches pinned sha256, skipping download"
      return 0
    fi
    echo "fetch-toolchain.sh: cached ${asset} digest mismatch, re-downloading" >&2
    rm -f "${dest}"
  fi

  download_asset "${url}" "${dest}"

  CURRENT_STEP="verifying downloaded sha256 for ${asset}"
  local downloaded_digest
  downloaded_digest="$(sha256_of "${dest}")"
  if [[ "${downloaded_digest}" != "${pinned}" ]]; then
    rm -f "${dest}"
    die "sha256 mismatch for ${asset}: expected ${pinned}, got ${downloaded_digest}"
  fi
}

extract_stripped() {
  local asset="$1" install_dir="$2" marker="$3"
  local tarball="${DOWNLOAD_DIR}/${asset}"

  if [[ -x "${marker}" ]]; then
    echo "fetch-toolchain.sh: ${install_dir} already installed, skipping extraction"
    return 0
  fi

  CURRENT_STEP="extracting ${asset} into ${install_dir}"
  rm -rf "${install_dir}"
  mkdir -p "${install_dir}"
  tar -xzf "${tarball}" -C "${install_dir}" --strip-components=1 \
    || die "failed to extract ${tarball}"

  [[ -x "${marker}" ]] || die "expected binary not found after extracting ${asset}: ${marker}"
}

# --- Preflight: cmake/ninja ---------------------------------------------------

check_build_tools() {
  CURRENT_STEP="checking for cmake and ninja"
  local missing=()
  command -v cmake >/dev/null 2>&1 || missing+=("cmake")
  command -v ninja >/dev/null 2>&1 || missing+=("ninja")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "fetch-toolchain.sh: missing required build tool(s): ${missing[*]}" >&2
    echo "Install with: brew install ${missing[*]}" >&2
    exit 1
  fi
}

# --- Main ----------------------------------------------------------------------

main() {
  check_build_tools

  mkdir -p "${DOWNLOAD_DIR}"

  ensure_verified_tarball "${WASI_SDK_ASSET}" "${WASI_SDK_URL}"
  ensure_verified_tarball "${BINARYEN_ASSET}" "${BINARYEN_URL}"

  if [[ "${PRINT_HASHES}" -eq 1 ]]; then
    echo "fetch-toolchain.sh: printed hashes above; paste into VERSIONS.md, then re-run without --print-hashes"
    exit 0
  fi

  extract_stripped "${WASI_SDK_ASSET}" "${WASI_SDK_INSTALL_DIR}" "${WASI_SDK_MARKER}"
  extract_stripped "${BINARYEN_ASSET}" "${BINARYEN_INSTALL_DIR}" "${BINARYEN_MARKER}"

  echo "fetch-toolchain.sh: OK"
  echo "  wasi-sdk:  ${WASI_SDK_INSTALL_DIR} (clang: ${WASI_SDK_MARKER})"
  echo "  binaryen:  ${BINARYEN_INSTALL_DIR} (wasm-opt: ${BINARYEN_MARKER})"
}

main "$@"
