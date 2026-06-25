import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, completeTask, findTaskFile } from '../../../src/bus/task';
import { checkVerificationRequirement } from '../../../src/cli/bus';
import type { BusPaths, Task } from '../../../src/types';

describe('complete-time verification gate', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-verif-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const readTask = (id: string): Task => JSON.parse(readFileSync(findTaskFile(paths, id)!, 'utf-8'));

  // Helper: write an org context.json with the given flags under <ctxRoot>/orgs/<org>.
  const writeOrgContext = (org: string, flags: Record<string, unknown>) => {
    const dir = join(testDir, 'orgs', org);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.json'), JSON.stringify({ name: org, ...flags }));
  };

  describe('completeTask verification persistence', () => {
    it('stores a verification record with a recorded_at stamp when supplied', () => {
      const id = createTask(paths, 'paul', 'acme', 'Ship feature', { assignee: 'boris' });
      completeTask(paths, id, 'done', {
        e2e_path: 'ran live boot; observed BOOT-SEQUENCE-COMPLETE + heartbeat',
        not_covered: 'no 402 wedge exercised; weak-model path untested',
      });
      const t = readTask(id);
      expect(t.status).toBe('completed');
      expect(t.verification).toBeDefined();
      expect(t.verification!.e2e_path).toMatch(/BOOT-SEQUENCE-COMPLETE/);
      expect(t.verification!.not_covered).toMatch(/402/);
      expect(t.verification!.recorded_at).toBe(t.completed_at);
    });

    it('leaves verification absent when none is supplied (back-compat)', () => {
      const id = createTask(paths, 'paul', 'acme', 'Legacy complete', { assignee: 'boris' });
      completeTask(paths, id, 'done');
      const t = readTask(id);
      expect(t.status).toBe('completed');
      expect(t.verification).toBeUndefined();
    });
  });

  describe('checkVerificationRequirement gate', () => {
    it('allows completion when require_verification is off (default)', () => {
      writeOrgContext('acme', {}); // flag absent
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      expect(checkVerificationRequirement(id, testDir, 'acme', paths.taskDir, false)).toBeNull();
    });

    it('blocks completion when required and not provided and task has no record', () => {
      writeOrgContext('acme', { require_verification: true });
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      const err = checkVerificationRequirement(id, testDir, 'acme', paths.taskDir, false);
      expect(err).not.toBeNull();
      expect(err).toMatch(/require_verification/);
      expect(err).toMatch(/--verify-e2e/);
    });

    it('allows completion when required and provided on this call', () => {
      writeOrgContext('acme', { require_verification: true });
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      expect(checkVerificationRequirement(id, testDir, 'acme', paths.taskDir, true)).toBeNull();
    });

    it('allows completion when required and the task already carries a verification record', () => {
      writeOrgContext('acme', { require_verification: true });
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      // Pre-attach a verification record (e.g. a re-completion of an already-verified task).
      const file = findTaskFile(paths, id)!;
      const t: Task = JSON.parse(readFileSync(file, 'utf-8'));
      t.verification = { e2e_path: 'x', not_covered: 'y', recorded_at: '2026-06-25T00:00:00Z' };
      writeFileSync(file, JSON.stringify(t));
      expect(checkVerificationRequirement(id, testDir, 'acme', paths.taskDir, false)).toBeNull();
    });

    it('allows completion when org context.json is missing (cannot read config — fail open)', () => {
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      // no writeOrgContext call → no context.json
      expect(checkVerificationRequirement(id, testDir, 'acme', paths.taskDir, false)).toBeNull();
    });

    it('rejects a traversal task id before any file access', () => {
      writeOrgContext('acme', { require_verification: true });
      expect(() => checkVerificationRequirement('../../etc/passwd', testDir, 'acme', paths.taskDir, false)).toThrow(/Invalid task id/);
    });
  });
});
