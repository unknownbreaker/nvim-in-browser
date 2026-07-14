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

for cmd in git gh node npm zip; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

# The built dist embeds the unlicensed nvim-wasm engine binaries, so any release
# would attach them. Refuse to run unless explicitly overridden.
if [[ "${ALLOW_UNLICENSED_ENGINE:-}" != "1" ]]; then
  die "dist embeds nvim-wasm engine assets with no upstream license (see README 'Third-party engine'); repo+releases must stay private. Set ALLOW_UNLICENSED_ENGINE=1 to proceed."
fi

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
