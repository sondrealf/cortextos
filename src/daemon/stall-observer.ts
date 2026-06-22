/**
 * Fleet stall-watchdog — detects an agent whose session is ALIVE by every OS
 * measure but is making no work-progress, and applies a BOUNDED restart with a
 * loop-breaker. Built for the 2026-06-08 free-mode never-completing-boot-turn
 * incident (task_1780938481333) but framed fleet-wide: it is the obs-detector
 * class for ANY agent wedge, including the original Claude-Code auto-update hang.
 *
 * WHY PID-liveness and stdout are insufficient (proven by that incident): the
 * wedged process was State S, parked in epoll_wait, and RE-RENDERED its TUI at
 * each cron fire (stdout mtime advanced) while executing zero session-start
 * work. "Process alive + stdout moved" proves the process EXISTS, not that the
 * session is doing WORK (the units-prove-logic-not-wiring lesson). So the only
 * trustworthy signal is APP-LEVEL: the agent's own heartbeat (last_seen) failing
 * to advance while crons keep firing and the PID stays alive.
 *
 * REMEDIATION + LOOP-BREAKER (safety-critical): on a confirmed stall the observer
 * triggers a restart, but a restart is FUTILE for some causes (e.g. free-mode's
 * weak model could not boot at all — a naive restart-on-unhonored-cron would
 * thrash forever). So restarts are CAPPED (N within a sliding window M); on
 * exceeding the cap the observer STOPS restarting and ESCALATES to commander.
 * Detection + escalation is the durable value; restart is remediation only where
 * it helps.
 *
 * VERIFY-THE-RESULT-NOT-THE-CLAIM: the daemon crash-handler was observed (same
 * incident) reporting "restart attempted: yes" while the PID was never replaced
 * (a silent no-op restart). So this observer NEVER trusts a "restart was
 * triggered" signal — it confirms success only by OBSERVING boot-completion
 * (a NEW pid AND last_seen advancing past the restart time). A no-op restart
 * therefore heals nothing, the agent stays stalled, and the next evaluation
 * counts ANOTHER failed attempt toward the cap → escalate, rather than looping
 * on a phantom success.
 *
 * Pure + injectable (alert fn + restart fn + clock) so the acceptance criteria
 * are unit-testable without a live daemon. The daemon builds a fleet snapshot
 * each tick and calls `tick(snapshots)`.
 */

export interface AgentStallSnapshot {
  agent: string;
  /** Most recent cron fire time (epoch ms), or null if the agent has no cron / none has fired. */
  lastFireMs: number | null;
  /** Heartbeat last_seen (epoch ms), or null if the agent has never written a heartbeat. */
  lastSeenMs: number | null;
  /** Current process id, or null if not running. Used to detect a real respawn (new pid). */
  pid: number | null;
  /** Whether `pid` is currently alive. */
  pidAlive: boolean;
}

export interface StallAlert {
  /** 'restart' = a bounded remediation restart was triggered; 'escalate' = cap hit, gave up, human needed. */
  kind: 'restart' | 'escalate';
  agent: string;
  detail: string;
}

export type StallAlertFn = (a: StallAlert) => void;
/** Fire-and-forget restart trigger (daemon wires this to restartAgent). */
export type RestartFn = (agent: string) => void;
export type Clock = () => number;

/**
 * How long an agent may be CONTINUOUSLY stalled (pid alive, last_seen not
 * advancing past the latest cron fire) before a stall is CONFIRMED. Set above a
 * single cron interval + grace so a legitimately long single turn — which still
 * honors the NEXT scheduled beat — never trips it; only a genuinely stuck
 * session (last_seen frozen across the window) does. Default 6h comfortably
 * clears a 4h heartbeat cadence with one fully-missed beat.
 */
export const STALL_CONFIRM_MS = 6 * 60 * 60_000;

/** After triggering a restart, how long to wait for OBSERVED boot-completion (new pid + last_seen advance) before counting the attempt as failed. */
export const RESTART_VERIFY_MS = 5 * 60_000;

/** Restart-loop breaker: at most this many restarts within RESTART_WINDOW_MS before the observer gives up and escalates. */
export const RESTART_CAP_N = 2;
export const RESTART_WINDOW_MS = 60 * 60_000;

type AgentState = {
  /** Earliest time we observed this agent continuously stalled (cleared on heal). */
  stalledSince: number | null;
  /** Timestamps of restart triggers within the sliding window. */
  restartAttempts: number[];
  /** Set when a restart was triggered and we are awaiting boot-completion. */
  pendingRestart: { at: number; pidAtRestart: number | null; lastSeenAtRestart: number | null } | null;
  /** True once the cap was hit and we escalated — stop acting, alert once. */
  gaveUp: boolean;
};

export class StallObserver {
  private state = new Map<string, AgentState>();

  constructor(
    private readonly alert: StallAlertFn,
    private readonly restart: RestartFn,
    private readonly now: Clock = () => Date.now(),
    private readonly confirmMs: number = STALL_CONFIRM_MS,
    private readonly verifyMs: number = RESTART_VERIFY_MS,
    private readonly capN: number = RESTART_CAP_N,
    private readonly windowMs: number = RESTART_WINDOW_MS,
  ) {}

  private getState(agent: string): AgentState {
    let s = this.state.get(agent);
    if (!s) {
      s = { stalledSince: null, restartAttempts: [], pendingRestart: null, gaveUp: false };
      this.state.set(agent, s);
    }
    return s;
  }

  /**
   * Is this snapshot "unhonored" — a cron fired but last_seen is behind it while
   * the pid is alive? This is the raw stall signal (sustained-over-time elevates
   * it to a confirmed stall in tick()).
   */
  private isUnhonored(s: AgentStallSnapshot): boolean {
    if (!s.pidAlive) return false;
    if (s.lastFireMs === null || s.lastSeenMs === null) return false;
    // A beat is unhonored if the most recent cron fire is newer than the last
    // heartbeat — i.e. the agent did not process (or did not survive) that beat.
    return s.lastFireMs > s.lastSeenMs;
  }

  /**
   * Periodic evaluation. The daemon passes the current fleet snapshot each tick.
   * Drives the per-agent state machine: NORMAL → stalled → (restart, bounded) →
   * heal-on-observed-boot-completion OR escalate-on-cap.
   */
  tick(snapshots: AgentStallSnapshot[]): void {
    const t = this.now();
    for (const snap of snapshots) {
      const s = this.getState(snap.agent);

      // 1. HEAL CHECK — did a pending restart (or any prior stall) actually recover?
      //    Recovery is proven ONLY by observed boot-completion: a NEW pid AND
      //    last_seen advanced past the restart time. Never by "restart attempted".
      if (s.pendingRestart) {
        const healed =
          snap.pidAlive &&
          snap.pid !== null &&
          snap.pid !== s.pendingRestart.pidAtRestart &&
          snap.lastSeenMs !== null &&
          snap.lastSeenMs > s.pendingRestart.at;
        if (healed) {
          // Real recovery: reset everything (fresh slate for this agent).
          s.pendingRestart = null;
          s.stalledSince = null;
          s.gaveUp = false;
          continue;
        }
        // Still within the verify window → keep waiting (don't double-restart).
        if (t - s.pendingRestart.at < this.verifyMs) continue;
        // Verify window elapsed with NO observed boot-completion → the restart
        // was a no-op / failed. The attempt was already counted when triggered;
        // clear pending so the stall logic below can act again (next restart or
        // escalate at the cap). This is what neutralizes the silent-no-op-restart
        // bug: a phantom restart heals nothing and burns an attempt toward the cap.
        s.pendingRestart = null;
      }

      const unhonored = this.isUnhonored(snap);

      // 2. NOT stalled → heal/reset.
      if (!unhonored) {
        s.stalledSince = null;
        // A clean heartbeat clears the give-up latch too (agent is healthy again).
        if (snap.lastSeenMs !== null && snap.lastFireMs !== null && snap.lastSeenMs >= snap.lastFireMs) {
          s.gaveUp = false;
        }
        continue;
      }

      // 3. Stalled. Start/continue the stall clock.
      if (s.stalledSince === null) s.stalledSince = t;
      if (s.gaveUp) continue; // already escalated; do not loop.
      if (t - s.stalledSince < this.confirmMs) continue; // not yet a CONFIRMED stall.

      // 4. CONFIRMED stall → bounded remediation.
      s.restartAttempts = s.restartAttempts.filter((ts) => t - ts < this.windowMs);
      if (s.restartAttempts.length >= this.capN) {
        // Loop-breaker: cap hit. STOP restarting, escalate to commander once.
        s.gaveUp = true;
        this.alert({
          kind: 'escalate',
          agent: snap.agent,
          detail: `stall persisted through ${s.restartAttempts.length} bounded restart(s) in ${Math.round(this.windowMs / 60000)}min without observed boot-completion — restart is not recovering ${snap.agent} (likely a non-transient cause: weak-model boot failure, config, or a no-op restart path). STOPPING restarts; human/commander action required.`,
        });
        continue;
      }
      // Trigger a bounded restart and await observed boot-completion.
      s.restartAttempts.push(t);
      s.pendingRestart = { at: t, pidAtRestart: snap.pid, lastSeenAtRestart: snap.lastSeenMs };
      this.alert({
        kind: 'restart',
        agent: snap.agent,
        detail: `confirmed stall (pid alive, last_seen frozen ${Math.round((t - (snap.lastSeenMs ?? t)) / 60000)}min behind the latest cron fire) — triggering bounded restart ${s.restartAttempts.length}/${this.capN}. Will confirm recovery by observed new-pid + last_seen advance within ${Math.round(this.verifyMs / 60000)}min; a no-op restart counts as a failed attempt.`,
      });
      this.restart(snap.agent);
    }
  }
}
