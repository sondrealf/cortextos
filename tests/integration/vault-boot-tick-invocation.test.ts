/**
 * tests/integration/vault-boot-tick-invocation.test.ts
 *
 * REGRESSION TEST for the obs-detector inert-tick defect (2026-06-02, analyst
 * root-cause via live Gate-4 sim; fix by dev).
 *
 * THE DEFECT: the vault degraded-boot detectors (A persistent-tokenless +
 * B spawn-watchdog) share a periodic EVALUATING tick. That tick was armed only
 * inside AgentManager.discoverAndStart(). The 16:47Z fleet bounce brought agents
 * up in continue/re-attach mode (which skips discoverAndStart), so the tick was
 * never started — the feed (recordPollerVaultFetch) stamped `degradedSince` but
 * nothing ever evaluated it. Detectors A+B were SILENTLY INERT in production.
 *
 * WHY THE 11/11 UNIT TESTS MISSED IT: they call obs.tick() MANUALLY, proving the
 * detector LOGIC but never that the daemon INVOKES tick() on its interval. This
 * test closes that integration gap: it asserts the RUNNING AgentManager actually
 * fires the tick on its own interval, driven through the CONTINUE path (i.e.
 * WITHOUT calling discoverAndStart) — the exact path that shipped inert.
 *
 * fails-now/passes-after: with the fix's arming removed (constructor +
 * recordAgentVaultFetch + _startAgentImpl) and only discoverAndStart arming the
 * tick, these tests go RED because they never call discoverAndStart. The fix
 * makes them GREEN.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentManager } from '../../src/daemon/agent-manager';
import { DEGRADED_ALERT_MS, type VaultBootAlert } from '../../src/daemon/vault-boot-observer';

const TICK_MS = 20;            // short real interval so the test runs fast
const WAIT_MS = TICK_MS * 6;   // long enough for several real tick fires

const managers: AgentManager[] = [];

/**
 * Build an AgentManager WITHOUT calling discoverAndStart — i.e. exactly the
 * continue/re-attach boot path that shipped inert. `clock` is a mutable fake so
 * we can jump past the degraded threshold instantly; alerts are captured.
 */
function makeManager(alerts: VaultBootAlert[], clock: () => number): AgentManager {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tick-'));
  const mgr = new AgentManager('test-instance', tmp, tmp, 'test-org', {
    vaultTickIntervalMs: TICK_MS,
    vaultClock: clock,
    onVaultAlert: (a) => alerts.push(a),
  });
  managers.push(mgr);
  return mgr;
}

const tick = () => new Promise((r) => setTimeout(r, WAIT_MS));

afterEach(() => {
  for (const m of managers.splice(0)) m.clearVaultBootTickForTest();
});

describe('VaultBoot tick invocation (continue path) — obs-detector inert-tick regression', () => {
  it('LINCHPIN: tick is armed at construction (no discoverAndStart) and FIRES on its interval → sustained degrade alerts exactly once', async () => {
    const alerts: VaultBootAlert[] = [];
    let now = 0;
    const mgr = makeManager(alerts, () => now);

    // The continue path never called discoverAndStart — pre-fix this is false.
    expect(mgr.isVaultTickArmed()).toBe(true);

    mgr.recordAgentVaultFetch('unraid', false); // degraded at t=0
    now += DEGRADED_ALERT_MS + 1_000;           // jump past the 5-min threshold
    await tick();                               // let the REAL interval invoke tick()

    const fired = alerts.filter(
      (a) => a.detector === 'persistent-tokenless' && a.agent === 'unraid',
    );
    expect(fired).toHaveLength(1);
  });

  it('IDEMPOTENCY: N agent starts arm EXACTLY ONE tick (no duplicate ticks/handles/alerts)', async () => {
    const alerts: VaultBootAlert[] = [];
    let now = 0;
    const mgr = makeManager(alerts, () => now);

    // Simulate 8 agents each coming up and feeding a degraded fetch — the same
    // recordAgentVaultFetch path _startAgentImpl uses, called once per agent.
    const fleet = ['commander', 'analyst', 'dev', 'coliseum', 'unraid', 'openrouter', 'free-mode', 'project-bootstrap'];
    for (const name of fleet) mgr.recordAgentVaultFetch(name, false);

    // Exactly ONE real interval was created (constructor) — the 8 feeds + the
    // constructor all no-op'd through the idempotency guard.
    expect(mgr.vaultTickArmCountForTest()).toBe(1);

    now += DEGRADED_ALERT_MS + 1_000;
    await tick();

    // One alert per agent episode — not 8× per agent from duplicate ticks.
    for (const name of fleet) {
      expect(alerts.filter((a) => a.detector === 'persistent-tokenless' && a.agent === name)).toHaveLength(1);
    }
    expect(alerts).toHaveLength(fleet.length);
  });

  it('CLEAR-ON-HEAL still works through the live tick: a degrade healed before threshold → zero alerts', async () => {
    const alerts: VaultBootAlert[] = [];
    let now = 0;
    const mgr = makeManager(alerts, () => now);

    mgr.recordAgentVaultFetch('coliseum', false); // degraded at t=0
    now += 40_000;                                 // 40s later (< 5min threshold)
    mgr.recordAgentVaultFetch('coliseum', true);   // heal (a restart hit a healthy vault)
    now += DEGRADED_ALERT_MS + 1_000;              // now well past threshold
    await tick();

    expect(alerts).toHaveLength(0);
  });

  it('Detector B shares the SAME tick: the armed evaluator that drives A also drives B (covered transitively)', async () => {
    // B (spawn-watchdog) is fed via observer.noteSpawnInitiated from the same
    // _startAgentImpl path and evaluated by the SAME tick proven live above; its
    // alert LOGIC is covered by the unit suite. Here we just assert the single
    // armed tick exists to evaluate it (no separate B tick to arm).
    const alerts: VaultBootAlert[] = [];
    const mgr = makeManager(alerts, () => 0);
    expect(mgr.isVaultTickArmed()).toBe(true);
    expect(mgr.vaultTickArmCountForTest()).toBe(1);
  });
});
