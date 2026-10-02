#!/usr/bin/env bash
#
# build-routstrd.sh — build ../routstrd against the SDK checkout you run this from.
#
# Works both in the main repo and inside any of its worktrees
# (.worktrees/*). Run it from anywhere inside the checkout (repo root,
# worktree root, or a subdirectory):
#
#   ./scripts/build-routstrd.sh                     (from repo/worktree root)
#   bun run scripts/build-routstrd.sh               (or via bun)
#
# What it does:
#   1. Resolves the SDK checkout it was run from (this repo or the worktree)
#   2. Builds the SDK (routstrd resolves @routstr/sdk via dist/, which
#      fresh worktrees don't have yet)
#   3. Points routstrd's "@routstr/sdk" dependency at this checkout
#      (file://<absolute path to the checkout>)
#   4. Runs `bun i && bun run build:binary` inside ../routstrd
#   5. Restores routstrd's package.json (and bun.lock) to their prior state
#      — even if the build fails or you Ctrl-C
#
# Env:
#   SKIP_SDK_BUILD=1  skip building the SDK (use its dist/ as-is)
#
# Note: routstrd's node_modules/@routstr/sdk is left pointing at this
# checkout after the script finishes (the built binary needs it); the next
# `bun i` in routstrd with the restored package.json re-resolves it.

set -euo pipefail

# ── 1. Locate the SDK checkout (walk up from $PWD) ─────────────────────────
find_sdk_dir() {
  local dir="$PWD"
  while true; do
    if [ -f "$dir/package.json" ] && grep -q '"name": "@routstr/sdk"' "$dir/package.json"; then
      printf '%s\n' "$dir"
      return 0
    fi
    [ "$dir" = "/" ] && return 1
    dir="$(dirname "$dir")"
  done
}

if ! SDK_DIR="$(find_sdk_dir)"; then
  echo "error: run this from inside the routstr-sdk repo or one of its worktrees" >&2
  exit 1
fi
SDK_DIR="$(cd "$SDK_DIR" && pwd)"
echo "SDK checkout: $SDK_DIR"

# ── 2. Locate routstrd (sibling of the MAIN repo, not of the worktree) ────
# Worktrees live in <main>/.worktrees/<name>; routstrd lives next to <main>.
# git-common-dir points at the main repo's .git, so its parent is the main repo.
COMMON_DIR="$(git -C "$SDK_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
case "$COMMON_DIR" in
  /*) GIT_DIR="$COMMON_DIR" ;;
  ""|.) GIT_DIR="$SDK_DIR/.git" ;;
  *) GIT_DIR="$SDK_DIR/$COMMON_DIR" ;;
esac
MAIN_DIR="$(cd "$GIT_DIR/.." && pwd)"
ROUTSTRD_DIR="$MAIN_DIR/../routstrd"

if [ ! -f "$ROUTSTRD_DIR/package.json" ]; then
  echo "error: $ROUTSTRD_DIR not found — expected routstrd next to the main repo" >&2
  exit 1
fi
echo "routstrd:     $ROUTSTRD_DIR"

# ── 3. Build the SDK (dist/ must exist for routstrd to resolve imports) ───
if [ "${SKIP_SDK_BUILD:-0}" != "1" ]; then
  echo "==> Building SDK in $SDK_DIR"
  (
    cd "$SDK_DIR"
    [ -d node_modules ] || pnpm install
    pnpm build
  )
else
  echo "==> Skipping SDK build (SKIP_SDK_BUILD=1)"
fi

# ── 4. Point routstrd at this checkout, build, restore ────────────────────
ROUTSTRD_PKG="$ROUTSTRD_DIR/package.json"
ROUTSTRD_LOCK="$ROUTSTRD_DIR/bun.lock"

# Back up package.json and bun.lock, restore them on exit (incl. failure/Ctrl-C)
PKG_BACKUP="$(mktemp)"
LOCK_BACKUP=""
LOCK_WAS_MISSING=0
if [ -f "$ROUTSTRD_LOCK" ]; then
  LOCK_BACKUP="$(mktemp)"
  cp "$ROUTSTRD_LOCK" "$LOCK_BACKUP"
else
  LOCK_WAS_MISSING=1
fi
cp "$ROUTSTRD_PKG" "$PKG_BACKUP"

restore() {
  rm -f "$ROUTSTRD_LOCK"   # bun i may create/modify it; restore below
  mv -f "$PKG_BACKUP" "$ROUTSTRD_PKG"
  if [ -n "$LOCK_BACKUP" ]; then
    mv -f "$LOCK_BACKUP" "$ROUTSTRD_LOCK"
  fi
  echo "==> Restored $ROUTSTRD_PKG (and bun.lock)"
}
trap restore EXIT

# Update the @routstr/sdk dependency to file://<this checkout>
node -e '
const fs = require("fs");
const [file, dep, value] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
if (!pkg.dependencies || !(dep in pkg.dependencies)) {
  console.error(`error: ${dep} not found in ${file} dependencies`);
  process.exit(1);
}
pkg.dependencies[dep] = value;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
console.log(`==> Pointed ${dep} at ${value}`);
' "$ROUTSTRD_PKG" "@routstr/sdk" "file://$SDK_DIR"

echo "==> bun i && bun run build:binary in $ROUTSTRD_DIR"
cd "$ROUTSTRD_DIR"
bun i
bun run build:binary

echo "==> Done: $ROUTSTRD_DIR/dist/routstrd built against $SDK_DIR"
