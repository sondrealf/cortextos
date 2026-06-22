import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createReminder,
  listReminders,
  ackReminder,
  pruneReminders,
  getOverdueReminders,
  getDueForDispatch,
  markDispatchAttempted,
  markReminderFired,
} from '../../../src/bus/reminders';
import type { BusPaths } from '../../../src/types/index';

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox'),
    inflight: join(dir, 'inflight'),
    processed: join(dir, 'processed'),
    logDir: join(dir, 'logs'),
    stateDir: join(dir, 'state'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
  };
}

describe('reminders', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = join(tmpdir(), `reminders-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    paths = makePaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('createReminder', () => {
    it('creates a reminder with correct fields', () => {
      const fireAt = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, fireAt, 'Run morning briefing');
      expect(r.id).toBeTruthy();
      expect(r.fire_at).toBe(fireAt);
      expect(r.prompt).toBe('Run morning briefing');
      expect(r.status).toBe('pending');
      expect(r.created_at).toBeTruthy();
    });

    it('persists to disk', () => {
      const fireAt = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, fireAt, 'test');
      const reminders = listReminders(paths);
      expect(reminders).toHaveLength(1);
    });

    it('rejects invalid fire_at', () => {
      expect(() => createReminder(paths, 'not-a-date', 'test')).toThrow();
      expect(() => createReminder(paths, '', 'test')).toThrow();
    });

    it('accumulates multiple reminders', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, future, 'first');
      createReminder(paths, future, 'second');
      createReminder(paths, future, 'third');
      expect(listReminders(paths)).toHaveLength(3);
    });
  });

  describe('listReminders', () => {
    it('returns empty array when no reminders exist', () => {
      expect(listReminders(paths)).toEqual([]);
    });

    it('returns only pending by default', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r1 = createReminder(paths, future, 'pending one');
      const r2 = createReminder(paths, future, 'to ack');
      ackReminder(paths, r2.id);

      const pending = listReminders(paths);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(r1.id);
    });

    it('returns all reminders with --all flag', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, future, 'one');
      ackReminder(paths, r.id);

      expect(listReminders(paths, { all: true })).toHaveLength(1);
    });
  });

  describe('getOverdueReminders', () => {
    it('returns nothing when all reminders are in the future', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, future, 'not yet');
      expect(getOverdueReminders(paths)).toHaveLength(0);
    });

    it('returns overdue pending reminders', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      createReminder(paths, past, 'overdue task');
      const overdue = getOverdueReminders(paths);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].prompt).toBe('overdue task');
    });

    it('does not return acked overdue reminders', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'already handled');
      ackReminder(paths, r.id);
      expect(getOverdueReminders(paths)).toHaveLength(0);
    });

    it('returns fired-but-unacked overdue reminders (crash-before-handling re-delivery)', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'fired, never handled');
      markReminderFired(paths.stateDir, r.id);
      const overdue = getOverdueReminders(paths);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].status).toBe('fired');
    });
  });

  describe('getDueForDispatch', () => {
    const BACKOFF = 5 * 60_000;

    it('returns pending reminders past fire_at', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      createReminder(paths, past, 'due now');
      expect(getDueForDispatch(paths.stateDir, BACKOFF)).toHaveLength(1);
    });

    it('excludes future reminders', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, future, 'not yet');
      expect(getDueForDispatch(paths.stateDir, BACKOFF)).toHaveLength(0);
    });

    it('excludes fired and acked reminders', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const fired = createReminder(paths, past, 'already fired');
      markReminderFired(paths.stateDir, fired.id);
      const acked = createReminder(paths, past, 'already acked');
      ackReminder(paths, acked.id);
      expect(getDueForDispatch(paths.stateDir, BACKOFF)).toHaveLength(0);
    });

    it('excludes reminders attempted within the backoff window', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'recently attempted');
      markDispatchAttempted(paths.stateDir, r.id);
      expect(getDueForDispatch(paths.stateDir, BACKOFF)).toHaveLength(0);
    });

    it('includes reminders whose attempt is older than the backoff window', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'stale attempt');
      markDispatchAttempted(paths.stateDir, r.id);
      // Backdate the attempt beyond the backoff window
      const { readFileSync, writeFileSync } = require('fs');
      const { join: pathJoin } = require('path');
      const filePath = pathJoin(paths.stateDir, 'pending-reminders.json');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      data[0].dispatch_attempted_at = new Date(Date.now() - BACKOFF - 1000).toISOString();
      writeFileSync(filePath, JSON.stringify(data, null, 2));
      expect(getDueForDispatch(paths.stateDir, BACKOFF)).toHaveLength(1);
      expect(getDueForDispatch(paths.stateDir, BACKOFF)[0].id).toBe(r.id);
    });
  });

  describe('markDispatchAttempted / markReminderFired', () => {
    it('persists dispatch_attempted_at without changing status', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'attempt me');
      markDispatchAttempted(paths.stateDir, r.id);
      const all = listReminders(paths, { all: true });
      expect(all[0].status).toBe('pending');
      expect(all[0].dispatch_attempted_at).toBeTruthy();
    });

    it('markReminderFired sets status fired with fired_at', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'fire me');
      markReminderFired(paths.stateDir, r.id);
      const all = listReminders(paths, { all: true });
      expect(all[0].status).toBe('fired');
      expect(all[0].fired_at).toBeTruthy();
    });

    it('both throw on unknown id', () => {
      expect(() => markDispatchAttempted(paths.stateDir, 'nope')).toThrow();
      expect(() => markReminderFired(paths.stateDir, 'nope')).toThrow();
    });

    it('ackReminder works on a fired reminder (normal live-dispatch lifecycle)', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'full lifecycle');
      markReminderFired(paths.stateDir, r.id);
      ackReminder(paths, r.id);
      const all = listReminders(paths, { all: true });
      expect(all[0].status).toBe('acked');
    });
  });

  describe('ackReminder', () => {
    it('marks reminder as acked with timestamp', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, future, 'test');
      ackReminder(paths, r.id);

      const all = listReminders(paths, { all: true });
      expect(all[0].status).toBe('acked');
      expect(all[0].acked_at).toBeTruthy();
    });

    it('throws when reminder ID not found', () => {
      expect(() => ackReminder(paths, 'nonexistent-id')).toThrow();
    });
  });

  describe('pruneReminders', () => {
    it('removes acked reminders older than retainDays', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, future, 'old acked');
      ackReminder(paths, r.id);

      // Backdate acked_at to 8 days ago
      const { readFileSync, writeFileSync } = require('fs');
      const { join: pathJoin } = require('path');
      const filePath = pathJoin(paths.stateDir, 'pending-reminders.json');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      data[0].acked_at = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
      writeFileSync(filePath, JSON.stringify(data, null, 2));

      const pruned = pruneReminders(paths, 7);
      expect(pruned).toBe(1);
      expect(listReminders(paths, { all: true })).toHaveLength(0);
    });

    it('keeps pending reminders regardless of age', () => {
      const past = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
      createReminder(paths, past, 'old pending');
      pruneReminders(paths, 7);
      expect(listReminders(paths)).toHaveLength(1);
    });

    it('returns 0 when nothing to prune', () => {
      expect(pruneReminders(paths)).toBe(0);
    });
  });
});
