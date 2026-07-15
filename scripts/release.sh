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
  "$ZIP_LATEST" "$ZIP_VERSIONED" \
  --title "$TAG" \
  --generate-notes \
  --notes "Install: download a zip, unzip it, then load the folder via chrome://extensions -> Load unpacked. Both zips contain the same compiled extension."

log "published release $TAG"
