/**
 * Persistent reminder queue (pending-reminders.json).
 *
 * Solves the cron-loss-on-hard-restart problem (#69).
 * Claude Code CronCreate records are in-memory only — they evaporate on hard-restart.
 * This module provides a file-backed queue in state/{agent}/pending-reminders.json
 * that survives any restart type and is injected into the agent boot prompt.
 *
 * Lifecycle:
 *   1. Agent calls `cortextos bus create-reminder <fire-at> <prompt>`
 *   2. LIVE PATH: the daemon's per-agent ReminderDispatcher polls this store
 *      every 30s and injects due reminders into the running session
 *      (pending → fired). See src/daemon/reminder-dispatcher.ts.
 *   3. BOOT PATH (fallback): the boot prompt includes any overdue unacked
 *      reminders — covers fires missed while the daemon/agent was down, and
 *      re-delivers `fired` reminders that were never acked (crash between
 *      injection and handling).
 *   4. Agent processes the reminder, calls `cortextos bus ack-reminder <id>`
 *
 * Status model:
 *   pending — created, not yet dispatched
 *   fired   — injected into a live session by the dispatcher, awaiting ack
 *   acked   — handled by the agent (terminal)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import type { BusPaths } from '../types/index.js';

export interface Reminder {
  id: string;
  created_at: string;
  fire_at: string;      // ISO 8601 UTC — when the reminder should fire
  prompt: string;       // The text to inject when the reminder fires
  status: 'pending' | 'fired' | 'acked';
  acked_at?: string;
  /** Set by the dispatcher just before injection (crash-safety + retry backoff). */
  dispatch_attempted_at?: string;
  /** Set by the dispatcher after a successful live injection. */
  fired_at?: string;
}

function remindersPathFromDir(stateDir: string): string {
  return join(stateDir, 'pending-reminders.json');
}

function remindersPath(paths: BusPaths): string {
  return remindersPathFromDir(paths.stateDir);
}

/** Read the reminder store from an explicit stateDir (daemon-side callers). */
export function readRemindersFromDir(stateDir: string): Reminder[] {
  const filePath = remindersPathFromDir(stateDir);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readReminders(paths: BusPaths): Reminder[] {
  return readRemindersFromDir(paths.stateDir);
}

function writeRemindersToDir(stateDir: string, reminders: Reminder[]): void {
  // Atomic write: the daemon's ReminderDispatcher and agent CLI calls
  // (create/ack) can now touch this file concurrently — a torn read of a
  // half-written JSON array would silently drop every reminder (the reader
  // falls back to []).
  ensureDir(stateDir);
  atomicWriteSync(remindersPathFromDir(stateDir), JSON.stringify(reminders, null, 2));
}

function writeReminders(paths: BusPaths, reminders: Reminder[]): void {
  writeRemindersToDir(paths.stateDir, reminders);
}

/**
 * Create a new persistent reminder.
 * fire_at: ISO 8601 UTC string (e.g. "2026-04-05T08:00:00Z")
 * prompt: text to inject into agent boot prompt when overdue
 */
export function createReminder(paths: BusPaths, fireAt: string, prompt: string): Reminder {
  // Validate fire_at is a parseable date
  const ts = Date.parse(fireAt);
  if (isNaN(ts)) {
    throw new Error(`Invalid fire_at date: "${fireAt}". Use ISO 8601 format, e.g. 2026-04-05T08:00:00Z`);
  }

  const id = `${Date.now()}-reminder-${randomBytes(3).toString('hex')}`;
  const reminder: Reminder = {
    id,
    created_at: new Date().toISOString(),
    fire_at: new Date(ts).toISOString(),
    prompt,
    status: 'pending',
  };

  const reminders = readReminders(paths);
  reminders.push(reminder);
  writeReminders(paths, reminders);
  return reminder;
}

/**
 * List reminders. By default returns only pending ones.
 */
export function listReminders(paths: BusPaths, opts: { all?: boolean } = {}): Reminder[] {
  const reminders = readReminders(paths);
  if (opts.all) return reminders;
  return reminders.filter(r => r.status === 'pending');
}

/**
 * Return unacked reminders whose fire_at is in the past (overdue).
 * Used by agent-process.ts to inject into the boot prompt.
 *
 * Includes BOTH `pending` (never dispatched — daemon was down at fire_at or
 * the dispatch loop failed) and `fired` (dispatched into a session that may
 * have crashed before handling). Re-delivery at boot is idempotent: the agent
 * handles and acks. Only `acked` is excluded.
 */
export function getOverdueReminders(paths: BusPaths): Reminder[] {
  const now = Date.now();
  return readReminders(paths).filter(
    r => r.status !== 'acked' && Date.parse(r.fire_at) <= now,
  );
}

/**
 * Return reminders due for LIVE dispatch by the daemon's ReminderDispatcher:
 * status `pending`, fire_at in the past, and either never attempted or last
 * attempted more than `retryBackoffMs` ago (so a failed injection — agent
 * PTY unavailable, mid-restart — is retried instead of busy-looped).
 */
export function getDueForDispatch(stateDir: string, retryBackoffMs: number): Reminder[] {
  const now = Date.now();
  return readRemindersFromDir(stateDir).filter(r => {
    if (r.status !== 'pending') return false;
    if (Date.parse(r.fire_at) > now) return false;
    if (r.dispatch_attempted_at && now - Date.parse(r.dispatch_attempted_at) < retryBackoffMs) {
      return false;
    }
    return true;
  });
}

/**
 * Persist dispatch_attempted_at for a reminder. Called by the dispatcher
 * BEFORE injection so a crash mid-dispatch leaves a visible attempt marker
 * (and the retry backoff applies) instead of silently re-firing every tick.
 */
export function markDispatchAttempted(stateDir: string, id: string): void {
  const reminders = readRemindersFromDir(stateDir);
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) throw new Error(`Reminder ${id} not found`);
  reminders[idx] = { ...reminders[idx], dispatch_attempted_at: new Date().toISOString() };
  writeRemindersToDir(stateDir, reminders);
}

/**
 * Mark a reminder as fired (successfully injected into a live session).
 * The reminder stays in the store awaiting the agent's ack-reminder call.
 */
export function markReminderFired(stateDir: string, id: string): void {
  const reminders = readRemindersFromDir(stateDir);
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) throw new Error(`Reminder ${id} not found`);
  reminders[idx] = { ...reminders[idx], status: 'fired', fired_at: new Date().toISOString() };
  writeRemindersToDir(stateDir, reminders);
}

/**
 * Acknowledge a reminder by ID — marks it as handled.
 */
export function ackReminder(paths: BusPaths, id: string): void {
  const reminders = readReminders(paths);
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) {
    throw new Error(`Reminder ${id} not found`);
  }
  reminders[idx] = {
    ...reminders[idx],
    status: 'acked',
    acked_at: new Date().toISOString(),
  };
  writeReminders(paths, reminders);
}

/**
 * Delete acked reminders older than retainDays (default 7).
 * Call periodically to prevent unbounded file growth.
 */
export function pruneReminders(paths: BusPaths, retainDays: number = 7): number {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const reminders = readReminders(paths);
  const kept = reminders.filter(r => {
    if (r.status !== 'acked') return true;
    const ackedAt = r.acked_at ? Date.parse(r.acked_at) : 0;
    return ackedAt > cutoff;
  });
  const pruned = reminders.length - kept.length;
  if (pruned > 0) writeReminders(paths, kept);
  return pruned;
}
