# CMake cross-compilation toolchain for wasm32-wasi, driven by our pinned
# wasi-sdk (see scripts/env.sh -> $WASI_SDK).
#
# Clean-room provenance: modelled on the WASI feature facts documented in
# wasi-sdk / wasi-libc upstream (the emulation layers below) and on the
# CMake cross-compile variables in wasi-sdk's own bundled toolchain file
# ($WASI_SDK/share/cmake/wasi-sdk.cmake), which is a whitelisted upstream
# source. It does NOT copy any excluded project. We keep our own copy rather
# than including wasi-sdk's so the compiler/AR/emulation flags are pinned and
# visible in this repo, independent of the SDK's internal layout.
#
# Usage (from build-deps.sh or a later Neovim CMake configure):
#   WASI_SDK must be exported in the environment (scripts/env.sh does this).
#   cmake -DCMAKE_TOOLCHAIN_FILE=scripts/wasi-toolchain.cmake ...

set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

# Resolve the wasi-sdk install from the environment (scripts/env.sh exports
# WASI_SDK). Fail loudly if it is missing rather than silently falling back to
# a host compiler.
if(DEFINED ENV{WASI_SDK})
  set(WASI_SDK_PREFIX "$ENV{WASI_SDK}")
else()
  message(FATAL_ERROR "WASI_SDK is not set in the environment; source scripts/env.sh first")
endif()

set(_wasi_triple wasm32-wasi)

set(CMAKE_C_COMPILER   "${WASI_SDK_PREFIX}/bin/clang")
set(CMAKE_CXX_COMPILER "${WASI_SDK_PREFIX}/bin/clang++")
set(CMAKE_ASM_COMPILER "${WASI_SDK_PREFIX}/bin/clang")
set(CMAKE_AR           "${WASI_SDK_PREFIX}/bin/llvm-ar")
set(CMAKE_RANLIB       "${WASI_SDK_PREFIX}/bin/llvm-ranlib")

set(CMAKE_C_COMPILER_TARGET   "${_wasi_triple}")
set(CMAKE_CXX_COMPILER_TARGET "${_wasi_triple}")
set(CMAKE_ASM_COMPILER_TARGET "${_wasi_triple}")

set(CMAKE_SYSROOT "${WASI_SDK_PREFIX}/share/wasi-sysroot")

# wasi-libc ships several POSIX facilities as opt-in "emulated" layers: each
# needs a -D_WASI_EMULATED_* define at compile time (so the relevant headers
# declare the symbols) and a matching -lwasi-emulated-* archive at link time.
# These are exactly the four archives present in
# $WASI_SDK/share/wasi-sysroot/lib/wasm32-wasi/libwasi-emulated-*.a:
#   signal          - signal()/raise() stubs
#   process-clocks  - clock()/times() / CLOCKS_PER_SEC support
#   mman            - mmap()/munmap()/mprotect() shims
#   getpid          - getpid()
# Neovim and its deps reach for all four, so we enable them project-wide.
set(WASI_EMULATION_DEFS
    "-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID")
set(WASI_EMULATION_LIBS
    "-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid")

set(CMAKE_C_FLAGS_INIT   "${WASI_EMULATION_DEFS}")
set(CMAKE_CXX_FLAGS_INIT "${WASI_EMULATION_DEFS}")

# The emulation archives are only consumed when something is actually linked
# into an executable/shared object (the leaf-dep step in build-deps.sh only
# produces static archives, so these are inert there but correct for the later
# Neovim link step that reuses this toolchain file).
set(CMAKE_EXE_LINKER_FLAGS_INIT    "${WASI_EMULATION_LIBS}")
set(CMAKE_SHARED_LINKER_FLAGS_INIT "${WASI_EMULATION_LIBS}")

# Standard cross-compile find behaviour: run build tools from the host, but
# resolve libraries/headers/packages only inside the wasi sysroot.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
