#!/usr/bin/env bash
# install-spine.sh — install the 12-skill Superpowers orchestration spine into the
# project-bootstrap agent's own .claude/skills/. These skills ARE the /new-project
# phases; they govern HOW bootstrap orchestrates (Layer 1).
#
# COPIES (not symlinks) so the install is self-contained in the gitignored orgs/
# runtime and does not dangle when the shared checkout is on a branch without
# toolkits/ (the vendored dir here remains the source of truth — re-run to re-sync).
#
# Precedence guard: a spine skill is SKIPPED if a skill of that name already exists
# in the destination, or if its name is a cortextOS-native Power-skill name — never
# silently shadow. Idempotent and logged.
#
# Usage:
#   ./install-spine.sh [DEST_SKILLS_DIR]
#   (default DEST = $CTX_FRAMEWORK_ROOT/orgs/sondre-hq/agents/project-bootstrap/.claude/skills
#    or, if unset, the repo-relative path resolved from this script's location)

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/.claude/skills"

REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DEST="${1:-$REPO_ROOT/orgs/sondre-hq/agents/project-bootstrap/.claude/skills}"

SPINE=(brainstorming writing-plans executing-plans subagent-driven-development \
  dispatching-parallel-agents test-driven-development systematic-debugging \
  requesting-code-review receiving-code-review verification-before-completion \
  using-git-worktrees finishing-a-development-branch)

# cortextOS-native Power-skill names the spine must never shadow.
NATIVE=(verify code-review simplify review security-review plan e2e)

mkdir -p "$DEST"
installed=0; skipped=0
for s in "${SPINE[@]}"; do
  # native-collision guard
  for n in "${NATIVE[@]}"; do
    if [[ "$s" == "$n" ]]; then echo "  skip $s (cortextOS-native skill wins)"; skipped=$((skipped+1)); continue 2; fi
  done
  # existing-skill guard (don't clobber a hand-installed skill of the same name)
  if [[ -e "$DEST/$s" && ! -e "$DEST/$s/.spine-managed" ]]; then
    echo "  skip $s (already present, not spine-managed — left untouched)"; skipped=$((skipped+1)); continue
  fi
  rm -rf "$DEST/$s"
  cp -r "$SRC/$s" "$DEST/$s"
  touch "$DEST/$s/.spine-managed"   # marker: safe to overwrite on re-run
  echo "  + $s"
  installed=$((installed+1))
done
echo "spine install: $installed installed, $skipped skipped -> $DEST"
