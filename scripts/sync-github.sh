#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOG_DIR="$HOME/.local/state/carrot-home-git-sync"
LOG_FILE="$LOG_DIR/sync.log"
MAX_LOG_BYTES=524288
LOCK_DIR="/tmp/carrot-home-git-sync.lock"

mkdir -p "$LOG_DIR"
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE="$(wc -c < "$LOG_FILE" | tr -d '[:space:]')"
  if [ "${LOG_SIZE:-0}" -ge "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
fi

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  local old_pid=""
  if [ -f "$LOCK_DIR/pid" ]; then
    old_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi

  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log "Another sync process (PID $old_pid) is already running; skipping."
    exit 0
  fi

  log "Cleaning up stale sync lock."
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  log "ERROR: Failed to acquire lock at $LOCK_DIR."
  exit 1
}

cleanup() {
  rm -rf "$LOCK_DIR"
}

acquire_lock
trap cleanup EXIT

export GIT_SSH_COMMAND="ssh -i \"$HOME/.ssh/id_ed25519\" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"

cd "$REPO_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "ERROR: $REPO_DIR is not inside a Git work tree."
  exit 1
fi

GIT_DIR_RESOLVED="$(git rev-parse --git-dir)"
if [ -d "$GIT_DIR_RESOLVED/rebase-merge" ] || [ -d "$GIT_DIR_RESOLVED/rebase-apply" ] || [ -f "$GIT_DIR_RESOLVED/MERGE_HEAD" ]; then
  log "WARNING: Repository has an in-progress merge or rebase; skipping sync to preserve state."
  exit 1
fi

BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [ -z "$BRANCH" ]; then
  log "WARNING: Repository is in detached HEAD state; skipping sync."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  if ! git diff --cached --quiet; then
    CARROT_HOME_AUTO_SYNC=1 git commit -m "chore(sync): auto-sync $(date '+%Y-%m-%d %H:%M:%S')" >/dev/null
    NEW_SHA="$(git rev-parse --short HEAD)"
    log "Committed local changes on '$BRANCH' ($NEW_SHA)."
  fi
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  log "Remote 'origin' is not configured yet; local backup complete, skipping push."
  exit 0
fi

log "Fetching origin for '$BRANCH'..."
git fetch origin

if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  COUNTS="$(git rev-list --left-right --count "HEAD...origin/$BRANCH")"
  AHEAD="$(printf '%s\n' "$COUNTS" | awk '{print $1}')"
  BEHIND="$(printf '%s\n' "$COUNTS" | awk '{print $2}')"

  if [ "$BEHIND" -gt 0 ]; then
    log "Local '$BRANCH' is behind origin/$BRANCH by $BEHIND commit(s); rebasing..."
    if ! git rebase "origin/$BRANCH"; then
      git rebase --abort >/dev/null 2>&1 || true
      log "ERROR: Rebase conflict against origin/$BRANCH; rebase aborted. Manual resolution required."
      exit 1
    fi
  elif [ "$AHEAD" -eq 0 ]; then
    log "Already up to date with origin/$BRANCH."
    exit 0
  fi
fi

git push -u origin "$BRANCH"
log "Successfully pushed '$BRANCH' to origin/$BRANCH."
