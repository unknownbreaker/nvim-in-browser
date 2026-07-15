#!/usr/bin/env bash
# Compile Neovim's leaf dependencies to wasm32-wasi static archives (ladder
# rung 2 of nvim-wasm-prototype). Also builds a NATIVE host lua/luac, which
# Neovim's own build needs for compile-time Lua->C codegen.
#
# Usage:
#   scripts/build-deps.sh              # build every dep (skips ones already built)
#   scripts/build-deps.sh lua treesitter ...   # build only the named deps
#
# Dep names (build order matters -- lua headers feed lpeg/lua-compat53):
#   lua-host lua utf8proc treesitter lpeg unibilium lua-compat53 parsers
# "parsers" builds all six bundled tree-sitter grammars.
#
# Idempotent: each dep is skipped when its output artifact already exists, so
# re-running is a fast no-op. Delete build/deps (or build/host) to force a
# rebuild.
#
# Artifacts:
#   build/deps/lib/*.a         wasm32-wasi static archives
#   build/deps/include/...     staged public headers
#   build/host/bin/lua,luac    native host Lua 5.1 interpreter + bytecode compiler
#
# Clean-room provenance: every compile flag and patch here was derived from the
# dependency's own upstream source/build files, the WASI spec, and our pinned
# wasi-sdk/wasi-libc headers. No excluded project (MuNeNICK/nvim-wasm or
# MuNeNICK/monaco-neovim-wasm) was consulted in any form.

set -Eeuo pipefail

CURRENT_STEP="startup"
trap 'echo "build-deps.sh: FAILED during step: ${CURRENT_STEP}" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/env.sh"

: "${PROTO_ROOT:?env.sh did not set PROTO_ROOT}"
: "${WASI_SDK:?env.sh did not set WASI_SDK}"

SRC="${PROTO_ROOT}/src-cache"
BUILD="${PROTO_ROOT}/build"
OUT="${BUILD}/deps"
LIB="${OUT}/lib"
INC="${OUT}/include"
WORK="${BUILD}/deps-work"
HOSTBIN="${BUILD}/host/bin"

PATCHES="${PROTO_ROOT}/patches"
TOOLCHAIN_FILE="${SCRIPT_DIR}/wasi-toolchain.cmake"

CC="${WASI_SDK}/bin/clang"
AR="${WASI_SDK}/bin/llvm-ar"
RANLIB="${WASI_SDK}/bin/llvm-ranlib"

# wasi-libc opt-in emulation layers (see scripts/wasi-toolchain.cmake). The
# compile-time -D defines make the relevant POSIX headers declare their
# symbols; the matching -lwasi-emulated-* archives are only consumed at the
# final executable link (the later Neovim task), not when producing archives.
WASI_EMU_DEFS=(-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID)

# Base flags for every wasm compile. --target is explicit (matches rung 1); the
# "use wasm32-wasip1" deprecation warning it prints is expected and harmless.
WASI_CFLAGS=(--target=wasm32-wasi -O2 -fno-common "${WASI_EMU_DEFS[@]}")

log()  { echo "build-deps.sh: $*"; }
die()  { echo "build-deps.sh: ERROR (step: ${CURRENT_STEP}): $*" >&2; exit 1; }

ensure_dirs() {
  mkdir -p "${LIB}" "${INC}" "${WORK}" "${HOSTBIN}"
}

# --- lua (native host build) -------------------------------------------------
# Neovim's build runs host lua/luac for codegen, so this is a NATIVE compile
# with the system toolchain, not a wasm one. Compiled with LUA_USE_POSIX +
# LUA_USE_DLOPEN (the flags lua's own "bsd" platform target uses, minus the
# GNU-ld-only "-Wl,-E"): Neovim's code generators load a native helper module
# (nlua0.so, built by build-nvim.sh) via package.cpath, which requires
# dlopen support in the host interpreter. On macOS dlopen lives in libSystem,
# so no extra MYLIBS are needed. The marker file records that the installed
# binaries were built with dlopen so pre-dlopen builds get refreshed.
build_lua_host() {
  CURRENT_STEP="lua-host"
  local marker="${BUILD}/host/.lua-host-dlopen"
  if [[ -x "${HOSTBIN}/lua" && -x "${HOSTBIN}/luac" && -f "${marker}" ]]; then
    log "lua-host: already built (${HOSTBIN}/lua, luac), skipping"
    return 0
  fi
  local w="${WORK}/lua-host"
  rm -rf "${w}"
  cp -R "${SRC}/lua" "${w}"
  make -C "${w}/src" clean >/dev/null 2>&1 || true
  make -C "${w}/src" all MYCFLAGS="-DLUA_USE_POSIX -DLUA_USE_DLOPEN"
  cp "${w}/src/lua" "${HOSTBIN}/lua"
  cp "${w}/src/luac" "${HOSTBIN}/luac"
  touch "${marker}"
  log "lua-host: built ${HOSTBIN}/lua and ${HOSTBIN}/luac (with dlopen support)"
}

# --- lua (wasm32-wasi static lib) --------------------------------------------
# Builds liblua.a from Lua's core + standard-library objects (NOT the lua.c /
# luac.c / print.c frontends). Applies patches/lua51-wasi.patch first
# (os.tmpname/L_tmpnam are unavailable under WASI).
build_lua() {
  CURRENT_STEP="lua"
  if [[ -f "${LIB}/liblua.a" ]]; then
    log "lua: already built (${LIB}/liblua.a), skipping"
    return 0
  fi
  local w="${WORK}/lua"
  rm -rf "${w}"
  cp -R "${SRC}/lua" "${w}"
  CURRENT_STEP="lua: applying patches/lua51-wasi.patch"
  patch -p1 -d "${w}" < "${PATCHES}/lua51-wasi.patch"

  CURRENT_STEP="lua: compiling wasm objects"
  # Lua's error handling is built on setjmp/longjmp (luaconf.h LUAI_THROW/TRY).
  # wasi-libc's <setjmp.h> hard-#errors unless the WebAssembly exception-handling
  # feature is on, which is what `-mllvm -wasm-enable-sjlj` enables (it also
  # defines __wasm_exception_handling__, satisfying the header guard). The final
  # Neovim executable link (a later task) must use this same flag, since Neovim's
  # own longjmp-based error handling links against these objects.
  local sjlj=(-mllvm -wasm-enable-sjlj)
  local core=(lapi lcode ldebug ldo ldump lfunc lgc llex lmem lobject lopcodes
              lparser lstate lstring ltable ltm lundump lvm lzio)
  local libs=(lauxlib lbaselib ldblib liolib lmathlib loslib ltablib lstrlib
              loadlib linit)
  local objs=() f
  for f in "${core[@]}" "${libs[@]}"; do
    "${CC}" "${WASI_CFLAGS[@]}" "${sjlj[@]}" -I"${w}/src" -c "${w}/src/${f}.c" -o "${w}/src/${f}.o"
    objs+=("${w}/src/${f}.o")
  done
  "${AR}" rcu "${LIB}/liblua.a" "${objs[@]}"
  "${RANLIB}" "${LIB}/liblua.a"

  CURRENT_STEP="lua: staging headers"
  cp "${w}/src/lua.h" "${w}/src/luaconf.h" "${w}/src/lualib.h" "${w}/src/lauxlib.h" "${INC}/"
  [[ -f "${w}/src/lua.hpp" ]] && cp "${w}/src/lua.hpp" "${INC}/"
  log "lua: built ${LIB}/liblua.a (+ staged lua headers)"
}

# --- utf8proc (wasm, via CMake + our toolchain file) -------------------------
build_utf8proc() {
  CURRENT_STEP="utf8proc"
  if [[ -f "${LIB}/libutf8proc.a" ]]; then
    log "utf8proc: already built, skipping"
    return 0
  fi
  local b="${WORK}/utf8proc-build"
  rm -rf "${b}"
  cmake -S "${SRC}/utf8proc" -B "${b}" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN_FILE}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DUTF8PROC_INSTALL=OFF \
    -DUTF8PROC_ENABLE_TESTING=OFF
  cmake --build "${b}"
  cp "${b}/libutf8proc.a" "${LIB}/libutf8proc.a"
  cp "${SRC}/utf8proc/utf8proc.h" "${INC}/"
  log "utf8proc: built ${LIB}/libutf8proc.a"
}

# --- tree-sitter core runtime (wasm, via CMake + our toolchain file) ---------
build_treesitter() {
  CURRENT_STEP="treesitter"
  if [[ -f "${LIB}/libtree-sitter.a" ]]; then
    log "treesitter: already built, skipping"
    return 0
  fi
  local b="${WORK}/treesitter-build"
  rm -rf "${b}"
  # WASM engine feature OFF (no wasmtime); static lib only.
  cmake -S "${SRC}/treesitter" -B "${b}" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN_FILE}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DTREE_SITTER_FEATURE_WASM=OFF
  cmake --build "${b}"
  cp "${b}/libtree-sitter.a" "${LIB}/libtree-sitter.a"
  mkdir -p "${INC}/tree_sitter"
  cp "${SRC}/treesitter/lib/include/tree_sitter/api.h" "${INC}/tree_sitter/"
  log "treesitter: built ${LIB}/libtree-sitter.a"
}

# --- lpeg (wasm static lib, compiled against our lua headers) ----------------
build_lpeg() {
  CURRENT_STEP="lpeg"
  if [[ -f "${LIB}/liblpeg.a" ]]; then
    log "lpeg: already built, skipping"
    return 0
  fi
  [[ -f "${INC}/lua.h" ]] || die "lpeg needs staged lua headers; build 'lua' first"
  local w="${WORK}/lpeg"
  rm -rf "${w}"
  mkdir -p "${w}"
  local files=(lpvm lpcap lptree lpcode lpprint lpcset)
  local objs=() f
  for f in "${files[@]}"; do
    "${CC}" "${WASI_CFLAGS[@]}" -std=c99 -DNDEBUG \
      -I"${INC}" -I"${SRC}/lpeg" \
      -c "${SRC}/lpeg/${f}.c" -o "${w}/${f}.o"
    objs+=("${w}/${f}.o")
  done
  "${AR}" rcu "${LIB}/liblpeg.a" "${objs[@]}"
  "${RANLIB}" "${LIB}/liblpeg.a"
  log "lpeg: built ${LIB}/liblpeg.a (static; loaded via luaL_requiref/preload in the wasm build -- no dynamic loading under WASI)"
}

# --- unibilium (wasm static lib) ---------------------------------------------
build_unibilium() {
  CURRENT_STEP="unibilium"
  if [[ -f "${LIB}/libunibilium.a" ]]; then
    log "unibilium: already built, skipping"
    return 0
  fi
  local w="${WORK}/unibilium"
  rm -rf "${w}"
  mkdir -p "${w}"
  # TERMINFO_DIRS is where unibilium looks for compiled terminfo at runtime;
  # its own CMakeLists defaults to this same list. Irrelevant inside the wasm
  # sandbox (no filesystem terminfo), but the macro must be defined to compile.
  local terminfo='"/etc/terminfo:/lib/terminfo:/usr/share/terminfo"'
  local files=(unibilium uninames uniutil)
  local objs=() f
  for f in "${files[@]}"; do
    "${CC}" "${WASI_CFLAGS[@]}" -DTERMINFO_DIRS="${terminfo}" \
      -I"${SRC}/unibilium" \
      -c "${SRC}/unibilium/${f}.c" -o "${w}/${f}.o"
    objs+=("${w}/${f}.o")
  done
  "${AR}" rcu "${LIB}/libunibilium.a" "${objs[@]}"
  "${RANLIB}" "${LIB}/libunibilium.a"
  cp "${SRC}/unibilium/unibilium.h" "${INC}/"
  log "unibilium: built ${LIB}/libunibilium.a (+ staged unibilium.h)"
}

# --- lua-compat53 (wasm static lib; normally consumed as source by luv) ------
# lua-compat53 backports the Lua 5.3/5.4 C API onto 5.1. Neovim consumes it via
# luv's build (LUA_COMPAT53_DIR points at this source tree -- see Task 5/6), not
# as a standalone library. We still compile its c-api/compat-5.3.c to an archive
# here as a wasm compile-proof and stage its header.
build_lua_compat53() {
  CURRENT_STEP="lua-compat53"
  if [[ -f "${LIB}/libluacompat53.a" ]]; then
    log "lua-compat53: already built, skipping"
    return 0
  fi
  [[ -f "${INC}/lua.h" ]] || die "lua-compat53 needs staged lua headers; build 'lua' first"
  local w="${WORK}/lua-compat53"
  rm -rf "${w}"
  mkdir -p "${w}"
  "${CC}" "${WASI_CFLAGS[@]}" -std=c99 \
    -I"${INC}" -I"${SRC}/lua-compat53/c-api" \
    -c "${SRC}/lua-compat53/c-api/compat-5.3.c" -o "${w}/compat-5.3.o"
  "${AR}" rcu "${LIB}/libluacompat53.a" "${w}/compat-5.3.o"
  "${RANLIB}" "${LIB}/libluacompat53.a"
  cp "${SRC}/lua-compat53/c-api/compat-5.3.h" "${INC}/"
  log "lua-compat53: built ${LIB}/libluacompat53.a (+ staged compat-5.3.h)"
}

# --- libuv (wasm32-wasi static lib: upstream sources + our WASI shim port) ---
# Rung 3. Strategy (see shims/*.c headers + STATUS.md): compile libuv's
# portable sources and the portable parts of src/unix unmodified; replace the
# platform polling core with our poll_oneoff-backed shims/uv-wasi-poll.c; hand
# shims for async/threads/threadpool/signal/process/tty/platform (single
# thread, register-never-fire signals, ENOSYS spawn, TTY-as-pipe).
# patches/libuv-wasi.patch adds the __wasi__ platform-include and random
# branches; shims/include supplies headers wasi-libc omits (termios/pwd/grp/
# netdb); shims/uv-wasi-fixups.h is force-included to declare chown & co.;
# shims/wasi-libc-missing.c fills libc.a's undefined-at-link POSIX symbols.
build_libuv() {
  CURRENT_STEP="libuv"
  if [[ -f "${LIB}/libuv.a" ]]; then
    log "libuv: already built (${LIB}/libuv.a), skipping"
    return 0
  fi
  local w="${WORK}/libuv"
  rm -rf "${w}"
  cp -R "${SRC}/libuv" "${w}"
  CURRENT_STEP="libuv: applying patches/libuv-wasi.patch"
  patch -p1 -d "${w}" < "${PATCHES}/libuv-wasi.patch"

  CURRENT_STEP="libuv: compiling wasm objects"
  local shims="${PROTO_ROOT}/shims"
  local uvflags=(
    "${WASI_CFLAGS[@]}"
    -std=gnu11
    -D_GNU_SOURCE
    -I"${w}/include" -I"${w}/src" -I"${w}/src/unix"
    -I"${shims}/include"
    -include "${shims}/uv-wasi-fixups.h"
  )

  # Upstream libuv sources that compile for wasm32-wasi unmodified.
  local upstream=(
    src/fs-poll.c
    src/idna.c
    src/inet.c
    src/random.c
    src/strscpy.c
    src/strtok.c
    src/timer.c
    src/uv-common.c
    src/uv-data-getter-setters.c
    src/version.c
    src/unix/core.c
    src/unix/dl.c
    src/unix/fs.c
    src/unix/getaddrinfo.c
    src/unix/getnameinfo.c
    src/unix/loop-watcher.c
    src/unix/loop.c
    src/unix/no-fsevents.c
    src/unix/no-proctitle.c
    src/unix/pipe.c
    src/unix/poll.c
    src/unix/posix-hrtime.c
    src/unix/stream.c
    src/unix/tcp.c
  )
  # Our clean-room WASI port layer (each file documents what it replaces).
  local shim_srcs=(
    uv-wasi-poll.c
    uv-wasi-async.c
    uv-wasi-threads.c
    uv-wasi-threadpool.c
    uv-wasi-signal.c
    uv-wasi-process.c
    uv-wasi-tty.c
    uv-wasi-udp.c
    uv-wasi-platform.c
    wasi-libc-missing.c
  )

  local objdir="${w}/wasi-objs"
  mkdir -p "${objdir}"
  local objs=() f o
  for f in "${upstream[@]}"; do
    o="${objdir}/$(basename "${f}" .c).o"
    "${CC}" "${uvflags[@]}" -c "${w}/${f}" -o "${o}"
    objs+=("${o}")
  done
  for f in "${shim_srcs[@]}"; do
    o="${objdir}/shim-$(basename "${f}" .c).o"
    "${CC}" "${uvflags[@]}" -c "${shims}/${f}" -o "${o}"
    objs+=("${o}")
  done

  "${AR}" rcu "${LIB}/libuv.a" "${objs[@]}"
  "${RANLIB}" "${LIB}/libuv.a"

  CURRENT_STEP="libuv: staging headers"
  # Stage the PATCHED public headers (uv/unix.h carries the __wasi__ branch)
  # plus our shim headers (termios/pwd/grp/netdb/...), which uv/unix.h
  # includes and wasi-libc does not provide -- any consumer of uv.h needs
  # both on its include path.
  cp "${w}/include/uv.h" "${INC}/"
  rm -rf "${INC}/uv"
  cp -R "${w}/include/uv" "${INC}/uv"
  cp -R "${shims}/include/." "${INC}/"
  log "libuv: built ${LIB}/libuv.a (+ staged patched uv headers + shim headers)"
}

# --- luv (wasm static lib: Neovim's vim.uv Lua binding over libuv) -----------
# luv's src/luv.c is a single translation unit that #includes every other
# src/*.c file, so one compile produces the whole module (this mirrors luv's
# own CMakeLists, which lists src/luv.c as the only source). Compiled against
# our staged lua + patched uv headers and lua-compat53 (luv.c includes
# compat-5.3.h when LUA_VERSION_NUM < 503; the matching compat-5.3.c objects
# live in libluacompat53.a, linked at the final Neovim link). Headers are
# staged under include/luv/ because Neovim includes "luv/luv.h".
build_luv() {
  CURRENT_STEP="luv"
  if [[ -f "${LIB}/libluv.a" ]]; then
    log "luv: already built (${LIB}/libluv.a), skipping"
    return 0
  fi
  [[ -f "${INC}/lua.h" ]] || die "luv needs staged lua headers; build 'lua' first"
  [[ -f "${INC}/uv.h" ]] || die "luv needs staged libuv headers; build 'libuv' first"
  [[ -f "${INC}/compat-5.3.h" ]] || die "luv needs compat-5.3.h; build 'lua-compat53' first"
  local w="${WORK}/luv"
  rm -rf "${w}"
  mkdir -p "${w}"
  # Same sjlj story as lua: luv's Lua glue runs inside lua_pcall frames, and
  # every consumer of wasi-libc <setjmp.h> needs the flag to compile. luv
  # touches the same hidden-on-wasi POSIX surface libuv does (getuid,
  # getprotobyname, ...), so it gets the same shim include dir + force-included
  # fixups header; the matching stub definitions live in libuv.a
  # (shims/wasi-libc-missing.c).
  "${CC}" "${WASI_CFLAGS[@]}" -mllvm -wasm-enable-sjlj \
    -D_GNU_SOURCE \
    -I"${PROTO_ROOT}/shims/include" \
    -include "${PROTO_ROOT}/shims/uv-wasi-fixups.h" \
    -I"${INC}" -I"${SRC}/lua-compat53/c-api" \
    -c "${SRC}/luv/src/luv.c" -o "${w}/luv.o"
  "${AR}" rcu "${LIB}/libluv.a" "${w}/luv.o"
  "${RANLIB}" "${LIB}/libluv.a"
  mkdir -p "${INC}/luv"
  cp "${SRC}/luv/src/luv.h" "${SRC}/luv/src/lhandle.h" "${SRC}/luv/src/lreq.h" \
     "${SRC}/luv/src/lthreadpool.h" "${SRC}/luv/src/util.h" "${INC}/luv/"
  log "luv: built ${LIB}/libluv.a (+ staged luv headers)"
}

# --- one tree-sitter grammar -> one static archive ---------------------------
# Args: <libname> then one or more "<src-dir>:<prefix>" specs. Each spec
# compiles parser.c (always) and scanner.c (if present) from <src-dir>/src,
# using object names prefixed by <prefix> so multi-grammar bundles (markdown)
# don't collide.
_build_ts_parser() {
  local libname="$1"; shift
  local outlib="${LIB}/${libname}.a"
  if [[ -f "${outlib}" ]]; then
    log "${libname}: already built, skipping"
    return 0
  fi
  local w="${WORK}/${libname}"
  rm -rf "${w}"
  mkdir -p "${w}"
  local objs=() spec dir prefix srcdir
  for spec in "$@"; do
    dir="${spec%%:*}"
    prefix="${spec##*:}"
    srcdir="${dir}/src"
    "${CC}" "${WASI_CFLAGS[@]}" -I"${srcdir}" \
      -c "${srcdir}/parser.c" -o "${w}/${prefix}-parser.o"
    objs+=("${w}/${prefix}-parser.o")
    if [[ -f "${srcdir}/scanner.c" ]]; then
      "${CC}" "${WASI_CFLAGS[@]}" -I"${srcdir}" \
        -c "${srcdir}/scanner.c" -o "${w}/${prefix}-scanner.o"
      objs+=("${w}/${prefix}-scanner.o")
    fi
  done
  "${AR}" rcu "${outlib}" "${objs[@]}"
  "${RANLIB}" "${outlib}"
  log "${libname}: built ${outlib}"
}

build_ts_c()        { CURRENT_STEP="ts-c";        _build_ts_parser libtree-sitter-c        "${SRC}/treesitter-c:c"; }
build_ts_lua()      { CURRENT_STEP="ts-lua";      _build_ts_parser libtree-sitter-lua      "${SRC}/treesitter-lua:lua"; }
build_ts_vim()      { CURRENT_STEP="ts-vim";      _build_ts_parser libtree-sitter-vim      "${SRC}/treesitter-vim:vim"; }
build_ts_vimdoc()   { CURRENT_STEP="ts-vimdoc";   _build_ts_parser libtree-sitter-vimdoc   "${SRC}/treesitter-vimdoc:vimdoc"; }
build_ts_query()    { CURRENT_STEP="ts-query";    _build_ts_parser libtree-sitter-query    "${SRC}/treesitter-query:query"; }
build_ts_markdown() {
  CURRENT_STEP="ts-markdown"
  # The markdown grammar ships two parsers (block + inline); bundle both.
  _build_ts_parser libtree-sitter-markdown \
    "${SRC}/treesitter-markdown/tree-sitter-markdown:markdown" \
    "${SRC}/treesitter-markdown/tree-sitter-markdown-inline:markdown_inline"
}

build_parsers() {
  build_ts_c
  build_ts_lua
  build_ts_vim
  build_ts_vimdoc
  build_ts_query
  build_ts_markdown
}

# --- dispatch ----------------------------------------------------------------

ALL_DEPS=(lua-host lua utf8proc treesitter lpeg unibilium lua-compat53 parsers libuv luv)

build_one() {
  case "$1" in
    lua-host)      build_lua_host ;;
    lua)           build_lua ;;
    utf8proc)      build_utf8proc ;;
    treesitter)    build_treesitter ;;
    lpeg)          build_lpeg ;;
    unibilium)     build_unibilium ;;
    lua-compat53)  build_lua_compat53 ;;
    libuv)         build_libuv ;;
    luv)           build_luv ;;
    parsers)       build_parsers ;;
    ts-c)          build_ts_c ;;
    ts-lua)        build_ts_lua ;;
    ts-vim)        build_ts_vim ;;
    ts-vimdoc)     build_ts_vimdoc ;;
    ts-query)      build_ts_query ;;
    ts-markdown)   build_ts_markdown ;;
    *)             die "unknown dep '$1' (known: ${ALL_DEPS[*]} + individual ts-* parsers)" ;;
  esac
}

main() {
  ensure_dirs
  local targets=()
  if [[ "$#" -eq 0 ]]; then
    targets=("${ALL_DEPS[@]}")
  else
    targets=("$@")
  fi
  local d
  for d in "${targets[@]}"; do
    build_one "${d}"
  done

  CURRENT_STEP="summary"
  echo
  log "OK. Artifacts under ${OUT}:"
  echo "  host binaries:"
  ls -1 "${HOSTBIN}" 2>/dev/null | sed 's/^/    /' || true
  echo "  static libs:"
  ls -1 "${LIB}" 2>/dev/null | sed 's/^/    /' || true
}

main "$@"
