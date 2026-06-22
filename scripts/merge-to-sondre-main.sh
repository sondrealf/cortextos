#!/usr/bin/env bash
#
# merge-to-sondre-main.sh — the ONE sanctioned way to land a feature branch on
# the integration branch (sondre/main on origin = github.com/sondrealf/cortextos).
#
# Policy (Sondre-confirmed 2026-06-22, commander task_1782136354982):
#   - Merge with --no-ff so every change shows as a real merge commit in history.
#   - On a CLEAN merge + push, auto-delete the source branch (local + remote).
#   - NEVER delete a protected branch (sondre/main, main, or any work-bearing keep).
#   - Fail closed: any conflict / non-clean state aborts and deletes nothing.
#
# Usage:
#   scripts/merge-to-sondre-main.sh <source-branch> ["merge commit message"]
#
# Example:
#   scripts/merge-to-sondre-main.sh fix/my-thing "fix(x): land my thing"
#
set -euo pipefail

REMOTE="origin"
INTEGRATION="sondre/main"

SRC="${1:-}"
MSG="${2:-}"
if [ -z "$SRC" ]; then
  echo "usage: $0 <source-branch> [\"merge message\"]" >&2
  exit 2
fi

# --- Guards: never operate ON or delete a protected branch -------------------
case "$SRC" in
  sondre/main|main|\
  fix/restart-verification-and-operator-crash-routing|\
  fix/stallobserver-loop-breaker-escalation|\
  fix/crash-alert-halt-operator-routing|\
  feat/credential-reaper|\
  dev/analyst-template-event-paths|\
  fix/list-tasks-id-truncation|\
  fix/remove-bot-token-stub-secrets-env)
    echo "REFUSED: '$SRC' is a protected branch — not a merge source." >&2
    exit 3 ;;
esac

# --- Pre-flight: clean tree -------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: working tree not clean. Commit/stash first." >&2
  exit 4
fi

echo ">> fetching $REMOTE …"
git fetch "$REMOTE" --prune

# Resolve the source tip (prefer the remote ref so we merge what's pushed).
if git rev-parse --verify --quiet "$REMOTE/$SRC" >/dev/null; then
  SRC_REF="$REMOTE/$SRC"
elif git rev-parse --verify --quiet "$SRC" >/dev/null; then
  SRC_REF="$SRC"
else
  echo "REFUSED: source branch '$SRC' not found locally or on $REMOTE." >&2
  exit 5
fi

echo ">> checking out $INTEGRATION and fast-forwarding to $REMOTE/$INTEGRATION …"
git checkout "$INTEGRATION"
git merge --ff-only "$REMOTE/$INTEGRATION"

[ -z "$MSG" ] && MSG="Merge branch '$SRC' into $INTEGRATION"

echo ">> merging $SRC_REF --no-ff …"
if ! git merge --no-ff -m "$MSG" "$SRC_REF"; then
  echo "MERGE CONFLICT — aborting, NOTHING deleted." >&2
  git merge --abort || true
  exit 6
fi

echo ">> pushing $INTEGRATION …"
git push "$REMOTE" "$INTEGRATION"

# --- Verify the push landed before deleting anything ------------------------
LOCAL_TIP=$(git rev-parse "$INTEGRATION")
REMOTE_TIP=$(git ls-remote "$REMOTE" "refs/heads/$INTEGRATION" | cut -f1)
if [ "$LOCAL_TIP" != "$REMOTE_TIP" ]; then
  echo "PUSH NOT CONFIRMED ($LOCAL_TIP != $REMOTE_TIP) — NOT deleting source." >&2
  exit 7
fi

echo ">> push confirmed. Deleting source branch '$SRC' (local + remote) …"
git branch -d "$SRC" 2>/dev/null && echo "   local '$SRC' deleted" || echo "   (no local '$SRC' to delete)"
if git ls-remote --exit-code --heads "$REMOTE" "$SRC" >/dev/null 2>&1; then
  git push "$REMOTE" --delete "$SRC" && echo "   remote '$SRC' deleted"
else
  echo "   (no remote '$SRC' to delete)"
fi

echo "DONE: '$SRC' merged into $INTEGRATION (--no-ff), pushed, and removed."
