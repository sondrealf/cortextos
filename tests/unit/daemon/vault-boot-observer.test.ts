import { describe, it, expect } from 'vitest';
import { VaultBootObserver, type VaultBootAlert } from '../../../src/daemon/vault-boot-observer.js';

const T = 300_000;   // degraded alert threshold (5 min)
const X = 60_000;    // spawn watchdog (60 s)

/** Test harness: capture alerts + a controllable clock. */
function harness(degradedMs = T, watchdogMs = X) {
  const alerts: VaultBootAlert[] = [];
  let t = 0;
  const obs = new VaultBootObserver((a) => alerts.push(a), () => t, degradedMs, watchdogMs);
  return { obs, alerts, advance: (ms: number) => { t += ms; } };
}

describe('VaultBootObserver — Detector A (persistent-tokenless, time-driven)', () => {
  it('ACCEPTANCE (ii): a benign heal within < T produces ZERO alerts', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false); // degraded at t=0
    advance(40_000);                            // 40s later (< T)
    obs.recordPollerVaultFetch('dev', true);    // a restart hit a healthy vault → heal
    advance(T);                                 // long past T
    obs.tick();
    expect(alerts).toHaveLength(0);
  });

  it('ACCEPTANCE (iii): continuously degraded >= T produces EXACTLY ONE alert', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false);
    advance(T);
    obs.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detector).toBe('persistent-tokenless');
    expect(alerts[0].agent).toBe('dev');
  });

  it('PRIMARY CASE (the count-based design missed this): boot tokenless ONCE and sit -> alerts at T', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false); // single degraded boot, no further restarts/records
    advance(T + 1000);
    obs.tick();
    expect(alerts).toHaveLength(1); // count-based A would have been stuck at 1 forever; time-based fires
  });

  it('does not alert before T elapses', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false);
    advance(T - 1000);
    obs.tick();
    expect(alerts).toHaveLength(0);
  });

  it('de-dups: repeated ticks while still degraded do NOT re-alert', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false);
    advance(T);
    obs.tick(); obs.tick(); obs.tick();
    expect(alerts).toHaveLength(1);
  });

  it('a still-degraded re-observation does NOT reset the clock (no flap-dodging)', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false); // t=0
    advance(T - 10_000);
    obs.recordPollerVaultFetch('dev', false); // still degraded — must keep earliest ts
    advance(20_000);                           // now > T since the FIRST degraded
    obs.tick();
    expect(alerts).toHaveLength(1);
  });

  it('re-arms after a heal: a new sustained episode alerts again', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false); advance(T); obs.tick(); // alert #1
    obs.recordPollerVaultFetch('dev', true);                          // heal
    obs.recordPollerVaultFetch('dev', false); advance(T); obs.tick(); // alert #2
    expect(alerts).toHaveLength(2);
  });

  it('tracks agents independently', () => {
    const { obs, alerts, advance } = harness();
    obs.recordPollerVaultFetch('dev', false);
    advance(100_000);
    obs.recordPollerVaultFetch('coliseum', false); // degraded later
    advance(T - 100_000);                           // dev now >= T, coliseum not yet
    obs.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].agent).toBe('dev');
  });
});

describe('VaultBootObserver — Detector B (spawn-completion watchdog)', () => {
  it('ACCEPTANCE (i): a hung spawn (no Bootstrap complete within X) IS observable — exactly one alert', () => {
    const { obs, alerts, advance } = harness();
    obs.noteSpawnInitiated('dev');     // "Starting. Waiting for bootstrap..."
    advance(X + 1000);                 // half-up vault: bootstrap never completes
    obs.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detector).toBe('spawn-watchdog');
    obs.tick();                        // subsequent ticks don't re-alert
    expect(alerts).toHaveLength(1);
  });

  it('a spawn that completes within X produces ZERO alerts', () => {
    const { obs, alerts, advance } = harness();
    obs.noteSpawnInitiated('dev');
    advance(5_000);
    obs.noteBootstrapComplete('dev');  // healthy boot
    advance(120_000);
    obs.tick();
    expect(alerts).toHaveLength(0);
  });

  it('does not alert before the watchdog elapses', () => {
    const { obs, alerts, advance } = harness();
    obs.noteSpawnInitiated('dev');
    advance(X - 1000);
    obs.tick();
    expect(alerts).toHaveLength(0);
  });
});
