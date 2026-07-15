#!/usr/bin/env bash
# Compile and link Neovim v0.12.4 itself as a wasm32-wasi module (ladder
# rung 4 of nvim-wasm-prototype). Produces build/nvim/bin/nvim.
#
# Usage:
#   scripts/build-nvim.sh              # all steps (skips ones already done)
#   scripts/build-nvim.sh <step>...    # only the named steps
# Steps (in order): host-nlua0 shim configure build verify
#
# Prerequisites: scripts/fetch-sources.sh and scripts/build-deps.sh have run
# (build/deps holds the wasm archives + staged headers, build/host/bin the
# native lua/luac).
#
# Build wiring notes (discovered from Neovim's own CMakeLists/cmake/*):
#   * PREFER_LUA=ON selects PUC Lua over LuaJIT; v0.12.4 fully supports it
#     (vendors src/bit.c as the `bit` library replacement via
#     NVIM_VENDOR_BIT). LuaJIT is only needed for unit-test fixtures, which
#     PREFER_LUA skips.
#   * Cross-compiling + NLUA0_HOST_PRG makes every code generator run under
#     our NATIVE build/host/bin/lua with the native nlua0.so helper module
#     (mpack + lpeg + bit), instead of a target-built nlua0.
#   * COMPILE_LUA=OFF: precompiled Lua bytecode is not portable from the
#     64-bit host lua to the 32-bit wasm PUC Lua (dumped headers encode
#     sizeof(size_t)), so embedded runtime modules stay as source.
#   * All dependency find_package's are short-circuited with explicit
#     <DEP>_LIBRARY/<DEP>_INCLUDE_DIR cache entries pointing at build/deps.
#   * iconv: wasi-libc ships musl's real built-in iconv (UTF-8 & friends) in
#     libc.a, so ICONV_INCLUDE_DIR points into the wasi sysroot; no stub.
#   * sjlj: liblua.a/libluv.a are built with -mllvm -wasm-enable-sjlj (Lua
#     error handling is setjmp/longjmp); the nvim TUs and final link use the
#     same flag, and the link adds -lsetjmp for __wasm_setjmp & co.
#   * The wasi-emulated-* archives and our stub archives are appended via
#     CMAKE_C_STANDARD_LIBRARIES (end of the link line) because wasm-ld
#     scans archives strictly left-to-right.
#
# Idempotent: each step is skipped when its artifact exists; delete
# build/nvim (or build/host/lib) to force. The ninja step resumes wherever
# it stopped, so re-running after a fixed compile error just continues.
#
# Clean-room provenance: every flag/cache-var here was derived from Neovim's
# own build files (CMakeLists.txt, cmake/*.cmake, src/nvim/CMakeLists.txt),
# the wasi-sdk/wasi-libc headers, and CMake documentation. No excluded
# project (MuNeNICK/nvim-wasm or MuNeNICK/monaco-neovim-wasm) was consulted
# in any form.

set -Eeuo pipefail

CURRENT_STEP="startup"
trap 'echo "build-nvim.sh: FAILED during step: ${CURRENT_STEP}" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/env.sh"

: "${PROTO_ROOT:?env.sh did not set PROTO_ROOT}"
: "${WASI_SDK:?env.sh did not set WASI_SDK}"

SRC="${PROTO_ROOT}/src-cache"
NVIM_SRC="${SRC}/neovim"
BUILD="${PROTO_ROOT}/build"
DEPS="${BUILD}/deps"
LIB="${DEPS}/lib"
INC="${DEPS}/include"
HOSTBIN="${BUILD}/host/bin"
HOSTLIB="${BUILD}/host/lib"
NVIM_BUILD="${BUILD}/nvim"
SHIMS="${PROTO_ROOT}/shims"
TOOLCHAIN_FILE="${SCRIPT_DIR}/wasi-toolchain.cmake"
SYSROOT_INC="${WASI_SDK}/share/wasi-sysroot/include/wasm32-wasi"

CC_WASI="${WASI_SDK}/bin/clang"
AR_WASI="${WASI_SDK}/bin/llvm-ar"
RANLIB_WASI="${WASI_SDK}/bin/llvm-ranlib"

log() { echo "build-nvim.sh: $*"; }
die() { echo "build-nvim.sh: ERROR (step: ${CURRENT_STEP}): $*" >&2; exit 1; }

require_deps() {
  [[ -d "${NVIM_SRC}" ]] || die "missing ${NVIM_SRC}; run scripts/fetch-sources.sh"
  [[ -f "${LIB}/liblua.a" && -f "${LIB}/libuv.a" && -f "${LIB}/libluv.a" ]] \
    || die "missing wasm dep archives; run scripts/build-deps.sh"
  [[ -x "${HOSTBIN}/lua" ]] || die "missing host lua; run scripts/build-deps.sh"
}

# --- host-nlua0: native helper module for Neovim's code generators -----------
# Neovim's generators (src/gen/*.lua) run under a host Lua and `require
# 'nlua0'` -- a C module bundling vim.mpack, vim.lpeg and (for PUC Lua) the
# LuaJIT-compatible `bit` library. Upstream builds it as a CMake MODULE
# target for the build machine; when cross-compiling it expects a prebuilt
# one via NLUA0_HOST_PRG (src/nvim/CMakeLists.txt). We assemble it here from
# Neovim's own sources (src/nlua0.c, src/mpack/*.c, src/bit.c) plus the
# pinned lpeg sources, compiled against the host Lua 5.1 headers.
build_host_nlua0() {
  CURRENT_STEP="host-nlua0"
  local out="${HOSTLIB}/nlua0.so"
  if [[ -f "${out}" ]]; then
    log "host-nlua0: already built (${out}), skipping"
    return 0
  fi
  mkdir -p "${HOSTLIB}"
  local w="${BUILD}/host/nlua0-work"
  rm -rf "${w}"
  mkdir -p "${w}"

  # src/mpack/lmpack.c pulls in nvim/macros_defs.h, which includes the
  # CMake-generated "auto/config.h". Nothing lmpack actually uses from it
  # is mandatory (only optional HAVE_* toggles), so an empty one satisfies
  # the host compile.
  mkdir -p "${w}/auto"
  : > "${w}/auto/config.h"

  local hostcc=(cc -O2 -fPIC
    -I"${SRC}/lua/src"        # host Lua 5.1 headers
    -I"${NVIM_SRC}/src"       # for "mpack/lmpack.h"
    -I"${w}"                  # for "auto/config.h" (empty stand-in)
    -I"${SRC}/lpeg")
  local srcs=("${NVIM_SRC}/src/nlua0.c" "${NVIM_SRC}/src/bit.c")
  local f
  for f in "${NVIM_SRC}"/src/mpack/*.c; do
    srcs+=("${f}")
  done
  for f in lpvm lpcap lptree lpcode lpprint lpcset; do
    srcs+=("${SRC}/lpeg/${f}.c")
  done
  local objs=() o
  for f in "${srcs[@]}"; do
    o="${w}/$(basename "${f}" .c).o"
    "${hostcc[@]}" -c "${f}" -o "${o}"
    objs+=("${o}")
  done
  # macOS: a loadable bundle resolving lua_* symbols from the host lua
  # process at load time. Elsewhere: a regular shared object.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    cc -bundle -undefined dynamic_lookup -o "${out}" "${objs[@]}"
  else
    cc -shared -o "${out}" "${objs[@]}"
  fi
  log "host-nlua0: built ${out}"
}

# --- shim: wasm archive of Neovim-specific libc stubs -------------------------
build_shim() {
  CURRENT_STEP="shim"
  local out="${LIB}/libnvim-wasi-shim.a"
  local src="${SHIMS}/nvim-wasi-stubs.c"
  if [[ -f "${out}" && "${out}" -nt "${src}" ]]; then
    log "shim: already built (${out}), skipping"
    return 0
  fi
  local w="${BUILD}/nvim-shim-work"
  rm -rf "${w}"
  mkdir -p "${w}"
  "${CC_WASI}" --target=wasm32-wasi -O2 -fno-common \
    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
    -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID \
    -isystem "${SHIMS}/include" \
    -c "${src}" -o "${w}/nvim-wasi-stubs.o"
  "${AR_WASI}" rcu "${out}" "${w}/nvim-wasi-stubs.o"
  "${RANLIB_WASI}" "${out}"
  log "shim: built ${out}"
}

# --- configure: Neovim CMake with the wasi toolchain --------------------------
configure_nvim() {
  CURRENT_STEP="configure"
  if [[ -f "${NVIM_BUILD}/build.ninja" ]]; then
    log "configure: already configured (${NVIM_BUILD}/build.ninja), skipping"
    return 0
  fi

  # Every Neovim TU: the wasi-libc emulation defines, the sjlj codegen flag
  # (matches liblua.a/libluv.a), our shim headers (searched before the
  # sysroot: adds termios/pty/sys-wait/netdb..., upgrades sys/ioctl.h), and
  # the force-included redeclarations of hidden fork/exec-family prototypes.
  local cflags="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS"
  cflags+=" -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID"
  cflags+=" -mllvm -wasm-enable-sjlj"
  cflags+=" -isystem ${SHIMS}/include"
  cflags+=" -include ${SHIMS}/nvim-wasi-fixups.h"

  # End-of-link-line archives (wasm-ld scans archives left to right, so
  # these must come after every object/lib that references them):
  #   wasi-emulated-*  - signal()/clock()/mmap()/getpid() emulation
  #   setjmp           - __wasm_setjmp/__wasm_longjmp runtime for sjlj
  #   luacompat53      - Lua 5.3 C API shims referenced by libluv.a
  #   nvim-wasi-shim   - our honest-failure process/pty/tmpfile stubs
  local stdlibs="-lwasi-emulated-signal -lwasi-emulated-process-clocks"
  stdlibs+=" -lwasi-emulated-mman -lwasi-emulated-getpid -lsetjmp"
  stdlibs+=" ${LIB}/libluacompat53.a ${LIB}/libnvim-wasi-shim.a"

  cmake -S "${NVIM_SRC}" -B "${NVIM_BUILD}" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN_FILE}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="${cflags}" \
    -DCMAKE_C_STANDARD_LIBRARIES="${stdlibs}" \
    -DCMAKE_EXE_LINKER_FLAGS="-Wl,-z,stack-size=8388608" \
    -DCMAKE_FIND_ROOT_PATH="${DEPS}" \
    -DDEPS_PREFIX="${DEPS}" \
    -DPREFER_LUA=ON \
    -DCOMPILE_LUA=OFF \
    -DENABLE_LIBINTL=OFF \
    -DENABLE_LTO=OFF \
    -DLUA_PRG="${HOSTBIN}/lua" \
    -DLUA_GEN_PRG="${HOSTBIN}/lua" \
    -DNLUA0_HOST_PRG="${HOSTLIB}/nlua0.so" \
    -DLUA_INCLUDE_DIR="${INC}" \
    -DLUA_LIBRARY="${LIB}/liblua.a" \
    -DLIBUV_INCLUDE_DIR="${INC}" \
    -DLIBUV_LIBRARY="${LIB}/libuv.a" \
    -DLUV_INCLUDE_DIR="${INC}" \
    -DLUV_LIBRARY="${LIB}/libluv.a" \
    -DLPEG_LIBRARY="${LIB}/liblpeg.a" \
    -DTREESITTER_INCLUDE_DIR="${INC}" \
    -DTREESITTER_LIBRARY="${LIB}/libtree-sitter.a" \
    -DUTF8PROC_INCLUDE_DIR="${INC}" \
    -DUTF8PROC_LIBRARY="${LIB}/libutf8proc.a" \
    -DUNIBILIUM_INCLUDE_DIR="${INC}" \
    -DUNIBILIUM_LIBRARY="${LIB}/libunibilium.a" \
    -DICONV_INCLUDE_DIR="${SYSROOT_INC}"
  log "configure: done (${NVIM_BUILD})"
}

# --- build: the actual compile + link ----------------------------------------
build_nvim() {
  CURRENT_STEP="build"
  if [[ -f "${NVIM_BUILD}/bin/nvim" ]]; then
    log "build: ${NVIM_BUILD}/bin/nvim already exists, skipping (delete to rebuild)"
    return 0
  fi
  cmake --build "${NVIM_BUILD}" --target nvim_bin
  [[ -f "${NVIM_BUILD}/bin/nvim" ]] || die "ninja succeeded but ${NVIM_BUILD}/bin/nvim is missing"
  log "build: linked ${NVIM_BUILD}/bin/nvim"
}

# --- verify: rung-4 acceptance gate -------------------------------------------
verify_nvim() {
  CURRENT_STEP="verify"
  local bin="${NVIM_BUILD}/bin/nvim"
  [[ -f "${bin}" ]] || die "no ${bin}; run the build step first"

  # llvm-objdump identifies LINKED wasm modules ("file format wasm") but
  # then exits nonzero because it only supports deep-dumping wasm OBJECT
  # files -- it does the same on rung 1's known-good hello.wasm. The gate
  # assertion is the format line itself; Node's WebAssembly.compile below
  # is the real "this is a valid module" check.
  log "verify: llvm-objdump --file-headers"
  local objdump_out
  objdump_out="$("${WASI_SDK}/bin/llvm-objdump" --file-headers "${bin}" 2>&1 || true)"
  echo "${objdump_out}"
  grep -q "file format wasm" <<<"${objdump_out}" || die "${bin} is not a wasm module"

  log "verify: node test/check-module.mjs"
  node "${PROTO_ROOT}/test/check-module.mjs" "${bin}"

  local bytes
  bytes=$(wc -c < "${bin}" | tr -d ' ')
  log "verify: OK -- ${bin} (${bytes} bytes)"
}

# --- dispatch ------------------------------------------------------------------

ALL_STEPS=(host-nlua0 shim configure build verify)

run_step() {
  case "$1" in
    host-nlua0) build_host_nlua0 ;;
    shim)       build_shim ;;
    configure)  configure_nvim ;;
    build)      build_nvim ;;
    verify)     verify_nvim ;;
    *)          die "unknown step '$1' (known: ${ALL_STEPS[*]})" ;;
  esac
}

main() {
  require_deps
  local steps=()
  if [[ "$#" -eq 0 ]]; then
    steps=("${ALL_STEPS[@]}")
  else
    steps=("$@")
  fi
  local s
  for s in "${steps[@]}"; do
    run_step "${s}"
  done
  log "OK"
}

main "$@"
