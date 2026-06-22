/**
 * reminder-dispatcher.ts — Live dispatch loop for persistent reminders.
 *
 * Closes the gap found 2026-06-05 (coliseum bug capture): pending-reminders.json
 * persisted correctly but NOTHING dispatched reminders into a running session —
 * the only delivery path was boot-prompt injection (agent-process.ts
 * buildReminderBlock), so a reminder created mid-session never fired until the
 * next restart. Crons were unaffected because CronScheduler has its own tick
 * loop; reminders had persistence without dispatch.
 *
 * One ReminderDispatcher is instantiated per enabled agent by agent-manager
 * (alongside its CronScheduler) and ticks every 30 seconds:
 *
 *   1. getDueForDispatch() — pending reminders past fire_at, honoring a 5-min
 *      retry backoff for previously failed attempts.
 *   2. markDispatchAttempted() persisted BEFORE injection — a crash mid-fire
 *      leaves a visible attempt marker instead of an ambiguous pending row.
 *   3. onFire(reminder) — injects the prompt into the agent PTY (caller-supplied,
 *      same injectAgent path crons use).
 *   4. markReminderFired() on success — reminder awaits the agent's
 *      `cortextos bus ack-reminder <id>`.
 *
 * FAILURE POLICY
 * --------------
 * If injection fails (agent not running, PTY unavailable) the reminder STAYS
 * `pending`: the 5-min backoff retries it while the session is up, and the
 * boot-prompt path delivers it if the agent restarts first. Double delivery
 * across the two paths is acceptable (handling + ack is idempotent); silent
 * loss is not.
 */

import {
  getDueForDispatch,
  markDispatchAttempted,
  markReminderFired,
  type Reminder,
} from '../bus/reminders.js';

export interface ReminderDispatcherOptions {
  agentName: string;
  /** Agent state dir containing pending-reminders.json. */
  stateDir: string;
  /** Inject the reminder into the live session. Throw on failure. */
  onFire: (reminder: Reminder) => Promise<void> | void;
  logger?: (msg: string) => void;
}

export class ReminderDispatcher {
  /** Poll cadence — matches CronScheduler.TICK_INTERVAL_MS. */
  static readonly TICK_INTERVAL_MS = 30_000;
  /** Minimum wait before re-attempting a reminder whose injection failed. */
  static readonly RETRY_BACKOFF_MS = 5 * 60_000;

  private readonly agentName: string;
  private readonly stateDir: string;
  private readonly onFire: (reminder: Reminder) => Promise<void> | void;
  private readonly logger: (msg: string) => void;

  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /** Re-entry guard: skip a tick while a previous tick's dispatch is in flight. */
  private ticking = false;

  constructor(opts: ReminderDispatcherOptions) {
    this.agentName = opts.agentName;
    this.stateDir = opts.stateDir;
    this.onFire = opts.onFire;
    this.logger = opts.logger ?? ((msg: string) => process.stdout.write(msg + '\n'));
  }

  start(): void {
    if (this.tickHandle !== null) {
      this.logger('[reminder-dispatcher] start() called while already running — ignored');
      return;
    }
    this.tickHandle = setInterval(() => void this.tick(), ReminderDispatcher.TICK_INTERVAL_MS);
    this.logger(`[reminder-dispatcher] started for agent "${this.agentName}"`);
  }

  stop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.logger(`[reminder-dispatcher] stopped for agent "${this.agentName}"`);
  }

  /** Exposed for tests; production calls come from the interval. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let due: Reminder[];
      try {
        due = getDueForDispatch(this.stateDir, ReminderDispatcher.RETRY_BACKOFF_MS);
      } catch (err) {
        this.logger(
          `[reminder-dispatcher] failed to read reminder store for "${this.agentName}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      for (const reminder of due) {
        try {
          markDispatchAttempted(this.stateDir, reminder.id);
        } catch (err) {
          // Store write failed (or reminder vanished, e.g. concurrent prune) —
          // skip this round; the next tick re-evaluates from disk.
          this.logger(
            `[reminder-dispatcher] could not persist attempt for ${reminder.id}: ` +
            `${err instanceof Error ? err.message : String(err)} — skipping this tick`,
          );
          continue;
        }

        try {
          await Promise.resolve(this.onFire(reminder));
        } catch (err) {
          this.logger(
            `[reminder-dispatcher] injection failed for ${reminder.id} ` +
            `(agent "${this.agentName}"): ${err instanceof Error ? err.message : String(err)} — ` +
            `retrying in ${ReminderDispatcher.RETRY_BACKOFF_MS / 60_000}min ` +
            `(boot prompt covers it if the agent restarts first)`,
          );
          continue; // stays pending; backoff via dispatch_attempted_at
        }

        try {
          markReminderFired(this.stateDir, reminder.id);
          this.logger(
            `[reminder-dispatcher] fired reminder ${reminder.id} for "${this.agentName}" ` +
            `(was due ${reminder.fire_at})`,
          );
        } catch (err) {
          // Injection succeeded but the fired-mark failed — worst case the
          // reminder re-fires after the backoff window. Duplicate delivery
          // beats silent loss; ack-reminder ends the cycle either way.
          this.logger(
            `[reminder-dispatcher] WARNING: ${reminder.id} injected but could not be marked ` +
            `fired: ${err instanceof Error ? err.message : String(err)} — may re-deliver after backoff`,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
