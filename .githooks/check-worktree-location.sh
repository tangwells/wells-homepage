#!/bin/sh
set -eu

if [ "$#" -eq 3 ]; then
  ROOT=$1
  GIT_DIR=$2
  GIT_COMMON_DIR=$3
else
  ROOT=$(git rev-parse --show-toplevel)
  GIT_DIR=$(git rev-parse --path-format=absolute --git-dir)
  GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir)
fi

# Allow the primary working tree (where git-dir equals git-common-dir).
if [ "$GIT_DIR" = "$GIT_COMMON_DIR" ]; then
  exit 0
fi

# Resolve physical path when the directory exists to catch symlinks into iCloud.
if [ -d "$ROOT" ]; then
  REAL_ROOT=$(CDPATH= cd -- "$ROOT" && pwd -P)
else
  REAL_ROOT=$ROOT
fi

case "$REAL_ROOT" in
  "$HOME/Library/Mobile Documents"|"$HOME/Library/Mobile Documents/"*|*/Library/Mobile\ Documents|*/Library/Mobile\ Documents/*)
    cat >&2 <<EOF
BLOCKED: Linked git worktree must not be placed inside iCloud Drive:
  $REAL_ROOT

Create linked worktrees outside iCloud instead, e.g.:
  git worktree add /tmp/carrot-home-worktrees/<name> -b <branch> <base>

If this worktree was just created, remove it immediately:
  git worktree remove --force "$REAL_ROOT"
EOF
    exit 1
    ;;
esac

exit 0
