#!/usr/bin/env bash
# Verifies that branches expected to be deleted are gone from the remote.
# Usage: verify-branch-cleanup.sh <repo-path> [branch1 branch2 ...]
# Exit 0 = all clean. Exit 1 = leaked branches found.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <repo-path> [branch1 branch2 ...]" >&2
  exit 2
fi

REPO="$1"
shift
EXPECTED_DELETED=("$@")

if [[ ! -d "$REPO/.git" ]]; then
  echo "Error: $REPO is not a git repository" >&2
  exit 2
fi

cd "$REPO"

echo "Fetching + pruning remotes..."
git fetch --prune origin

REMOTE_BRANCHES=$(git ls-remote --heads origin | awk '{print $2}' | sed 's|refs/heads/||')

if [[ ${#EXPECTED_DELETED[@]} -eq 0 ]]; then
  echo "No branch list provided — printing all remote branches:"
  echo "$REMOTE_BRANCHES"
  exit 0
fi

LEAKED=()
for branch in "${EXPECTED_DELETED[@]}"; do
  if echo "$REMOTE_BRANCHES" | grep -qx "$branch"; then
    LEAKED+=("$branch")
  fi
done

if [[ ${#LEAKED[@]} -eq 0 ]]; then
  echo "OK — all ${#EXPECTED_DELETED[@]} expected-deleted branch(es) are gone from remote."
  exit 0
else
  echo "LEAKED — ${#LEAKED[@]} branch(es) still exist on remote:" >&2
  for b in "${LEAKED[@]}"; do
    echo "  origin/$b" >&2
  done
  exit 1
fi
