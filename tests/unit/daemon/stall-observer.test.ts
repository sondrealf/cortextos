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

/**
 * Loop-breaker fix (task_1781590135871): escalation was STRUCTURALLY UNREACHABLE
 * for a cap-wedged agent (openrouter live repro 2026-06-16T04:47:52Z — 1 restart,
 * 0 escalates, silent ~6h thrash). The restart respawns with a NEW pid + a
 * one-shot boot heartbeat (a "false-heal" the old new-pid+last_seen-advance heal
 * accepted), then re-wedges; the old 1h wall-clock attempt window also aged out
 * every attempt before the next 6h re-confirm. Both reset escalation progress so
 * the cap of 2 was never reached.
 *
 * Fix: recovery is proven ONLY by honoring a cron beat that fired AFTER the
 * restart; restartCount is counted since-last-recovery (no wall-clock window).
 * These are the INSTRUMENTED-TICK proofs (state asserted via peekStateForTest),
 * driven through the same real tick() the daemon runs.
 */
describe('StallObserver — loop-breaker escalation reachability (task_1781590135871)', () => {
  it('CAP-WEDGE (new-pid boot-flicker, never honors a post-restart beat) → restartCount climbs to cap → ESCALATE fires', () => {
    const h = harness();
    const esc = () => h.alerts.filter((a) => a.kind === 'escalate');

    // Initial stall (pid alive, last_seen frozen behind the cron fire).
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // stalledSince = 0

    // --- Bounded restart #1 ---
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // confirmed → restart #1
    expect(h.restarts).toHaveLength(1);
    expect(h.obs.peekStateForTest('dev').restartCount).toBe(1); // instrumented: count = 1
    const r1 = h.now();
    // Boot-flicker false-heal: NEW pid + one-shot boot heartbeat, but the latest
    // cron fire is still PRE-restart → NOT a post-restart honored beat.
    h.advance(VERIFY + 1);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: r1 + 1, pid: 200 })]);
    expect(h.obs.peekStateForTest('dev').restartCount).toBe(1); // false-heal did NOT reset
    // A post-restart cron fires but the re-wedged agent does NOT honor it.
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: r1 + 50, lastSeenMs: r1 + 1, pid: 200 })]); // unhonored again → restart #2
    expect(h.restarts).toHaveLength(2);
    expect(h.obs.peekStateForTest('dev').restartCount).toBe(2); // instrumented: count = 2
    expect(esc()).toHaveLength(0); // not yet — cap not exceeded at trigger time
    const r2 = h.now();

    // --- Re-wedge after restart #2 → cap reached → ESCALATE ---
    h.advance(VERIFY + 1);
    h.tick([snap('dev', { lastFireMs: r1 + 50, lastSeenMs: r2 + 1, pid: 300 })]); // boot-flicker again
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: r2 + 50, lastSeenMs: r2 + 1, pid: 300 })]); // confirmed, count>=cap → escalate
    expect(esc()).toHaveLength(1);
    expect(esc()[0].agent).toBe('dev');
    expect(h.restarts).toHaveLength(2); // CAPPED — no third restart
    expect(h.obs.peekStateForTest('dev').gaveUp).toBe(true);

    // Keep ticking the wedge — must NOT loop (no more restarts / repeated escalations).
    h.advance(CONFIRM * 3);
    h.tick([snap('dev', { lastFireMs: r2 + 5000, lastSeenMs: r2 + 1, pid: 300 })]);
    h.tick([snap('dev', { lastFireMs: r2 + 6000, lastSeenMs: r2 + 1, pid: 300 })]);
    expect(h.restarts).toHaveLength(2);
    expect(esc()).toHaveLength(1);
  });

  it('TRANSIENT stall that honors the next post-restart cron → restartCount resets → NO escalate', () => {
    const h = harness();
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // stall starts t=0
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // confirmed → restart #1
    expect(h.restarts).toHaveLength(1);
    expect(h.obs.peekStateForTest('dev').restartCount).toBe(1);
    const restartAt = h.now();

    // Genuine recovery: new pid AND it HONORS a cron beat that fired AFTER the restart.
    h.advance(VERIFY + 1);
    h.tick([snap('dev', { lastFireMs: restartAt + 100, lastSeenMs: restartAt + 150, pid: 200 })]);
    // Instrumented proof of reset: fresh slate.
    const st = h.obs.peekStateForTest('dev');
    expect(st.restartCount).toBe(0);
    expect(st.lastRestartAt).toBe(null);
    expect(st.gaveUp).toBe(false);

    // Stays healthy → no escalate, no further restarts.
    h.advance(CONFIRM * 3);
    h.tick([snap('dev', { lastFireMs: restartAt + 5000, lastSeenMs: restartAt + 5100, pid: 200 })]);
    expect(h.alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0);
    expect(h.restarts).toHaveLength(1);
  });

  it('recovery reset is REAL: after recovery a fresh perma-wedge needs a FULL cap (capN restarts) before escalate', () => {
    const h = harness();
    const esc = () => h.alerts.filter((a) => a.kind === 'escalate');
    // First stall → restart #1 → genuine recovery (resets count to 0).
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]);
    h.advance(CONFIRM);
    h.tick([snap('dev', { lastFireMs: 100, lastSeenMs: 0, pid: 100 })]); // restart #1
    const r1 = h.now();
    h.advance(VERIFY + 1);
    h.tick([snap('dev', { lastFireMs: r1 + 100, lastSeenMs: r1 + 150, pid: 200 })]); // proven recovery
    expect(h.obs.peekStateForTest('dev').restartCount).toBe(0);
    expect(h.restarts).toHaveLength(1);

    // Brand-new perma-wedge later (frozen last_seen). If the prior restart had
    // leaked into the cap, escalate would fire after ONE fresh restart (total 2).
    // With a real reset it needs capN(=2) fresh restarts → escalate only at total 3.
    const base = r1 + 150; // last_seen stays frozen here for the rest of the test
    const wedge = () => snap('dev', { lastFireMs: base + 1000, lastSeenMs: base, pid: 200 });
    h.advance(CONFIRM);
    h.tick([wedge()]);                 // unhonored → stall clock starts
    h.advance(CONFIRM);
    h.tick([wedge()]);                 // confirmed → fresh restart (count 1)
    expect(h.restarts).toHaveLength(2);
    expect(esc()).toHaveLength(0);
    h.advance(VERIFY + 1);
    h.tick([wedge()]);                 // verify elapsed, still wedged → fresh restart (count 2)
    expect(h.restarts).toHaveLength(3);
    expect(esc()).toHaveLength(0);     // capN fresh restarts triggered, not yet escalated
    h.advance(VERIFY + 1);
    h.tick([wedge()]);                 // confirmed, count >= cap → escalate
    expect(esc()).toHaveLength(1);
    expect(h.restarts).toHaveLength(3); // capped at the fresh cap (3 total = 1 + 2)
  });
});
