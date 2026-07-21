#!/usr/bin/env bash
# redeploy.sh — pull the latest and refresh your local extension build.
#
# Run this instead of a bare `git pull` to keep the loaded extension current: it
# fast-forward-pulls, reinstalls deps only if the lockfile changed, re-fetches
# the pinned nvim-wasi engine only if engine.lock.json changed, then rebuilds.
# Reload the extension afterward (chrome://extensions ↻, or about:debugging for
# Firefox).
#
# This replaces the old scripts/git-hooks/post-merge hook. A git hook ran WITHOUT
# your login shell, so an nvm-managed `npm` was frequently off PATH and the build
# silently didn't run; a script you invoke from your terminal always has the
# right `npm`. Unlike the hook, it also fails loudly (set -e) if the build breaks,
# instead of leaving you with a stale build.
set -euo pipefail

cd "$(dirname "$0")"

before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

# Reinstall deps only when the lockfile (or package.json) changed, or
# node_modules is missing. Skipped on a content-only pull — the slowest step.
if [[ ! -d node_modules ]] || ! git diff --quiet "$before" "$after" -- package-lock.json package.json; then
  echo "[redeploy] dependencies changed — installing"
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi

# Always ensure the pinned nvim-wasi engine assets are present before building.
# fetch-engine.mjs is idempotent and cheap when they're current (it skips any
# file whose sha256 already matches engine.lock.json — no download), and running
# it unconditionally self-heals a clone that never fetched them or is missing a
# newer variant (e.g. the -web language-pack wasm added in a later release). A
# lock-change-only guard would skip the fetch and the build would then fail on
# the missing asset.
echo "[redeploy] ensuring engine assets (idempotent)"
npm run fetch-assets

echo "[redeploy] building..."
npm run build

echo "[redeploy] done — reload the extension (chrome://extensions ↻, or about:debugging for Firefox)"
