#!/usr/bin/env bash
# Sourceable environment for nvim-wasm-prototype scripts.
#
# Usage: source scripts/env.sh   (from anywhere; path is derived from this
# file's own location, not the caller's working directory)
#
# Exports:
#   PROTO_ROOT  - absolute path to nvim-wasm-prototype/
#   WASI_SDK    - absolute path to the pinned wasi-sdk install
#   WASM_OPT    - absolute path to the pinned binaryen wasm-opt binary

# Intentionally not `set -e`/`set -u` here: this file is meant to be
# `source`d into a caller's shell, and a strict caller-visible error mode
# should not be silently imposed on that shell. Scripts that source this
# file should set their own strict mode before sourcing.

# Resolve this file's own path portably: BASH_SOURCE is unset when zsh
# sources a bash-shebang script, so fall back to zsh's %N parameter
# expansion in that case.
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  _env_sh_self="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  _env_sh_self="${(%):-%N}"
else
  _env_sh_self="$0"
fi

_env_sh_dir="$(cd "$(dirname "${_env_sh_self}")" && pwd)"
export PROTO_ROOT
PROTO_ROOT="$(cd "${_env_sh_dir}/.." && pwd)"
unset _env_sh_dir _env_sh_self

export WASI_SDK="${PROTO_ROOT}/.toolchain/wasi-sdk"
export WASM_OPT="${PROTO_ROOT}/.toolchain/binaryen/bin/wasm-opt"
