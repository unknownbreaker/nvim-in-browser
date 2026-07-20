#!/bin/bash
# release.sh — build, package, and publish a release of nvim-in-browser.
#
# Usage: scripts/release.sh <patch|minor|major|X.Y.Z> [--dry-run]
#
# Flow: bump version -> build dist/chromium -> package zips ->
#       release/vX.Y.Z branch -> push -> PR -> squash-merge ->
#       tag vX.Y.Z on main -> GitHub release with both zips attached.
#
# --dry-run stops after building and packaging: no git or GitHub side effects.
# If the PR merge is blocked (branch protection), the script stops and leaves
# the PR open for a human to merge; nothing is tagged or published.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(dirname -- "$SCRIPT_DIR")"
cd "$ROOT"

log() { printf '[release] %s\n' "$*" >&2; }
die() { printf '[release] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  grep '^# ' "${BASH_SOURCE[0]}" | sed 's/^# //'
  exit "${1:-0}"
}

BUMP=""
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --dry-run) DRY_RUN=true; shift ;;
    patch|minor|major) BUMP="$1"; shift ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$1"; shift ;;
    *) die "unknown argument: $1 (run with --help)" ;;
  esac
done
[[ -n "$BUMP" ]] || usage 1

for cmd in git gh node npm zip jq; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

if [[ "$DRY_RUN" == false ]]; then
  gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not authenticated for github.com (run: gh auth login)"
  [[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || die "must be on main"
  [[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"
  git fetch origin main
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not in sync with origin/main"
fi

# --- version bump ---------------------------------------------------------
npm version --no-git-tag-version "$BUMP" >/dev/null
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
log "releasing $TAG"

restore_bump() {
  git checkout -- package.json 2>/dev/null || true
  [[ -f package-lock.json ]] && git checkout -- package-lock.json 2>/dev/null || true
}

if [[ "$DRY_RUN" == false ]] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  restore_bump
  die "tag $TAG already exists"
fi

# --- build & package ------------------------------------------------------
npm ci
# Fetch the pinned nvim-wasi engine (idempotent: skips when the local copy
# already matches engine.lock.json) so the build has an engine to bundle even
# on a fresh checkout.
npm run fetch-assets
npm run build
[[ -f dist/chromium/manifest.json ]] || { restore_bump; die "build did not produce dist/chromium/manifest.json"; }

# The build stamps dist/chromium/engine-info.json with which engine landed.
# The engine is the pinned nvim-wasi release artifact (the sole engine source);
# assert the marker says so, to defend against a stale or hand-tampered build.
ENGINE_INFO="dist/chromium/engine-info.json"
[[ -f "$ENGINE_INFO" ]] || { restore_bump; die "build did not produce $ENGINE_INFO"; }
ENGINE_SOURCE="$(jq -r '.source' "$ENGINE_INFO" 2>/dev/null)" || { restore_bump; die "could not read .source from $ENGINE_INFO (malformed?)"; }
ENGINE_TAG="$(jq -r '.tag' "$ENGINE_INFO" 2>/dev/null)" || { restore_bump; die "could not read .tag from $ENGINE_INFO (malformed?)"; }
if [[ "$ENGINE_SOURCE" != "nvim-wasi" ]]; then
  restore_bump
  die "engine source '$ENGINE_SOURCE' is not 'nvim-wasi' — build is stale or tampered; rebuild with a fresh \`npm run fetch-assets\` + \`npm run build\`"
fi
log "engine: nvim-wasi $ENGINE_TAG"

ZIP_LATEST="dist/nvim-in-browser-chromium.zip"
ZIP_VERSIONED="dist/nvim-in-browser-chromium-$VERSION.zip"
rm -f "$ZIP_LATEST" "$ZIP_VERSIONED"
(cd dist/chromium && zip -qr "../../$ZIP_VERSIONED" .)
cp "$ZIP_VERSIONED" "$ZIP_LATEST"
log "packaged $ZIP_LATEST and $ZIP_VERSIONED"

# The build also emits dist/firefox (same compiled extension, Firefox-transformed
# manifest). Package it as an .xpi (an .xpi IS just a zip with manifest.json at
# the root) so it can be installed via about:addons -> Install Add-on From File.
[[ -f dist/firefox/manifest.json ]] || { restore_bump; die "build did not produce dist/firefox/manifest.json"; }
FIREFOX_XPI_LATEST="dist/nvim-in-browser-firefox.xpi"
FIREFOX_XPI_VERSIONED="dist/nvim-in-browser-firefox-$VERSION.xpi"
rm -f "$FIREFOX_XPI_LATEST" "$FIREFOX_XPI_VERSIONED"
(cd dist/firefox && zip -qr "../../$FIREFOX_XPI_VERSIONED" .)
cp "$FIREFOX_XPI_VERSIONED" "$FIREFOX_XPI_LATEST"
log "packaged $FIREFOX_XPI_LATEST and $FIREFOX_XPI_VERSIONED"
# The .xpi is UNSIGNED. On Firefox Developer Edition / Nightly / ESR / Unbranded,
# set xpinstall.signatures.required=false in about:config, then install it
# permanently via about:addons -> gear -> Install Add-on From File. (Stock
# release/beta Firefox ignores that pref — there, the .xpi must be AMO-signed
# first; this script does NOT sign to AMO.)
log "NOTE: $FIREFOX_XPI_LATEST is unsigned — install via about:addons on Dev Edition (signatures pref off), or sign at addons.mozilla.org for release Firefox."

if [[ "$DRY_RUN" == true ]]; then
  restore_bump
  log "dry run complete; version bump reverted, no git/GitHub changes made"
  exit 0
fi

# --- branch, PR, merge ----------------------------------------------------
BRANCH="release/$TAG"
git checkout -b "$BRANCH"
git add package.json package-lock.json
git commit -m "chore(release): $TAG"
git push -u origin "$BRANCH"

PR_URL="$(gh pr create \
  --title "chore(release): $TAG" \
  --body "Automated release PR for $TAG. Merging tags $TAG and publishes the GitHub release with the packaged Chromium extension zips." \
  --base main --head "$BRANCH")"
log "opened PR: $PR_URL"

if ! gh pr merge "$BRANCH" --squash --delete-branch; then
  log "merge blocked (branch protection?). PR left open: $PR_URL"
  log "after it merges, finish with: git checkout main && git pull && git tag $TAG && git push origin $TAG"
  exit 2
fi

git checkout main
git pull origin main

# --- tag & release --------------------------------------------------------
git tag "$TAG"
git push origin "$TAG"

gh release create "$TAG" \
  "$ZIP_LATEST" "$ZIP_VERSIONED" "$FIREFOX_XPI_LATEST" "$FIREFOX_XPI_VERSIONED" \
  --title "$TAG" \
  --generate-notes \
  --notes "Chromium: download a chromium zip, unzip it, then load the folder via chrome://extensions -> Load unpacked. Firefox: download the firefox .xpi and install it via about:addons -> gear -> Install Add-on From File (on Firefox Developer Edition / Nightly / ESR, set xpinstall.signatures.required=false in about:config first; the .xpi is unsigned). The .xpi and the chromium zip contain the same compiled extension (only the manifest differs)."

log "published release $TAG"
