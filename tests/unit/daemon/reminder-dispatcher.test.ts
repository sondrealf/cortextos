import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ReminderDispatcher } from '../../../src/daemon/reminder-dispatcher';
import { createReminder, type Reminder } from '../../../src/bus/reminders';
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
  } as BusPaths;
}

function readStore(stateDir: string): Reminder[] {
  return JSON.parse(readFileSync(join(stateDir, 'pending-reminders.json'), 'utf-8'));
}

describe('ReminderDispatcher', () => {
  let testDir: string;
  let paths: BusPaths;
  let stateDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `reminder-dispatcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    paths = makePaths(testDir);
    stateDir = paths.stateDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeDispatcher(onFire: (r: Reminder) => Promise<void> | void) {
    return new ReminderDispatcher({
      agentName: 'test-agent',
      stateDir,
      onFire,
      logger: () => {},
    });
  }

  it('fires a due pending reminder and marks it fired', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const r = createReminder(paths, past, 'do the thing');
    const fired: Reminder[] = [];
    const d = makeDispatcher(rem => { fired.push(rem); });

    await d.tick();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(r.id);
    const store = readStore(stateDir);
    expect(store[0].status).toBe('fired');
    expect(store[0].fired_at).toBeTruthy();
    expect(store[0].dispatch_attempted_at).toBeTruthy();
  });

  it('does not fire future reminders', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    createReminder(paths, future, 'later');
    const onFire = vi.fn();
    const d = makeDispatcher(onFire);

    await d.tick();

    expect(onFire).not.toHaveBeenCalled();
    expect(readStore(stateDir)[0].status).toBe('pending');
  });

  it('does not re-fire an already-fired reminder on subsequent ticks', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'once only');
    const onFire = vi.fn();
    const d = makeDispatcher(onFire);

    await d.tick();
    await d.tick();
    await d.tick();

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('leaves the reminder pending when injection throws (retry via backoff + boot fallback)', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'agent is down');
    const onFire = vi.fn(() => { throw new Error('injectAgent returned false'); });
    const d = makeDispatcher(onFire);

    await d.tick();

    expect(onFire).toHaveBeenCalledTimes(1);
    const store = readStore(stateDir);
    expect(store[0].status).toBe('pending');
    expect(store[0].dispatch_attempted_at).toBeTruthy();
    expect(store[0].fired_at).toBeUndefined();
  });

  it('does not re-attempt a failed reminder within the backoff window', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'failing');
    const onFire = vi.fn(() => { throw new Error('boom'); });
    const d = makeDispatcher(onFire);

    await d.tick();
    await d.tick(); // immediately after — inside RETRY_BACKOFF_MS

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('fires multiple due reminders in one tick', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'first');
    createReminder(paths, past, 'second');
    const onFire = vi.fn();
    const d = makeDispatcher(onFire);

    await d.tick();

    expect(onFire).toHaveBeenCalledTimes(2);
    const store = readStore(stateDir);
    expect(store.every(r => r.status === 'fired')).toBe(true);
  });

  it('a failure on one reminder does not block others in the same tick', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const bad = createReminder(paths, past, 'will fail');
    const good = createReminder(paths, past, 'will succeed');
    const d = makeDispatcher(rem => {
      if (rem.id === bad.id) throw new Error('nope');
    });

    await d.tick();

    const store = readStore(stateDir);
    const badRow = store.find(r => r.id === bad.id)!;
    const goodRow = store.find(r => r.id === good.id)!;
    expect(badRow.status).toBe('pending');
    expect(goodRow.status).toBe('fired');
  });

  it('tolerates a missing reminder store (no file → no-op)', async () => {
    const onFire = vi.fn();
    const d = makeDispatcher(onFire);
    await expect(d.tick()).resolves.toBeUndefined();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('start() is idempotent and stop() clears the interval', () => {
    vi.useFakeTimers();
    try {
      const onFire = vi.fn();
      const d = makeDispatcher(onFire);
      d.start();
      d.start(); // ignored
      d.stop();
      // After stop, advancing time must not tick
      const past = new Date(Date.now() - 1000).toISOString();
      createReminder(paths, past, 'never fired');
      vi.advanceTimersByTime(ReminderDispatcher.TICK_INTERVAL_MS * 3);
      expect(onFire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips overlapping ticks while a dispatch is in flight', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createReminder(paths, past, 'slow fire');
    let resolveFire!: () => void;
    const gate = new Promise<void>(res => { resolveFire = res; });
    const onFire = vi.fn(() => gate);
    const d = makeDispatcher(onFire);

    const first = d.tick();   // blocks on gate
    const second = d.tick();  // must no-op (re-entry guard)
    await second;
    expect(onFire).toHaveBeenCalledTimes(1);

    resolveFire();
    await first;
    expect(readStore(stateDir)[0].status).toBe('fired');
  });
});
