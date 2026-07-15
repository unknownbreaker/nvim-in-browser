#!/usr/bin/env bash
# Fetch and pin the Neovim source tarball plus every dependency source
# archive named in Neovim's own dependency manifest (cmake.deps/deps.txt).
#
# Usage:
#   scripts/fetch-sources.sh                # verify pins, download+extract if needed
#   scripts/fetch-sources.sh --print-hashes # download the Neovim tarball
#                                            # (unverified) and print its
#                                            # sha256 for VERSIONS.md, then
#                                            # exit without extracting or
#                                            # touching dependencies
#
# Idempotent: re-running skips downloads whose cached tarball already
# matches the expected sha256, and skips extraction when the source
# directory is already populated.
#
# How this works:
#   1. Download the pinned Neovim release source tarball (the *release tag*
#      is a hardcoded constant below, chosen at implementation time by
#      checking `gh release list --repo neovim/neovim` for the latest
#      non-prerelease entry -- see STATUS.md for the log of that check).
#   2. Verify it against the sha256 pinned in VERSIONS.md, extract it to
#      src-cache/neovim/.
#   3. Parse the extracted tree's own cmake.deps/deps.txt for <NAME>_URL /
#      <NAME>_SHA256 pairs -- this *is* Neovim's dependency manifest, so the
#      dep list and their sha256 digests come from Neovim upstream, not from
#      this script.
#   4. Download+verify+extract each dep (skipping the ones in SKIP_DEPS,
#      see rationale below), plus PUC Lua 5.1.5 from lua.org.
#
# Clean-room note: every URL this script fetches is either
#   (a) github.com/neovim/neovim itself (the pinned release tarball),
#   (b) a URL literally read out of that release's own cmake.deps/deps.txt
#       (upstream sources Neovim itself depends on: libuv, tree-sitter,
#       utf8proc, etc. -- all on the clean-room whitelist), or
#   (c) https://www.lua.org/ftp/lua-5.1.5.tar.gz (also whitelisted).
# This script never reads or references MuNeNICK/nvim-wasm or
# MuNeNICK/monaco-neovim-wasm.

set -Eeuo pipefail

CURRENT_STEP="startup"
trap 'echo "fetch-sources.sh: FAILED during step: ${CURRENT_STEP}" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC_CACHE="${PROTO_ROOT}/src-cache"
DOWNLOAD_DIR="${SRC_CACHE}/downloads"
VERSIONS_FILE="${PROTO_ROOT}/VERSIONS.md"

# --- Pinned Neovim release ---------------------------------------------------
# Chosen at implementation time: `gh release list --repo neovim/neovim`
# showed `v0.12.4` tagged "Latest" (the "stable" and "nightly" entries in
# that listing are floating tags, not fit for pinning). See STATUS.md.

NEOVIM_TAG="v0.12.4"
NEOVIM_VERSION="${NEOVIM_TAG#v}"
NEOVIM_ASSET="neovim-${NEOVIM_VERSION}.tar.gz"
NEOVIM_URL="https://github.com/neovim/neovim/archive/refs/tags/${NEOVIM_TAG}.tar.gz"
NEOVIM_SRC_DIR="${SRC_CACHE}/neovim"
DEPS_MANIFEST="${NEOVIM_SRC_DIR}/cmake.deps/deps.txt"

LUA_ASSET="lua-5.1.5.tar.gz"
LUA_URL="https://www.lua.org/ftp/lua-5.1.5.tar.gz"
LUA_SRC_DIR="${SRC_CACHE}/lua"

# Deps.txt entries this script deliberately does NOT fetch, and why. Every
# other <NAME>_URL/<NAME>_SHA256 pair in deps.txt is fetched automatically,
# so new tree-sitter parsers etc. that Neovim adds in a future bump are
# picked up without touching this list.
#
#   LUAJIT            - excluded per design decision: LuaJIT has no wasm32
#                        target. PUC Lua 5.1 (lua.org, fetched separately
#                        above) is used instead. Neovim's own CMakeLists.txt
#                        comments PUC Lua as "only used for tests, unless
#                        explicitly requested" -- i.e. Neovim defaults to
#                        LuaJIT and building with PUC Lua requires
#                        explicitly setting USE_BUNDLED_LUA=ON, which this
#                        clean-room build will do in a later task.
#   WASMTIME           - gated behind `option(ENABLE_WASMTIME ... OFF)` in
#                        Neovim's cmake.deps/CMakeLists.txt (default OFF);
#                        it's optional Wasm-parser support for tree-sitter,
#                        not needed to build Neovim itself.
#   GETTEXT, LIBICONV  - bundled only when `USE_BUNDLED AND MSVC` per
#                        cmake.deps/CMakeLists.txt; irrelevant off Windows.
#   WIN32YANK_X86_64   - a prebuilt Windows clipboard *binary* (not source),
#                        Windows-only, irrelevant to this build.
#   UNCRUSTIFY         - a C code formatter invoked only from dev scripts
#                        (scripts/vim-patch.sh, scripts/bump_deps.lua), not
#                        part of the CMake build graph at all.
#   LUA                - deps.txt's own LUA_URL/LUA_SHA256 already point at
#                        this exact https://www.lua.org/ftp/lua-5.1.5.tar.gz
#                        (confirmed: sha256 matches the well-known upstream
#                        digest byte-for-byte). Handled by the dedicated
#                        fetch_lua() step below instead of the generic loop,
#                        so it's fetched/verified/extracted exactly once
#                        under one asset name instead of twice under two.
SKIP_DEPS=(LUAJIT WASMTIME GETTEXT LIBICONV WIN32YANK_X86_64 UNCRUSTIFY LUA)

PRINT_HASHES=0
if [[ "${1:-}" == "--print-hashes" ]]; then
  PRINT_HASHES=1
fi

# --- Helpers -----------------------------------------------------------------

die() {
  echo "fetch-sources.sh: ERROR (step: ${CURRENT_STEP}): $*" >&2
  exit 1
}

sha256_of() {
  local file="$1"
  shasum -a 256 "${file}" | awk '{print $1}'
}

is_skipped() {
  local name="$1" skip
  for skip in "${SKIP_DEPS[@]}"; do
    [[ "${name}" == "${skip}" ]] && return 0
  done
  return 1
}

# Reads the sha256 pin recorded in VERSIONS.md for a given asset name.
# VERSIONS.md format (per component block):
#   - asset: `<asset-name>`
#   - sha256: `<hex-or-UNPINNED>`
# Prints nothing (empty string) if no such asset block exists yet.
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
  echo "fetch-sources.sh: downloading ${url}"
  curl --fail --location --show-error --retry 3 --continue-at - \
    --connect-timeout 30 --max-time 1800 \
    --output "${dest}.partial" "${url}" \
    || die "curl failed for ${url}"
  mv "${dest}.partial" "${dest}"
}

# Ensures a tarball verified against an explicit expected sha256 exists at
# ${DOWNLOAD_DIR}/<asset>. Reuses the cached file if it already matches;
# otherwise (re-)downloads and hard-fails if the digest still mismatches.
ensure_verified_tarball() {
  local asset="$1" url="$2" expected="$3"
  local dest="${DOWNLOAD_DIR}/${asset}"

  [[ -n "${expected}" ]] || die "no expected sha256 given for ${asset}"
  [[ "${expected}" != "UNPINNED" ]] || die "sha256 for ${asset} is UNPINNED"

  if [[ -f "${dest}" ]]; then
    local existing_digest
    existing_digest="$(sha256_of "${dest}")"
    if [[ "${existing_digest}" == "${expected}" ]]; then
      echo "fetch-sources.sh: cached ${asset} already matches expected sha256, skipping download"
      return 0
    fi
    echo "fetch-sources.sh: cached ${asset} digest mismatch, re-downloading" >&2
    rm -f "${dest}"
  fi

  download_asset "${url}" "${dest}"

  CURRENT_STEP="verifying downloaded sha256 for ${asset}"
  local downloaded_digest
  downloaded_digest="$(sha256_of "${dest}")"
  if [[ "${downloaded_digest}" != "${expected}" ]]; then
    rm -f "${dest}"
    die "sha256 mismatch for ${asset}: expected ${expected}, got ${downloaded_digest}"
  fi
}

extract_stripped() {
  local asset="$1" install_dir="$2" expected_sha="$3"
  local tarball="${DOWNLOAD_DIR}/${asset}"
  local stamp_file="${install_dir}/.source-sha256"

  if [[ -d "${install_dir}" ]] && [[ -n "$(ls -A "${install_dir}" 2>/dev/null)" ]]; then
    # Directory is non-empty; check if it's properly stamped and matches current source
    if [[ -f "${stamp_file}" ]]; then
      local stamped_sha
      stamped_sha="$(cat "${stamp_file}")"
      if [[ "${stamped_sha}" == "${expected_sha}" ]]; then
        echo "fetch-sources.sh: ${install_dir} already extracted, skipping"
        return 0
      fi
      # Stamp exists but doesn't match — stale extraction from a prior version
      echo "fetch-sources.sh: stale/mismatched extraction for ${asset}, re-extracting" >&2
    else
      # Directory is non-empty but has no stamp — older extraction without versioning
      echo "fetch-sources.sh: unstamped extraction for ${asset}, re-extracting" >&2
    fi
  fi

  CURRENT_STEP="extracting ${asset} into ${install_dir}"
  rm -rf "${install_dir}"
  mkdir -p "${install_dir}"
  tar -xzf "${tarball}" -C "${install_dir}" --strip-components=1 \
    || die "failed to extract ${tarball}"

  [[ -n "$(ls -A "${install_dir}" 2>/dev/null)" ]] \
    || die "extraction of ${asset} produced an empty directory"

  # Stamp the extraction with the tarball's sha256 for future version-bump detection
  echo "${expected_sha}" > "${stamp_file}"
}

# Converts a deps.txt NAME (e.g. TREESITTER_MARKDOWN) into a src-cache
# directory name (e.g. treesitter-markdown).
dep_dir_name() {
  local name="$1"
  echo "${name}" | tr 'A-Z_' 'a-z-'
}

# --- Step 1: Neovim source tarball -------------------------------------------

fetch_neovim() {
  CURRENT_STEP="fetching Neovim ${NEOVIM_TAG}"

  if [[ "${PRINT_HASHES}" -eq 1 ]]; then
    local dest="${DOWNLOAD_DIR}/${NEOVIM_ASSET}"
    mkdir -p "${DOWNLOAD_DIR}"
    [[ -f "${dest}" ]] || download_asset "${NEOVIM_URL}" "${dest}"
    echo "${NEOVIM_ASSET}  sha256:$(sha256_of "${dest}")"
    echo "fetch-sources.sh: printed hash above; paste into VERSIONS.md, then re-run without --print-hashes"
    exit 0
  fi

  local pinned
  pinned="$(read_pinned_sha256 "${NEOVIM_ASSET}")"
  [[ -n "${pinned}" ]] || die "no sha256 entry found in VERSIONS.md for asset ${NEOVIM_ASSET}"
  if [[ "${pinned}" == "UNPINNED" ]]; then
    die "VERSIONS.md sha256 for ${NEOVIM_ASSET} is still UNPINNED; run with --print-hashes and pin it first"
  fi

  mkdir -p "${DOWNLOAD_DIR}"
  ensure_verified_tarball "${NEOVIM_ASSET}" "${NEOVIM_URL}" "${pinned}"
  extract_stripped "${NEOVIM_ASSET}" "${NEOVIM_SRC_DIR}" "${pinned}"
}

# --- Step 2: parse Neovim's own deps.txt -------------------------------------
# Emits lines "<NAME> <URL> <SHA256>" for every non-comment, non-skipped
# entry in deps.txt onto stdout.

parse_deps_manifest() {
  CURRENT_STEP="parsing dependency manifest ${DEPS_MANIFEST}"
  # NOTE: this function is invoked from a `< <(...)` process substitution in
  # main(), which runs in a subshell -- a `die` (exit) in here would only
  # kill that subshell and go unnoticed by the parent, so the existence
  # check is deliberately hoisted into main() instead, where a failure can
  # actually abort the script.

  awk '
    /^[A-Z0-9_]+_URL /    { name=$1; sub(/_URL$/, "", name); url[name]=$2 }
    /^[A-Z0-9_]+_SHA256 / { name=$1; sub(/_SHA256$/, "", name); sha[name]=$2 }
    END {
      for (n in url) {
        if (n in sha) print n, url[n], sha[n]
      }
    }
  ' "${DEPS_MANIFEST}" | sort
}

# --- Step 3: fetch each dep source archive -----------------------------------

fetch_dep() {
  local name="$1" url="$2" expected_sha="$3"
  local asset install_dir pinned dir_name

  dir_name="$(dep_dir_name "${name}")"
  # Prefixed with dir_name because upstream basenames alone collide easily
  # (many projects tag releases "vX.Y.Z.tar.gz"); this keeps both the
  # download cache and the VERSIONS.md asset key unambiguous per dep.
  asset="${dir_name}-$(basename "${url}")"
  install_dir="${SRC_CACHE}/${dir_name}"

  CURRENT_STEP="fetching dep ${name}"

  # Cross-check against VERSIONS.md if already pinned there (defense against
  # the manifest silently drifting between Neovim releases); the manifest's
  # own sha256 is always the authoritative value used for verification.
  pinned="$(read_pinned_sha256 "${asset}")"
  if [[ -n "${pinned}" ]] && [[ "${pinned}" != "UNPINNED" ]] && [[ "${pinned}" != "${expected_sha}" ]]; then
    die "VERSIONS.md pin for ${asset} (${pinned}) disagrees with Neovim's deps.txt (${expected_sha})"
  fi

  ensure_verified_tarball "${asset}" "${url}" "${expected_sha}"
  extract_stripped "${asset}" "${install_dir}" "${expected_sha}"

  echo "${name} ${asset} ${expected_sha} ${install_dir}" >> "${DEP_SUMMARY_FILE}"
}

fetch_lua() {
  CURRENT_STEP="fetching PUC Lua 5.1.5"
  local expected="2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333"
  local pinned
  pinned="$(read_pinned_sha256 "${LUA_ASSET}")"
  if [[ -n "${pinned}" ]] && [[ "${pinned}" != "UNPINNED" ]] && [[ "${pinned}" != "${expected}" ]]; then
    die "VERSIONS.md pin for ${LUA_ASSET} (${pinned}) disagrees with the well-known lua.org sha256 (${expected})"
  fi
  ensure_verified_tarball "${LUA_ASSET}" "${LUA_URL}" "${expected}"
  extract_stripped "${LUA_ASSET}" "${LUA_SRC_DIR}" "${expected}"
  echo "LUA ${LUA_ASSET} ${expected} ${LUA_SRC_DIR}" >> "${DEP_SUMMARY_FILE}"
}

# --- Main ---------------------------------------------------------------------

main() {
  mkdir -p "${SRC_CACHE}" "${DOWNLOAD_DIR}"

  fetch_neovim

  CURRENT_STEP="checking dependency manifest exists"
  [[ -f "${DEPS_MANIFEST}" ]] || die "deps manifest not found at ${DEPS_MANIFEST} (did Neovim extraction succeed?)"

  DEP_SUMMARY_FILE="$(mktemp)"
  trap 'rm -f "${DEP_SUMMARY_FILE}"' EXIT

  DEPS_LIST_FILE="$(mktemp)"
  parse_deps_manifest > "${DEPS_LIST_FILE}"

  CURRENT_STEP="iterating dependency manifest"
  local skipped_names=()
  while read -r name url sha; do
    [[ -n "${name}" ]] || continue
    if is_skipped "${name}"; then
      skipped_names+=("${name}")
      continue
    fi
    fetch_dep "${name}" "${url}" "${sha}"
  done < "${DEPS_LIST_FILE}"
  rm -f "${DEPS_LIST_FILE}"

  fetch_lua

  echo "fetch-sources.sh: OK"
  echo "  neovim:  ${NEOVIM_SRC_DIR} (${NEOVIM_TAG})"
  echo "  deps fetched:"
  sort "${DEP_SUMMARY_FILE}" | while read -r name asset sha dir; do
    echo "    ${name}: ${dir} (${asset}, sha256:${sha})"
  done
  echo "  deps skipped (see SKIP_DEPS comment in this script): ${skipped_names[*]}"
}

main "$@"
