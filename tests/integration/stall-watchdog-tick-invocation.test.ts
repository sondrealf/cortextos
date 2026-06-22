/**
 * tests/integration/stall-watchdog-tick-invocation.test.ts
 *
 * MANDATORY live-tick assertion for the fleet stall-watchdog (Option B, task
 * 1780938481333) — the obs-detector-class bar. Two layers:
 *
 *  1. LINCHPIN — the tick is armed AT CONSTRUCTION (no discoverAndStart) and
 *     FIRES on its own interval. This closes the catastrophic "tick never fires"
 *     mode (the way the vault detectors once shipped inert).
 *
 *  2. REAL-COMPOSITION — detection is driven through the REAL buildStallSnapshots
 *     SNAPSHOT FEED, not an injected/mock snapshot: a frozen heartbeat.json
 *     (stale last_seen) + a real CronScheduler.getLastFireMs() reading on-disk
 *     cron-state.json (a fired beat AHEAD of last_seen) + a real pid for
 *     process.kill liveness, all assembled by buildStallSnapshots and consumed by
 *     the observer through the real interval. This closes the latent-composition
 *     bug risk (a bad builder → wrong/empty snapshots → the watchdog silently
 *     does not watch) that a mock-snapshot test cannot catch.
 *
 * Per the analyst acceptance criterion: there is NO injectable snapshot-provider
 * seam — the tick always calls the real buildStallSnapshots(), so no test can
 * bypass the composition under test.
 * The clock and the restart SINK are seamed (legitimate — they isolate timing and
 * capture remediation; they are not the snapshot feed under test). On-disk
 * timestamps use small epoch values so they share the fake clock's numeric scale.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { AgentManager } from '../../src/daemon/agent-manager';
import { CronScheduler } from '../../src/daemon/cron-scheduler';
import type { StallAlert } from '../../src/daemon/stall-observer';

const TICK_MS = 20;             // short real interval so the test runs fast
const WAIT_MS = TICK_MS * 6;    // long enough for several real tick fires per phase
const CONFIRM = 1_000;          // stall-confirm window (fake-clock ms)
const VERIFY = 500;             // restart-recovery verify window
const CAP = 2;                  // restart-loop breaker cap
const WINDOW = 10_000;          // cap sliding window

const managers: AgentManager[] = [];
const children: ChildProcess[] = [];
const tmpDirs: string[] = [];
const savedCtxRoot = process.env.CTX_ROOT;
const wait = () => new Promise((r) => setTimeout(r, WAIT_MS));

afterEach(() => {
  for (const m of managers.splice(0)) {
    m.clearStallTickForTest();
    m.clearVaultBootTickForTest();
  }
  for (const c of children.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }
  tmpDirs.splice(0);
  if (savedCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = savedCtxRoot;
});

/** ISO string whose epoch-ms equals `ms` (kept small to share the fake clock scale). */
const isoAt = (ms: number) => new Date(ms).toISOString();

/**
 * Seed a tmp ctxRoot with REAL on-disk state for one agent and point
 * process.env.CTX_ROOT at it (so CronScheduler.getLastFireMs reads the same root
 * buildStallSnapshots' heartbeat read uses). Returns the tmp root.
 */
function seedAgentState(name: string, opts: { lastSeenMs: number; lastFireMs: number }): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-real-'));
  tmpDirs.push(tmp);
  const stateDir = path.join(tmp, 'state', name);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'heartbeat.json'),
    JSON.stringify({ last_heartbeat: isoAt(opts.lastSeenMs), status: 'online' }), 'utf8');
  fs.writeFileSync(path.join(stateDir, 'cron-state.json'),
    JSON.stringify({ crons: [{ name: 'heartbeat', last_fire: isoAt(opts.lastFireMs) }] }), 'utf8');
  process.env.CTX_ROOT = tmp;
  return tmp;
}

function makeManager(tmp: string, opts: {
  clock: () => number;
  restarts: string[];
  alerts: StallAlert[];
}): AgentManager {
  // No snapshot-provider seam exists — the tick always uses the real builder.
  const mgr = new AgentManager('test-instance', tmp, tmp, 'test-org', {
    stallTickIntervalMs: TICK_MS,
    stallClock: opts.clock,
    stallConfirmMs: CONFIRM,
    stallVerifyMs: VERIFY,
    stallCapN: CAP,
    stallWindowMs: WINDOW,
    stallRestartFn: (agent) => opts.restarts.push(agent),
    onStallAlert: (a) => opts.alerts.push(a),
  });
  managers.push(mgr);
  return mgr;
}

const realScheduler = (name: string) =>
  new CronScheduler({ agentName: name, onFire: async () => {}, logger: () => {} });

describe('stall-watchdog live-tick', () => {
  it('LINCHPIN: tick armed at construction (no discoverAndStart) and fires on its interval', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-linch-'));
    tmpDirs.push(tmp);
    const mgr = makeManager(tmp, { clock: () => 0, restarts: [], alerts: [] });
    expect(mgr.isStallTickArmed()).toBe(true);
    expect(mgr.stallTickArmCountForTest()).toBe(1);
  });

  it('REAL COMPOSITION: buildStallSnapshots assembles pid+pidAlive+last_seen+last_fire from real on-disk state', () => {
    // last_seen=0 (frozen) BEHIND last_fire=100 (a cron fired) → unhonored.
    const tmp = seedAgentState('free-mode', { lastSeenMs: 0, lastFireMs: 100 });
    const mgr = makeManager(tmp, { clock: () => 0, restarts: [], alerts: [] });
    mgr.registerStallAgentForTest('free-mode', process.pid, realScheduler('free-mode'));

    const snaps = mgr.getStallSnapshotsForTest();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      agent: 'free-mode',
      lastSeenMs: 0,        // read from heartbeat.json
      lastFireMs: 100,      // read from cron-state.json via getLastFireMs
      pid: process.pid,     // from the registry entry
      pidAlive: true,       // process.kill(process.pid, 0) — our own (live) process
    });
  });

  it('FULL SAFETY SEQUENCE off the REAL snapshot feed: detect → restart → no-op → restart #2 → cap → escalate → never loops', async () => {
    let now = 0;
    const restarts: string[] = [];
    const alerts: StallAlert[] = [];
    // Frozen forever: last_seen=0 behind last_fire=100, pid stays process.pid
    // (alive, never changes → models a no-op restart that does not recover).
    const tmp = seedAgentState('free-mode', { lastSeenMs: 0, lastFireMs: 100 });
    const mgr = makeManager(tmp, { clock: () => now, restarts, alerts });
    mgr.registerStallAgentForTest('free-mode', process.pid, realScheduler('free-mode'));

    // Phase 0 — within confirm window → no restart.
    now = 0; await wait();
    expect(restarts).toHaveLength(0);

    // Phase 1 — confirm window elapsed → exactly ONE bounded restart.
    now = CONFIRM; await wait();
    expect(restarts).toEqual(['free-mode']);
    expect(alerts.filter((a) => a.kind === 'restart')).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0);

    // Phase 2 — verify window elapses, snapshot still frozen (no-op) → restart #2.
    now = CONFIRM + VERIFY + 1; await wait();
    expect(restarts).toHaveLength(2);

    // Phase 3 — second no-op → cap hit → STOP restarting, escalate once.
    now = CONFIRM + 2 * (VERIFY + 1); await wait();
    expect(restarts).toHaveLength(2);
    const escalations = alerts.filter((a) => a.kind === 'escalate');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].agent).toBe('free-mode');

    // Phase 4 — keep the stall present: must NOT loop.
    now = CONFIRM + 10 * (VERIFY + 1); await wait(); await wait();
    expect(restarts).toHaveLength(2);
    expect(alerts.filter((a) => a.kind === 'escalate')).toHaveLength(1);
  });

  it('HEAL off the REAL feed: a genuine restart (new ALIVE pid + last_seen advanced) resets — no escalate', async () => {
    let now = 0;
    const restarts: string[] = [];
    const alerts: StallAlert[] = [];
    const tmp = seedAgentState('dev', { lastSeenMs: 0, lastFireMs: 100 });
    const mgr = makeManager(tmp, { clock: () => now, restarts, alerts });
    mgr.registerStallAgentForTest('dev', process.pid, realScheduler('dev'));

    now = 0; await wait();
    now = CONFIRM; await wait();
    expect(restarts).toHaveLength(1); // confirmed stall → restart #1

    // Model a REAL recovery: a NEW, genuinely-alive process (spawned child) +
    // heartbeat last_seen advanced past the restart time.
    const child = spawn('sleep', ['30']);
    children.push(child);
    const newPid = child.pid!;
    const stateDir = path.join(tmp, 'state', 'dev');
    fs.writeFileSync(path.join(stateDir, 'heartbeat.json'),
      JSON.stringify({ last_heartbeat: isoAt(CONFIRM + 100), status: 'online' }), 'utf8');
    mgr.registerStallAgentForTest('dev', newPid, realScheduler('dev'));

    now = CONFIRM + 200; await wait(); // within verify window → heal observed
    now = CONFIRM + 5_000; await wait();

    expect(restarts).toHaveLength(1); // no second restart
    expect(alerts.filter((a) => a.kind === 'escalate')).toHaveLength(0);
  });
});
