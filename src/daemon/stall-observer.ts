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

/**
 * Restart-loop breaker: at most this many bounded restarts WITHOUT a proven
 * post-restart recovery before the observer gives up and escalates.
 *
 * The cap is counted as `restartCount` since the last PROVEN recovery — NOT as
 * timestamps in a sliding wall-clock window. The old wall-clock window
 * (RESTART_WINDOW_MS) made escalation STRUCTURALLY UNREACHABLE for a slow stall:
 * a re-stall takes STALL_CONFIRM_MS (6h) to re-confirm, so consecutive restart
 * attempts were always >1h apart and aged out of the 1h window before the next
 * one landed — the cap of 2 was never reached and the agent thrashed (restart
 * every ~6h) forever (task_1781590135871; openrouter cap-wedge: 1 restart,
 * 0 escalates). Counting since-last-recovery decouples the cap from cron cadence.
 */
export const RESTART_CAP_N = 2;
/** @deprecated Superseded by since-last-recovery counting; retained for constructor signature compatibility (ignored). */
export const RESTART_WINDOW_MS = 60 * 60_000;

type AgentState = {
  /** Earliest time we observed this agent continuously stalled (cleared only on PROVEN recovery / legit heal). */
  stalledSince: number | null;
  /** Count of bounded restarts triggered since the last PROVEN post-restart recovery. Escalate at capN. */
  restartCount: number;
  /** Time of the most recent restart trigger (epoch ms), or null. Recovery must honor a cron fire AFTER this. */
  lastRestartAt: number | null;
  /** Timestamp of the in-flight restart trigger we're awaiting (verify-window double-restart guard), or null. */
  pendingRestart: number | null;
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
      s = { stalledSince: null, restartCount: 0, lastRestartAt: null, pendingRestart: null, gaveUp: false };
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
   * Has the agent honored a cron beat that fired AFTER its most recent restart?
   * This is the ONLY trustworthy proof of sustained recovery. A one-shot boot
   * heartbeat (last_seen bumped once at spawn) does NOT qualify: between cron
   * fires a wedged agent is indistinguishable from a healthy one, so we require
   * it to keep up with a beat that fired AFTER the restart. This is the inverse
   * of our fired-but-unhonored wedge diagnostic — and it is what makes a
   * boot-flicker false-heal (new pid + single boot heartbeat, then re-wedge)
   * NOT count as recovery, so a cap-wedged agent's restartCount climbs to the
   * cap and escalate fires instead of thrashing silently.
   */
  private honoredPostRestart(s: AgentState, snap: AgentStallSnapshot): boolean {
    return (
      s.lastRestartAt !== null &&
      snap.lastFireMs !== null &&
      snap.lastSeenMs !== null &&
      snap.lastFireMs > s.lastRestartAt &&
      snap.lastSeenMs >= snap.lastFireMs
    );
  }

  /**
   * Inspect per-agent state — test seam for the instrumented loop-breaker proof
   * (assert restartCount climbs to capN then gaveUp on a cap-wedge, and resets to
   * 0 on a proven post-restart recovery). Read-only snapshot.
   */
  peekStateForTest(agent: string): { stalledSince: number | null; restartCount: number; lastRestartAt: number | null; pendingRestart: number | null; gaveUp: boolean } {
    const s = this.getState(agent);
    return { stalledSince: s.stalledSince, restartCount: s.restartCount, lastRestartAt: s.lastRestartAt, pendingRestart: s.pendingRestart, gaveUp: s.gaveUp };
  }

  /**
   * Periodic evaluation. The daemon passes the current fleet snapshot each tick.
   * Drives the per-agent state machine: NORMAL → stalled → (restart, bounded) →
   * proven-recovery-resets OR escalate-after-capN-restarts-without-recovery.
   */
  tick(snapshots: AgentStallSnapshot[]): void {
    const t = this.now();
    for (const snap of snapshots) {
      const s = this.getState(snap.agent);

      // 1. PROVEN-SUSTAINED RECOVERY — the agent honored a cron beat that fired
      //    AFTER the last restart. The ONLY signal that resets escalation
      //    progress. A one-shot boot heartbeat does NOT qualify (see
      //    honoredPostRestart). Fresh slate for this agent.
      if (this.honoredPostRestart(s, snap)) {
        s.stalledSince = null;
        s.restartCount = 0;
        s.lastRestartAt = null;
        s.pendingRestart = null;
        s.gaveUp = false;
        continue;
      }

      // 2. VERIFY-WINDOW GUARD — while a restart is still within its verify
      //    window, don't act (avoid a premature double restart). After it
      //    elapses, clear it and let the logic below decide. (Recovery is NOT
      //    judged here anymore — only by honoredPostRestart above, which closes
      //    the boot-flicker false-heal that reset escalation progress.)
      if (s.pendingRestart !== null) {
        if (t - s.pendingRestart < this.verifyMs) continue;
        s.pendingRestart = null;
      }

      const unhonored = this.isUnhonored(snap);

      // 3. NOT currently unhonored.
      if (!unhonored) {
        if (s.lastRestartAt === null) {
          // Never-restarted agent honoring its beats → legit heal (the
          // transient long-turn case). Clear the stall clock + give-up latch.
          s.stalledSince = null;
          if (snap.lastSeenMs !== null && snap.lastFireMs !== null && snap.lastSeenMs >= snap.lastFireMs) {
            s.gaveUp = false;
          }
        }
        // Restarted agent that is NOT unhonored but has NOT honored a
        // post-restart beat (the post-restart "quiet window" between cron fires,
        // or pid briefly down mid-restart): AMBIGUOUS — could be a boot-flicker
        // about to re-wedge. HOLD: do NOT reset stalledSince or restartCount.
        // Resetting here was the loop-breaker bug — a one-shot boot heartbeat
        // looked like recovery and erased escalation progress, so escalate never
        // fired (silent ~6h thrash). Recovery is decided ONLY by step 1.
        continue;
      }

      // 4. Unhonored → start/continue the stall clock.
      if (s.stalledSince === null) s.stalledSince = t;
      if (s.gaveUp) continue; // already escalated; do not loop.
      if (t - s.stalledSince < this.confirmMs) continue; // not yet a CONFIRMED stall.

      // 5. CONFIRMED stall → bounded remediation or escalate.
      if (s.restartCount >= this.capN) {
        // Loop-breaker: capN restarts have fired and NONE produced a proven
        // post-restart recovery → restart is not recovering this agent. STOP
        // restarting, escalate to commander once.
        s.gaveUp = true;
        this.alert({
          kind: 'escalate',
          agent: snap.agent,
          detail: `stall persisted through ${s.restartCount} bounded restart(s) without the agent ever honoring a post-restart cron beat — restart is not recovering ${snap.agent} (likely a non-transient cause: credit/cap-wedge, weak-model boot failure, config, or a no-op restart path). STOPPING restarts; human/commander action required.`,
        });
        continue;
      }
      // Trigger a bounded restart; recovery is proven only by honoring a beat
      // that fires AFTER this restart (a boot-flicker does not count).
      s.restartCount += 1;
      s.lastRestartAt = t;
      s.pendingRestart = t;
      this.alert({
        kind: 'restart',
        agent: snap.agent,
        detail: `confirmed stall (pid alive, last_seen frozen ${Math.round((t - (snap.lastSeenMs ?? t)) / 60000)}min behind the latest cron fire) — triggering bounded restart ${s.restartCount}/${this.capN}. Recovery is confirmed ONLY by the agent honoring a cron beat that fires AFTER this restart; a one-shot boot heartbeat that then re-wedges counts as a failed restart toward the cap.`,
      });
      this.restart(snap.agent);
    }
  }
}
