/**
 * tests/integration/stall-watchdog-tick-invocation.test.ts
 *
 * MANDATORY live-tick assertion for the fleet stall-watchdog (Option B, task
 * 1780938481333). This is the obs-detector-class bar: the StallObserver unit
 * suite proves the detection/loop-breaker LOGIC, but units call obs.tick()
 * MANUALLY — they never prove the daemon INVOKES tick() on its own interval, nor
 * that a confirmed stall drives an actual restart and STOPS at the cap. That
 * unproven-wiring gap is exactly how the vault detectors once shipped inert
 * (feed ran, tick never armed). This test closes it for B.
 *
 * It drives a CONTROLLED DETERMINISTIC STALL (pid alive, last_seen frozen behind
 * a cron fire) through the REAL AgentManager interval and asserts the full
 * safety sequence end-to-end:
 *   detect → restart ONCE → (no-op restart, still stalled) → restart #2 →
 *   cap hit → ESCALATE → STOP (never loops).
 *
 * SEAMS (same philosophy as vault-boot-tick-invocation.test.ts): the fake
 * `clock` lets us jump past the multi-hour confirm/verify windows instantly; the
 * `stallSnapshotProvider` injects the controlled stall (the analog of vault's
 * feed methods — it isolates the INPUT while the daemon-owned setInterval still
 * does the INVOKING); `stallRestartFn` captures restarts instead of really
 * bouncing an agent. The REAL interval + REAL StallObserver + REAL alert routing
 * are exercised — nothing about the tick→observe→remediate path is stubbed. The
 * production snapshot BUILDER's live-state reads are covered separately
 * (CronScheduler.getLastFireMs unit test + the trivial heartbeat/pid reads).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentManager } from '../../src/daemon/agent-manager';
import type { StallAlert, AgentStallSnapshot } from '../../src/daemon/stall-observer';

const TICK_MS = 20;             // short real interval so the test runs fast
const WAIT_MS = TICK_MS * 6;    // long enough for several real tick fires per phase
const CONFIRM = 1_000;          // stall-confirm window (fake-clock ms)
const VERIFY = 500;             // restart-recovery verify window
const CAP = 2;                  // restart-loop breaker cap
const WINDOW = 10_000;          // cap sliding window

const managers: AgentManager[] = [];
const wait = () => new Promise((r) => setTimeout(r, WAIT_MS));

afterEach(() => {
  for (const m of managers.splice(0)) {
    m.clearStallTickForTest();
    m.clearVaultBootTickForTest();
  }
});

/**
 * Build an AgentManager WITHOUT discoverAndStart (the continue/re-attach path
 * that once shipped the vault tick inert). `snapshot` is mutated by the test
 * between phases to model the agent's evolving (or frozen) state; `clock` is a
 * mutable fake; restarts + alerts are captured.
 */
function makeManager(opts: {
  clock: () => number;
  snapshot: () => AgentStallSnapshot[];
  restarts: string[];
  alerts: StallAlert[];
}): AgentManager {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-tick-'));
  const mgr = new AgentManager('test-instance', tmp, tmp, 'test-org', {
    stallTickIntervalMs: TICK_MS,
    stallClock: opts.clock,
    stallConfirmMs: CONFIRM,
    stallVerifyMs: VERIFY,
    stallCapN: CAP,
    stallWindowMs: WINDOW,
    stallSnapshotProvider: opts.snapshot,
    stallRestartFn: (agent) => opts.restarts.push(agent),
    onStallAlert: (a) => opts.alerts.push(a),
  });
  managers.push(mgr);
  return mgr;
}

describe('stall-watchdog live-tick — controlled deterministic stall through the REAL interval', () => {
  it('LINCHPIN: tick is armed at construction (no discoverAndStart) and FIRES on its interval', () => {
    const mgr = makeManager({ clock: () => 0, snapshot: () => [], restarts: [], alerts: [] });
    expect(mgr.isStallTickArmed()).toBe(true);
    expect(mgr.stallTickArmCountForTest()).toBe(1);
  });

  it('FULL SAFETY SEQUENCE: detect → restart once → no-op → restart #2 → cap → escalate → never loops', async () => {
    let now = 0;
    const restarts: string[] = [];
    const alerts: StallAlert[] = [];
    // A genuinely stalled agent: pid alive, pid NEVER changes (a no-op restart —
    // the silent-no-op bug), last_seen frozen at 0, a cron fired at 100 (ahead of
    // last_seen → unhonored). This snapshot never improves, modelling a restart
    // that does not actually recover the session.
    const stalled = (): AgentStallSnapshot[] => [
      { agent: 'free-mode', lastFireMs: 100, lastSeenMs: 0, pid: 100, pidAlive: true },
    ];
    const mgr = makeManager({ clock: () => now, snapshot: stalled, restarts, alerts });

    // Phase 0 — stall just observed, within the confirm window → NO restart yet.
    now = 0;
    await wait();
    expect(restarts).toHaveLength(0);
    expect(alerts).toHaveLength(0);

    // Phase 1 — confirm window elapsed → exactly ONE bounded restart.
    now = CONFIRM;
    await wait();
    expect(restarts).toEqual(['free-mode']);
    expect(alerts.filter((a) => a.kind === 'restart')).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0);

    // Phase 2 — verify window elapses with the SAME pid + frozen last_seen (the
    // restart was a no-op). Not a heal → it counts as a failed attempt → restart #2.
    now = CONFIRM + VERIFY + 1;
    await wait();
    expect(restarts).toHaveLength(2);
    expect(alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0);

    // Phase 3 — second no-op → cap (2) hit → STOP restarting, escalate ONCE.
    now = CONFIRM + 2 * (VERIFY + 1);
    await wait();
    expect(restarts).toHaveLength(2); // CAPPED — no third restart
    const escalations = alerts.filter((a) => a.kind === 'escalate');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].agent).toBe('free-mode');

    // Phase 4 — keep the stall present across many more real ticks: must NOT loop.
    now = CONFIRM + 10 * (VERIFY + 1);
    await wait();
    await wait();
    expect(restarts).toHaveLength(2);
    expect(alerts.filter((a) => a.kind === 'escalate')).toHaveLength(1);
  });

  it('HEAL through the live tick: a real restart (new pid + last_seen advance) resets — no escalate', async () => {
    let now = 0;
    const restarts: string[] = [];
    const alerts: StallAlert[] = [];
    // Mutable snapshot: starts stalled, then the test models a successful restart
    // (new pid + last_seen advanced past the restart time) after the first restart.
    let snap: AgentStallSnapshot = { agent: 'dev', lastFireMs: 100, lastSeenMs: 0, pid: 100, pidAlive: true };
    const mgr = makeManager({ clock: () => now, snapshot: () => [snap], restarts, alerts });

    // Observe the stall first (starts the continuous-stall clock), THEN let the
    // confirm window elapse — same shape as the FULL SEQUENCE test.
    now = 0;
    await wait();
    now = CONFIRM + 1;
    await wait();
    expect(restarts).toHaveLength(1); // confirmed stall → restart #1

    // Model recovery: NEW pid, last_seen advanced past the restart time (CONFIRM).
    snap = { agent: 'dev', lastFireMs: 100, lastSeenMs: CONFIRM + 100, pid: 999, pidAlive: true };
    now = CONFIRM + 200; // within the verify window
    await wait();

    // Healthy thereafter (last_seen keeps up with fires).
    snap = { agent: 'dev', lastFireMs: 500, lastSeenMs: 600, pid: 999, pidAlive: true };
    now = CONFIRM + 5_000;
    await wait();

    expect(restarts).toHaveLength(1); // no second restart
    expect(alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0); // healed, never escalated
  });
});
