# Dev Branch Hygiene

Internal workflow guide for branch lifecycle and cleanup verification in cortextOS repos.

---

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<description>` | `feat/bus-auto-emit` |
| Fix | `fix/<description>` | `fix/analytics-crash` |
| Chore | `chore/<description>` | `chore/bump-deps` |
| Agent branch | `<agent>/<description>` | `sondre/main` |

---

## Standard Dev Workflow

1. **Branch from sondre/main** (not upstream main directly)
   ```bash
   git checkout sondre/main
   git checkout -b feat/my-feature
   ```

2. **Commit atomically** — one logical change per commit, conventional-commit style
   ```
   feat(scope): short description
   fix(scope): short description
   chore(scope): short description
   ```

3. **Land on sondre/main** via fast-forward or rebase (no merge commits)
   ```bash
   git checkout sondre/main
   git rebase feat/my-feature   # or cherry-pick individual commits
   ```

4. **Delete the branch locally AND remotely**
   ```bash
   git branch -d feat/my-feature
   git push origin --delete feat/my-feature
   ```

5. **Verify remote deletion** (do not skip)
   ```bash
   scripts/verify-branch-cleanup.sh /root/cortextos feat/my-feature
   ```

---

## Branch Cleanup Verification

After any bulk branch deletion, always verify the remote — local deletion does not guarantee remote deletion.

```bash
# Single branch
scripts/verify-branch-cleanup.sh <repo-path> <branch-name>

# Multiple branches
scripts/verify-branch-cleanup.sh <repo-path> branch-a branch-b branch-c

# No branch list — prints all current remote branches
scripts/verify-branch-cleanup.sh <repo-path>
```

Exit 0 = clean. Exit 1 = leaked branches found (with names printed to stderr).

**Why this exists**: 2026-05-21 branch cleanup claimed "remote deleted" but only deleted locally. `git ls-remote --heads origin` caught the gap manually — this script automates that check. See feedback memory `feedback_branch_cleanup_verify_remote.md`.

---

## sondre/main Conventions

- All agent work lands here before any upstream PR
- Rebase onto upstream/main before opening PRs (keep history linear)
- Force-push to `origin/sondre/main` is expected and allowed
- PRs to upstream use `sondre/main` as the source branch

---

## Stale Branch Detection

```bash
# Branches merged into sondre/main but not deleted
git branch --merged sondre/main | grep -v 'sondre/main\|main\|master'

# Remote branches with no local tracking ref
git remote prune origin --dry-run
```