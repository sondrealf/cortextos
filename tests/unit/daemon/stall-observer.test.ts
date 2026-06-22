import { describe, it, expect } from 'vitest';
import { StallObserver, type StallAlert, type AgentStallSnapshot } from '../../../src/daemon/stall-observer.js';

const CONFIRM = 1000;  // stall confirm window
const VERIFY = 500;    // restart-recovery verify window
const CAP = 2;         // restart-loop breaker cap
const WINDOW = 10_000; // cap sliding window

function harness() {
  const alerts: StallAlert[] = [];
  const restarts: { agent: string; at: number }[] = [];
  let t = 0;
  const obs = new StallObserver(
    (a) => alerts.push(a),
    (agent) => restarts.push({ agent, at: t }),
    () => t,
    CONFIRM, VERIFY, CAP, WINDOW,
  );
  return {
    obs, alerts, restarts,
    advance: (ms: number) => { t += ms; },
    now: () => t,
    tick: (snaps: AgentStallSnapshot[]) => obs.tick(snaps),
  };
}

/** A snapshot where the latest cron fire is `behind` ms AHEAD of last_seen (unhonored when behind>0). */
function snap(agent: string, opts: Partial<AgentStallSnapshot> = {}): AgentStallSnapshot {
  return {
    agent,
    lastFireMs: opts.lastFireMs ?? null,
    lastSeenMs: opts.lastSeenMs ?? null,
    pid: opts.pid ?? 100,
    pidAlive: opts.pidAlive ?? true,
  };
}

describe('StallObserver — detection', () => {
  it('healthy agent (last_seen >= latest fire) never stalls or restarts', () => {
    const h = harness();
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 100 })]);
    h.advance(CONFIRM * 3);
    h.tick([snap('dev', { lastFireMs: 200, lastSeenMs: 250 })]);
    expect(h.alerts).toHaveLength(0);
    expect(h.restarts).toHaveLength(0);
  });

  it('legit long turn: unhonored briefly then heals (< confirm window) → no restart', () => {
    const h = harness();
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0 })]); // unhonored at t=0
    h.advance(CONFIRM - 1);                                     // still within confirm window
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 120 })]); // beat honored → heal
    h.advance(CONFIRM * 2);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 120 })]);
    expect(h.alerts).toHaveLength(0);
    expect(h.restarts).toHaveLength(0);
  });

  it('pid not alive → not treated as a stall (no restart)', () => {
    const h = harness();
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pidAlive: false })]);
    h.advance(CONFIRM * 2);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pidAlive: false })]);
    expect(h.restarts).toHaveLength(0);
  });

  it('confirmed stall (pid alive, last_seen behind fire ≥ confirm window) → exactly ONE bounded restart', () => {
    const h = harness();
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0 })]); // stall starts at t=0
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0 })]); // confirmed → restart
    expect(h.restarts).toHaveLength(1);
    expect(h.restarts[0].agent).toBe('dev');
    expect(h.alerts.filter((a) => a.kind === 'restart')).toHaveLength(1);
    expect(h.alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0);
  });
});

describe('StallObserver — recovery is verified by OBSERVED new-pid + last_seen advance only', () => {
  it('successful restart (NEW pid + last_seen advanced) → heals, resets, no escalate', () => {
    const h = harness();
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // restart at this t
    const restartAt = h.now();
    h.advance(200); // within verify window
    // New process booted: new pid + last_seen advanced past the restart time.
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: restartAt + 100, pid: 999 })]);
    h.advance(CONFIRM * 3);
    h.tick([snap('dev', { lastFireMs: 500, lastSeenMs: 600, pid: 999 })]); // healthy
    expect(h.restarts).toHaveLength(1);
    expect(h.alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0);
  });

  it('NO-OP restart (same pid, last_seen still frozen) is NOT a heal → counts as failed attempt → escalates at cap, never loops', () => {
    const h = harness();
    // stall confirmed → restart #1
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    expect(h.restarts).toHaveLength(1);
    // verify window elapses with the SAME pid + frozen last_seen (no-op restart)
    h.advance(VERIFY + 1);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // pending failed → restart #2
    expect(h.restarts).toHaveLength(2);
    // second no-op
    h.advance(VERIFY + 1);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // cap hit → escalate
    expect(h.restarts).toHaveLength(2); // CAPPED — no third restart
    const escalations = h.alerts.filter((a) => a.kind === 'escalate');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].agent).toBe('dev');
    // keep ticking — must NOT loop (no more restarts, no repeated escalations)
    h.advance(VERIFY * 5);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    expect(h.restarts).toHaveLength(2);
    expect(h.alerts.filter((a) => a.kind === 'escalate')).toHaveLength(1);
  });

  it('does not re-restart while a restart is still within the verify window', () => {
    const h = harness();
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // restart #1
    h.advance(VERIFY - 1); // still verifying
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    expect(h.restarts).toHaveLength(1); // no premature second restart
  });
});
