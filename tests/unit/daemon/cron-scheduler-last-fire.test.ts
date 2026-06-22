/**
 * tests/unit/daemon/cron-scheduler-last-fire.test.ts
 *
 * Unit coverage for CronScheduler.getLastFireMs() — the StallObserver snapshot
 * builder's one non-trivial live-state read. It must return the MOST RECENT fire
 * across all of an agent's crons, drawn from the same persisted sources
 * loadCrons() uses for catch-up: crons.json.last_fired_at,
 * crons.json.last_fire_attempted_at (set pre-onFire, so an injected-but-unhonored
 * beat — the stall case — still counts as a fire), and cron-state.json.last_fire.
 *
 * Disk I/O is mocked so the test is hermetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadCronsWithStatus = vi.fn();
const mockReadCronState = vi.fn();

vi.mock('../../../src/bus/crons.js', () => ({
  readCronsWithStatus: (...a: unknown[]) => mockReadCronsWithStatus(...a),
  updateCron: vi.fn(),
}));
vi.mock('../../../src/bus/cron-state.js', () => ({
  readCronState: (...a: unknown[]) => mockReadCronState(...a),
  parseDurationMs: () => NaN,
}));

import { CronScheduler } from '../../../src/daemon/cron-scheduler';

function scheduler() {
  return new CronScheduler({ agentName: 'dev', onFire: async () => {}, logger: () => {} });
}

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  mockReadCronsWithStatus.mockReset();
  mockReadCronState.mockReset();
});

describe('CronScheduler.getLastFireMs', () => {
  it('returns null when no cron has ever fired', () => {
    mockReadCronsWithStatus.mockReturnValue({ crons: [{ name: 'heartbeat', enabled: true }], corrupt: false });
    mockReadCronState.mockReturnValue({ crons: [] });
    expect(scheduler().getLastFireMs()).toBeNull();
  });

  it('returns the MAX fire time across crons.json last_fired_at + last_fire_attempted_at', () => {
    mockReadCronsWithStatus.mockReturnValue({
      crons: [
        { name: 'heartbeat', enabled: true, last_fired_at: iso(1_000) },
        { name: 'daily', enabled: true, last_fired_at: iso(5_000), last_fire_attempted_at: iso(9_000) },
      ],
      corrupt: false,
    });
    mockReadCronState.mockReturnValue({ crons: [] });
    // last_fire_attempted_at (9_000) is the most recent fire signal — and is
    // exactly the stall case: a beat was injected (attempted) but unhonored.
    expect(scheduler().getLastFireMs()).toBe(9_000);
  });

  it('includes cron-state.json last_fire in the max', () => {
    mockReadCronsWithStatus.mockReturnValue({
      crons: [{ name: 'heartbeat', enabled: true, last_fired_at: iso(2_000) }],
      corrupt: false,
    });
    mockReadCronState.mockReturnValue({ crons: [{ name: 'heartbeat', last_fire: iso(7_500) }] });
    expect(scheduler().getLastFireMs()).toBe(7_500);
  });

  it('survives an unparseable crons.json (falls back to cron-state)', () => {
    mockReadCronsWithStatus.mockImplementation(() => { throw new Error('corrupt'); });
    mockReadCronState.mockReturnValue({ crons: [{ name: 'heartbeat', last_fire: iso(3_300) }] });
    expect(scheduler().getLastFireMs()).toBe(3_300);
  });

  it('ignores invalid date strings', () => {
    mockReadCronsWithStatus.mockReturnValue({
      crons: [{ name: 'heartbeat', enabled: true, last_fired_at: 'not-a-date' }],
      corrupt: false,
    });
    mockReadCronState.mockReturnValue({ crons: [{ name: 'heartbeat', last_fire: iso(4_200) }] });
    expect(scheduler().getLastFireMs()).toBe(4_200);
  });
});
