/**
 * Vault degraded-boot observability — two detectors for the failure modes from
 * the 2026-05-29 fleet-hang incident (analyst spec, task_1780136725694). One
 * detector cannot catch both modes, so there are two — and BOTH are TIME-driven
 * (see the design note), alerting via a periodic tick.
 *
 *   A) PERSISTENT-TOKENLESS — the daemon's per-agent Telegram poller does a
 *      vault fetch ONCE at poller start (agent-manager). If degraded (skipped →
 *      .env fallback, e.g. Infisical down), BOT_TOKEN may be stale/empty.
 *
 *      DESIGN NOTE (analyst-caught, verified): there is NO periodic vault
 *      re-fetch in the daemon — the only setInterval timers are the cron tick
 *      and the idle heartbeat; vault is fetched only at spawn/start. So a
 *      count-of-degraded-starts threshold can't fire on the PRIMARY case (boot
 *      tokenless once and just sit there — the count stays at 1). Detector A is
 *      therefore time-driven: a degraded fetch stamps `degradedSince`, a healthy
 *      fetch (a later restart that hit a healthy vault) clears it, and the tick
 *      alerts when an agent has been continuously degraded ≥ T. Tonight's
 *      "self-heal" was config-reload RESTARTS landing on a healthy Infisical —
 *      not a re-fetch; without them the fleet would have sat tokenless until the
 *      daily rotation (multi-hour silent outage). T is set above the Infisical
 *      warmup + the sub-minute benign-heal window so a quick restart-through-
 *      warmup doesn't trip, but a genuinely-stuck tokenless poller does.
 *
 *   B) SPAWN-COMPLETION WATCHDOG — A is structurally blind to a HANG: if a spawn
 *      blocks (e.g. a half-up Infisical, TCP-accepting but not answering,
 *      pre-timeout-fix), the poller logs neither a degraded nor a healthy fetch
 *      — it never reaches "Bootstrap complete." B stamps spawn-initiated and the
 *      tick alerts if "Bootstrap complete" hasn't arrived within X.
 *
 * Both alert TO COMMANDER (not Sondre) via the injected alert callback. The
 * class is pure + injectable (alert fn + clock) so the acceptance criteria are
 * unit-testable without a live daemon or vault. Call `tick()` periodically.
 */

export interface VaultBootAlert {
  detector: 'persistent-tokenless' | 'spawn-watchdog';
  agent: string;
  detail: string;
}

export type AlertFn = (alert: VaultBootAlert) => void;
export type Clock = () => number;

/**
 * T — how long an agent may be CONTINUOUSLY degraded (poller on .env fallback)
 * before alerting. Above the ~2-3min Infisical warmup and the sub-minute benign
 * heal window, so a quick restart-through-warmup heal doesn't trip, but a
 * genuinely-stuck tokenless poller (incl. boot-and-sit) does.
 */
export const DEGRADED_ALERT_MS = 5 * 60_000;

/** X — a spawn must reach "Bootstrap complete" within this, else it's hung. */
export const SPAWN_WATCHDOG_MS = 60_000;

export class VaultBootObserver {
  private degradedSince = new Map<string, number>();    // agent → first degraded ts (cleared on heal)
  private degradedAlerted = new Map<string, boolean>(); // agent → episode alerted (de-dup)
  private spawnStart = new Map<string, number>();        // agent → spawn-initiated ts

  constructor(
    private readonly alert: AlertFn,
    private readonly now: Clock = () => Date.now(),
    private readonly degradedMs: number = DEGRADED_ALERT_MS,
    private readonly watchdogMs: number = SPAWN_WATCHDOG_MS,
  ) {}

  /**
   * Detector A — feed each poller-start vault-fetch result. FEEDS state only;
   * the alert fires from tick(). ok=true ("loaded N secret(s)") heals + clears
   * the episode; ok=false (degraded → .env) stamps the start of a degraded run.
   */
  recordPollerVaultFetch(agent: string, ok: boolean): void {
    if (ok) {
      this.degradedSince.delete(agent);
      this.degradedAlerted.set(agent, false);
      return;
    }
    // Keep the EARLIEST degraded timestamp — a still-degraded re-observation
    // must not reset the clock (that would let a flapping poller dodge T).
    if (!this.degradedSince.has(agent)) this.degradedSince.set(agent, this.now());
  }

  /** Detector B — spawn initiated (poller "Starting. Waiting for bootstrap..."). */
  noteSpawnInitiated(agent: string): void {
    this.spawnStart.set(agent, this.now());
  }

  /** Detector B — spawn reached "Bootstrap complete. Beginning poll loop." (healthy). */
  noteBootstrapComplete(agent: string): void {
    this.spawnStart.delete(agent);
  }

  /**
   * Periodic tick — drives BOTH detectors. Call on an interval from the daemon.
   *   A: alert (once per episode) for any agent continuously degraded ≥ T.
   *   B: alert (once) for any spawn in-flight ≥ X without completing — the HANG.
   */
  tick(): void {
    const t = this.now();
    // A — persistent-tokenless (time-driven)
    for (const [agent, since] of this.degradedSince) {
      if (t - since >= this.degradedMs && !this.degradedAlerted.get(agent)) {
        this.degradedAlerted.set(agent, true);
        this.alert({
          detector: 'persistent-tokenless',
          agent,
          detail: `vault fetch degraded for ${Math.round((t - since) / 1000)}s (threshold ${Math.round(this.degradedMs / 1000)}s) — poller on .env fallback; BOT_TOKEN may be stale/empty for ${agent}. No periodic re-fetch exists; clears only on a restart that hits a healthy vault.`,
        });
      }
    }
    // B — spawn-completion watchdog
    for (const [agent, start] of [...this.spawnStart.entries()]) {
      if (t - start >= this.watchdogMs) {
        this.spawnStart.delete(agent); // de-dup: one alert, stop tracking
        this.alert({
          detector: 'spawn-watchdog',
          agent,
          detail: `spawn initiated but no "Bootstrap complete" within ${Math.round(this.watchdogMs / 1000)}s — likely hung (e.g. half-up vault not answering).`,
        });
      }
    }
  }
}
