import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkBranchDrift, formatBranchDrift } from '../../../src/bus/branches.js';

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function commit(dir: string, name: string): string {
  writeFileSync(join(dir, name), name);
  git(dir, `add ${name}`);
  git(dir, `commit -m ${name} --no-gpg-sign`);
  return git(dir, 'rev-parse HEAD');
}

describe('checkBranchDrift', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cortextos-drift-test-'));
    git(repo, 'init -q');
    git(repo, 'config user.email test@test.dev');
    git(repo, 'config user.name test');
    git(repo, 'config commit.gpgsign false');
    git(repo, 'checkout -q -b main');
    commit(repo, 'base');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports a branch cut from current main HEAD as not drifted', () => {
    git(repo, 'checkout -q -b feature');
    commit(repo, 'feature-work');
    git(repo, 'checkout -q main');

    const report = checkBranchDrift(repo, ['feature']);
    expect(report.status).toBe('ok');
    expect(report.driftedCount).toBe(0);
    expect(report.branches[0].drifted).toBe(false);
    expect(report.branches[0].behind).toBe(0);
  });

  it('flags a branch whose base lags behind main HEAD', () => {
    // cut feature from base, then advance main twice
    git(repo, 'checkout -q -b feature');
    commit(repo, 'feature-work');
    git(repo, 'checkout -q main');
    commit(repo, 'main-advance-1');
    commit(repo, 'main-advance-2');

    const report = checkBranchDrift(repo, ['feature']);
    expect(report.driftedCount).toBe(1);
    expect(report.branches[0].drifted).toBe(true);
    expect(report.branches[0].behind).toBe(2);
  });

  it('clears drift after the branch is rebased onto main', () => {
    git(repo, 'checkout -q -b feature');
    commit(repo, 'feature-work');
    git(repo, 'checkout -q main');
    commit(repo, 'main-advance');
    git(repo, 'checkout -q feature');
    git(repo, 'rebase -q main');
    git(repo, 'checkout -q main');

    const report = checkBranchDrift(repo, ['feature']);
    expect(report.driftedCount).toBe(0);
    expect(report.branches[0].drifted).toBe(false);
  });

  it('auto-discovers all local branches except main when none are passed', () => {
    git(repo, 'checkout -q -b alpha');
    commit(repo, 'alpha-work');
    git(repo, 'checkout -q main');
    git(repo, 'checkout -q -b beta');
    commit(repo, 'beta-work');
    git(repo, 'checkout -q main');

    const report = checkBranchDrift(repo);
    const names = report.branches.map((b) => b.branch).sort();
    expect(names).toEqual(['alpha', 'beta']);
    expect(report.driftedCount).toBe(0);
  });

  it('honors a custom main ref', () => {
    git(repo, 'checkout -q -b sondre-main');
    commit(repo, 'sondre-work');
    git(repo, 'checkout -q -b feature');
    commit(repo, 'feature-work');
    git(repo, 'checkout -q sondre-main');
    commit(repo, 'sondre-advance');

    const report = checkBranchDrift(repo, ['feature'], 'sondre-main');
    expect(report.mainRef).toBe('sondre-main');
    expect(report.branches[0].drifted).toBe(true);
    expect(report.branches[0].behind).toBe(1);
  });

  it('records an error for an unknown branch without throwing', () => {
    const report = checkBranchDrift(repo, ['does-not-exist']);
    expect(report.status).toBe('ok');
    expect(report.branches[0].error).toMatch(/unknown or unmergeable/);
    expect(report.branches[0].drifted).toBe(false);
  });

  it('errors on a non-git directory', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'cortextos-nonrepo-'));
    try {
      const report = checkBranchDrift(nonRepo, ['x']);
      expect(report.status).toBe('error');
      expect(report.error).toMatch(/not a git repository/);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('errors when the main ref cannot be resolved', () => {
    const report = checkBranchDrift(repo, ['x'], 'nonexistent-ref');
    expect(report.status).toBe('error');
    expect(report.error).toMatch(/failed to resolve main ref/);
  });
});

describe('formatBranchDrift', () => {
  it('renders drifted, current, and error branches distinctly', () => {
    const out = formatBranchDrift({
      status: 'ok',
      mainRef: 'main',
      mainHead: 'abc1234',
      driftedCount: 1,
      branches: [
        { branch: 'good', base: 'abc1234', behind: 0, drifted: false },
        { branch: 'stale', base: 'def5678', behind: 3, drifted: true },
        { branch: 'bad', base: null, behind: 0, drifted: false, error: 'unknown or unmergeable branch' },
      ],
    });
    expect(out).toContain('✓ good');
    expect(out).toContain('⚠ stale');
    expect(out).toContain('3 commit(s) behind');
    expect(out).toContain('✗ bad');
    expect(out).toContain('1 branch(es) drifted');
  });

  it('renders an error report', () => {
    const out = formatBranchDrift({
      status: 'error',
      mainRef: 'main',
      branches: [],
      driftedCount: 0,
      error: 'not a git repository',
    });
    expect(out).toMatch(/^error: not a git repository/);
  });
});
