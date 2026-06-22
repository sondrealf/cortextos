import { execSync } from 'child_process';

/**
 * Base-drift guard (theta S3 deliverable).
 *
 * A "queued" / parked feature branch awaiting merge is only safe to fast-forward
 * if its merge-base with main is still main's current HEAD. Once main advances,
 * the branch base drifts and the branch must be rebased before merge — otherwise
 * a "clean FF" assumption is wrong. This module surfaces that drift on demand.
 */

export interface BranchDrift {
  branch: string;
  /** merge-base of the branch and main (short sha), or null if unresolved */
  base: string | null;
  /** number of commits main has gained since the merge-base */
  behind: number;
  drifted: boolean;
  error?: string;
}

export interface BranchDriftReport {
  status: 'ok' | 'error';
  mainRef: string;
  /** main HEAD short sha */
  mainHead?: string;
  branches: BranchDrift[];
  driftedCount: number;
  error?: string;
  hint?: string;
}

function git(repoDir: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 30000,
  }).trim();
}

/**
 * Compare each branch's merge-base against main HEAD and flag drift.
 *
 * @param repoDir   working tree to inspect
 * @param branches  branch names to check; if empty, all local heads except mainRef
 * @param mainRef   the integration ref to measure against (default "main")
 */
export function checkBranchDrift(
  repoDir: string,
  branches: string[] = [],
  mainRef = 'main',
): BranchDriftReport {
  // Must be a git repo
  try {
    git(repoDir, 'rev-parse --is-inside-work-tree');
  } catch {
    return { status: 'error', mainRef, branches: [], driftedCount: 0, error: 'not a git repository' };
  }

  // Resolve main HEAD
  let mainHeadFull: string;
  try {
    mainHeadFull = git(repoDir, `rev-parse ${mainRef}`);
  } catch {
    return {
      status: 'error',
      mainRef,
      branches: [],
      driftedCount: 0,
      error: `failed to resolve main ref '${mainRef}'`,
      hint: `Pass --main <ref> if your integration branch is not '${mainRef}'`,
    };
  }
  const mainHead = mainHeadFull.slice(0, 7);

  // Auto-discover local branches when none specified
  let targets = branches;
  if (targets.length === 0) {
    try {
      const all = git(repoDir, "for-each-ref --format='%(refname:short)' refs/heads/")
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean);
      targets = all.filter((b) => b !== mainRef);
    } catch {
      return { status: 'error', mainRef, mainHead, branches: [], driftedCount: 0, error: 'failed to enumerate local branches' };
    }
  }

  const results: BranchDrift[] = targets.map((branch) => {
    let baseFull: string;
    try {
      baseFull = git(repoDir, `merge-base ${mainRef} ${branch}`);
    } catch {
      return { branch, base: null, behind: 0, drifted: false, error: `unknown or unmergeable branch '${branch}'` };
    }
    const drifted = baseFull !== mainHeadFull;
    let behind = 0;
    if (drifted) {
      try {
        behind = parseInt(git(repoDir, `rev-list --count ${baseFull}..${mainHeadFull}`), 10) || 0;
      } catch {
        behind = 0;
      }
    }
    return { branch, base: baseFull.slice(0, 7), behind, drifted };
  });

  return {
    status: 'ok',
    mainRef,
    mainHead,
    branches: results,
    driftedCount: results.filter((r) => r.drifted).length,
  };
}

/** Human-readable one-line-per-branch rendering for the CLI. */
export function formatBranchDrift(report: BranchDriftReport): string {
  if (report.status === 'error') {
    return `error: ${report.error}${report.hint ? `\nhint: ${report.hint}` : ''}`;
  }
  const lines: string[] = [`main (${report.mainRef}) @ ${report.mainHead}`];
  if (report.branches.length === 0) {
    lines.push('  (no branches to check)');
    return lines.join('\n');
  }
  for (const b of report.branches) {
    if (b.error) {
      lines.push(`  ✗ ${b.branch} — ${b.error}`);
    } else if (b.drifted) {
      lines.push(`  ⚠ ${b.branch} — DRIFTED: base ${b.base}, ${b.behind} commit(s) behind main — rebase before merge`);
    } else {
      lines.push(`  ✓ ${b.branch} — current (base = main HEAD)`);
    }
  }
  lines.push(
    report.driftedCount === 0
      ? 'All branches current — no base-drift.'
      : `${report.driftedCount} branch(es) drifted from main HEAD.`,
  );
  return lines.join('\n');
}
