/**
 * SessionEnd hook - crash alert via Telegram.
 * Categorizes session end type and sends notification.
 *
 * Behavior:
 *   - Detects Anthropic weekly/5h rate-limit messages in stdout.log and
 *     classifies the exit as "rate-limited" so it is suppressed rather than
 *     spamming a 🚨 CRASH alert every 30 minutes while the daemon respawn
 *     loop continues hitting the wall.
 *   - Applies quiet hours (22:00-07:00 America/Los_Angeles) for routine end
 *     types (planned-restart, session-refresh, daemon-stop, user-*,
 *     rate-limited). A real unexpected crash still pages at night.
 *   - Deduplicates identical alerts for the same agent within 10 minutes so a
 *     broken watchdog loop results in at most one notification, not a buzz
 *     storm.
 *   - Reads SessionEnd reason from stdin (Claude Code hook payload). Non-crash
 *     reasons (clear, logout, prompt_input_submit, compact) are reclassified as
 *     session-event-{reason} and suppressed — no Telegram, no crash count.
 *   - Writes a .recent-planned-restart-at cookie when a planned end type is
 *     detected. A second SessionEnd that fires within 60s with no marker is
 *     reclassified as planned-restart-aftershock and suppressed.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';

const DEDUP_WINDOW_MS = 10 * 60 * 1000;         // 10 minutes
const QUIET_HOUR_START_LA = 22;                 // 22:00 America/Los_Angeles
const QUIET_HOUR_END_LA = 7;                    // 07:00 America/Los_Angeles
const AFTERSHOCK_WINDOW_MS = 60_000;            // 60 seconds
// Stuck-session aftershock window: a wedged (alive-but-no-progress) session can
// emit repeated 'crash'-classified SessionEnds bearing the SAME session_id over
// many minutes (2026-06-08 free-mode stall: 8 crash alerts in ~15min, same
// session, zero restarts.log entries — no real respawn). One alert per session
// is enough; suppress the rest while the same session keeps firing.
const STUCK_AFTERSHOCK_WINDOW_MS = 30 * 60_000; // 30 minutes

// SessionEnd reasons from Claude Code that indicate a clean/intentional exit,
// not a crash. These are reclassified to session-event-{reason} and suppressed.
export const NON_CRASH_REASONS = new Set(['clear', 'logout', 'prompt_input_submit', 'compact']);

// End types that are routine and should be suppressed during quiet hours.
// "crash" is deliberately NOT in this list — a genuine unexpected crash at
// 3am is worth waking up for.
const QUIET_SUPPRESSED_TYPES = new Set([
  'planned-restart',
  'session-refresh',
  'daemon-stop',
  'user-restart',
  'user-disable',
  'user-stop',
  'rate-limited',
  'planned-restart-aftershock',
  'stuck-session-aftershock',
]);

function isQuietHoursLA(now: Date): boolean {
  const laString = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
  });
  const m = laString.match(/\d+\/\d+\/\d+,?\s+(\d+):/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);
  // Window wraps midnight: 22:00-23:59 OR 00:00-06:59
  return hour >= QUIET_HOUR_START_LA || hour < QUIET_HOUR_END_LA;
}

/**
 * Scan the tail of stdout.log for Anthropic rate-limit or weekly-limit
 * signatures. Mirrors OutputBuffer.hasRateLimitSignature so the hook and the
 * daemon use the same detection logic.
 */
function detectRateLimitInLog(logPath: string): boolean {
  try {
    const size = statSync(logPath).size;
    const readBytes = Math.min(size, 200 * 1024); // last 200 KB
    const fd = readFileSync(logPath);
    const slice = fd.slice(Math.max(0, fd.length - readBytes)).toString('utf-8');
    const text = slice.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    return (
      text.includes('overloaded_error') ||
      text.includes('rate_limit_error') ||
      text.includes('rate limit') ||
      text.includes('rate-limit') ||
      text.includes('too many requests') ||
      text.includes('quota exceeded') ||
      text.includes('usage limit') ||
      text.includes('weekly limit') ||
      text.includes('5-hour limit') ||
      text.includes('5h limit') ||
      /used \d+% of your/.test(text)
    );
  } catch {
    return false;
  }
}

/**
 * Read max_crashes_per_day from the agent's config.json. Returns null if the
 * file is missing, malformed, or the field is not a number — caller treats
 * null as "no limit configured" so a missing config never blocks the alert.
 */
export function readMaxCrashesPerDay(agentDir: string | undefined): number | null {
  if (!agentDir) return null;
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    return typeof cfg.max_crashes_per_day === 'number' ? cfg.max_crashes_per_day : null;
  } catch {
    return null;
  }
}

/**
 * Send a crash notification via `cortextos bus send-message` to the listed
 * recipient agents. Best-effort: failures are swallowed so an alert miss never
 * cascades into a hook crash.
 */
export function notifyAgents(opts: {
  agentName: string;
  endType: string;
  reason: string;
  lastTask: string;
  crashCount: number;
  restartAttempted: boolean;
  recipients: string[];
}): void {
  const body = [
    `agent=${opts.agentName} crashed (type=${opts.endType})`,
    `reason: ${opts.reason || 'none'}`,
    `last status: ${opts.lastTask || 'unknown'}`,
    `crashes today: ${opts.crashCount}`,
    `restart attempted: ${opts.restartAttempted ? 'yes' : 'no (max_crashes_per_day reached)'}`,
  ].join('\n');
  // PATH-unaware execFile is unreliable on Windows: the daemon spawned by
  // PM2 doesn't inherit the npm-link target, so 'cortextos' fails ENOENT and
  // crash alerts are silently dropped — operator loses visibility into the
  // very crashes this hook exists to surface. Invoke via process.execPath +
  // dist/cli.js path (same pattern as fast-checker.ts heartbeat watchdog).
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const cliPath = frameworkRoot ? join(frameworkRoot, 'dist', 'cli.js') : null;
  for (const target of opts.recipients) {
    try {
      if (cliPath) {
        execFile(
          process.execPath,
          [cliPath, 'bus', 'send-message', target, 'high', body],
          { timeout: 10_000 },
          () => { /* fire-and-forget */ },
        );
      } else {
        // Fallback: CTX_FRAMEWORK_ROOT unset (rare — test env). Try PATH lookup.
        execFile(
          'cortextos',
          ['bus', 'send-message', target, 'high', body],
          { timeout: 10_000 },
          () => { /* fire-and-forget */ },
        );
      }
    } catch { /* best-effort, never throw */ }
  }
}

/**
 * Return true if an identical (agent, type) alert was already sent within
 * the dedup window. Side effect: records this attempt when it is the first.
 */
function shouldSuppressDedup(stateDir: string, endType: string): boolean {
  const dedupFile = join(stateDir, '.crash_alert_dedup.json');
  const now = Date.now();
  let last: Record<string, number> = {};
  try {
    last = JSON.parse(readFileSync(dedupFile, 'utf-8')) as Record<string, number>;
  } catch { /* missing or corrupt — start fresh */ }
  const prev = last[endType] ?? 0;
  if (now - prev < DEDUP_WINDOW_MS) {
    return true;
  }
  last[endType] = now;
  try {
    writeFileSync(dedupFile, JSON.stringify(last), 'utf-8');
  } catch { /* ignore */ }
  return false;
}

/**
 * A restart marker is valid for the hook only while younger than this. The TTL
 * budget runs from when the marker is WRITTEN — which is inside sessionRefresh
 * BEFORE `await stop()` — to the LAST hook firing it must still classify, i.e.
 * firing#2. So the budget must cover: stop()'s PTY-exit wait + the inter-firing
 * gap. The inter-firing gap is ~13-22s typical; stop() is normally fast but is
 * NOT bounded — BUG-011 exists precisely because PTY exit can hang. 300s is
 * sized to absorb a slow stop() on top of the firing gap, not just the gap.
 *
 * The daemon's post-restart heartbeat is the primary clear (see updateHeartbeat
 * in src/bus/heartbeat.ts). This TTL is the BACKSTOP for a failed start that
 * never heartbeats: a marker older than the TTL is treated as stale, ignored,
 * and lazy-unlinked, so it cannot misclassify a genuine crash arbitrarily far
 * in the future.
 *
 * Sized on a deliberate cost asymmetry: a TTL too tight re-exposes the exact
 * false-positive bug (it would ignore the marker at a slow firing#2); a TTL too
 * generous only widens the bounded failed-start false-negative window — which
 * the heartbeat-staleness monitor catches as a secondary path anyway.
 */
const MARKER_TTL_MS = 300_000; // 5 minutes

/**
 * Read the SessionEnd reason from the Claude Code hook payload on stdin.
 * Returns empty string if stdin is unavailable or the payload is non-JSON.
 */
function readSessionEndPayload(): { reason: string; sessionId: string } {
  try {
    const raw = readFileSync(0, 'utf-8').trim();
    if (!raw) return { reason: '', sessionId: '' };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      // Claude Code SessionEnd payload carries session_id; it is stable for the
      // life of one session and changes on respawn — the discriminator the
      // stuck-session aftershock rule keys on.
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : '',
    };
  } catch {
    return { reason: '', sessionId: '' };
  }
}

/**
 * Rule 3 — stuck-session aftershock suppression. A genuine crash kills the
 * process; the daemon respawns it as a NEW session (new session_id). So a
 * 'crash'-classified SessionEnd whose session_id MATCHES the immediately-prior
 * crash alert's session_id (within the window) is not a fresh crash — it is the
 * same wedged session emitting repeat SessionEnds. The FIRST crash for a session
 * alerts normally and stamps the cookie; subsequent same-session crashes are
 * reclassified to 'stuck-session-aftershock' (logged, but no Telegram/bus alert,
 * no crash-count increment). A real crash-loop respawns distinct session_ids, so
 * it is never wrongly suppressed.
 *
 * Returns 'crash' (alert) or 'stuck-session-aftershock' (suppress). Exported for
 * unit testing.
 */
export function classifyStuckSessionAftershock(opts: {
  stateDir: string;
  sessionId: string;
  now?: number;
}): 'crash' | 'stuck-session-aftershock' {
  // No session_id → cannot discriminate; fail OPEN (treat as a real crash so we
  // never silently swallow a genuine one).
  if (!opts.sessionId) return 'crash';
  const now = opts.now ?? Date.now();
  const cookiePath = join(opts.stateDir, '.last-crash-session');
  let prev: { sid: string; at: number } | null = null;
  try {
    const [sid, at] = readFileSync(cookiePath, 'utf-8').trim().split('\t');
    const atMs = parseInt(at, 10);
    if (sid && !isNaN(atMs)) prev = { sid, at: atMs };
  } catch { /* no cookie — first crash */ }

  const isAftershock =
    prev !== null && prev.sid === opts.sessionId && now - prev.at < STUCK_AFTERSHOCK_WINDOW_MS;

  // Refresh the cookie either way: on a real first crash to start the window, on
  // an aftershock to keep a sustained storm suppressed (sliding window).
  try {
    writeFileSync(cookiePath, `${opts.sessionId}\t${now}`, 'utf-8');
  } catch { /* ignore */ }

  return isAftershock ? 'stuck-session-aftershock' : 'crash';
}

/**
 * Write a cookie recording the timestamp of the most recent planned end type
 * so that a second SessionEnd within 60s can be recognised as an aftershock.
 */
function writePlannedRestartCookie(stateDir: string): void {
  try {
    writeFileSync(join(stateDir, '.recent-planned-restart-at'), String(Date.now()), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Apply the two false-positive suppression rules when no marker was found and
 * rate-limit detection did not match. Returns the final endType string.
 *
 * Rule 1 — non-crash SessionEnd reason: clear/logout/prompt_input_submit/compact
 *   → reclassify as session-event-{reason}, suppress Telegram + crash count
 *
 * Rule 2 — planned-restart aftershock: a second SessionEnd within 60s of a
 *   planned restart (cookie present and fresh)
 *   → reclassify as planned-restart-aftershock, suppress Telegram + crash count
 *
 * Exported for unit testing.
 */
export function classifySessionEndFallthrough(opts: {
  sessionEndReason: string;
  stateDir: string;
}): string {
  if (NON_CRASH_REASONS.has(opts.sessionEndReason)) {
    return `session-event-${opts.sessionEndReason}`;
  }
  const cookiePath = join(opts.stateDir, '.recent-planned-restart-at');
  try {
    const ts = parseInt(readFileSync(cookiePath, 'utf-8').trim(), 10);
    if (!isNaN(ts) && Date.now() - ts < AFTERSHOCK_WINDOW_MS) {
      return 'planned-restart-aftershock';
    }
  } catch { /* no cookie — genuine crash */ }
  return 'crash';
}

/**
 * Classify a SessionEnd from the state markers, returning the marker-derived
 * end type + reason — WITHOUT consuming the marker. PRIMARY classifier: checked
 * FIRST in main(), so the restart double-fire (two firings, DIFFERENT
 * session_ids) is fully handled here before any id-based rule is reached.
 *
 * Why no-consume: a single restart fires the SessionEnd hook TWICE for one
 * logical session-end (~13-22s apart) — once from the dying PTY, once from
 * the next PTY's fresh-launch cleanup. Every restart path writes exactly ONE
 * hook-recognized marker. The previous code unlinked the marker on the first
 * firing, so the second firing found nothing and was logged as a false
 * `type=crash reason=none` — the FP pairs in crashes.log. Leaving the marker
 * in place lets BOTH firings classify correctly. The marker is cleared by the
 * daemon's first-post-restart heartbeat (the successor session is genuinely
 * up by then), with the TTL above as the failed-start backstop.
 *
 * A marker older than MARKER_TTL_MS is treated as stale: ignored (so it
 * cannot misclassify a later genuine crash) and lazy-unlinked here.
 *
 * Returns { endType: 'crash' } when no fresh marker is present.
 */
export function classifyFromMarkers(
  stateDir: string,
  markers: { file: string; type: string }[],
  nowMs: number = Date.now(),
): { endType: string; reason: string } {
  for (const marker of markers) {
    const markerPath = join(stateDir, marker.file);
    if (!existsSync(markerPath)) continue;
    let ageMs = 0;
    try {
      ageMs = nowMs - statSync(markerPath).mtimeMs;
    } catch { /* unreadable mtime — treat as fresh, fall through to classify */ }
    if (ageMs > MARKER_TTL_MS) {
      // Stale: the first-heartbeat clear evidently never fired (failed
      // start). Do not classify from it — lazy-unlink and keep looking.
      try { unlinkSync(markerPath); } catch { /* ignore */ }
      continue;
    }
    let reason = '';
    try {
      reason = readFileSync(markerPath, 'utf-8').trim();
    } catch { /* ignore */ }
    return { endType: marker.type, reason };
  }
  return { endType: 'crash', reason: '' };
}

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  const stateDir = join(ctxRoot, 'state', agentName);
  const logDir = join(ctxRoot, 'logs', agentName);

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // Read SessionEnd reason + session_id from Claude Code hook stdin payload
  // before anything else so they are available for fallthrough classification.
  // session_id is recorded in crashes.log for audit AND used by Rule 3 to
  // suppress a wedged session's SAME-id repeat — never for the restart
  // double-fire (DIFFERENT session_ids), which the marker path owns first.
  const { reason: sessionEndReason, sessionId } = readSessionEndPayload();

  // Determine end type from state markers (written by other parts of the
  // system before the Claude Code session exits). Markers are NOT consumed
  // here — see classifyFromMarkers for why (restart fires this hook twice).
  const markers = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-disable', type: 'user-disable' },
    { file: '.user-stop', type: 'user-stop' },
    // .daemon-crashed wins over .daemon-stop when both are present — a crash
    // during shutdown is the more important signal. Written by the daemon's
    // uncaughtException handler in src/daemon/index.ts.
    { file: '.daemon-crashed', type: 'daemon-crashed' },
    { file: '.daemon-stop', type: 'daemon-stop' },
  ];

  const classified = classifyFromMarkers(stateDir, markers);
  let endType = classified.endType;
  let reason = classified.reason;

  // When a planned end type is detected, stamp a cookie so a second SessionEnd
  // that fires shortly after (the "aftershock") can be suppressed.
  if (endType !== 'crash' && endType !== 'daemon-crashed') {
    writePlannedRestartCookie(stateDir);
  }

  // If no marker matched but the stdout tail shows a rate-limit signature,
  // reclassify as rate-limited. Prevents the 30-minute 🚨 CRASH buzz storm
  // when the weekly limit is exhausted.
  if (endType === 'crash') {
    const stdoutPath = join(logDir, 'stdout.log');
    if (existsSync(stdoutPath) && detectRateLimitInLog(stdoutPath)) {
      endType = 'rate-limited';
      reason = 'anthropic rate limit detected in stdout.log';
    }
  }

  // Apply false-positive suppression for non-crash SessionEnd reasons and
  // planned-restart aftershocks.
  if (endType === 'crash') {
    endType = classifySessionEndFallthrough({ sessionEndReason, stateDir });
  }

  // Rule 3 — stuck-session aftershock: a still-'crash' SessionEnd whose
  // session_id matches a recent crash alert is a wedged session re-firing, not a
  // fresh crash. Suppresses the repeat-alert storm (free-mode 2026-06-08) while
  // a real crash-loop (distinct session_ids per respawn) still alerts each time.
  if (endType === 'crash') {
    endType = classifyStuckSessionAftershock({ stateDir, sessionId });
  }

  // Track crash count (real crashes only).
  const today = new Date().toISOString().split('T')[0];
  const countFile = join(stateDir, '.crash_count_today');
  let crashCount = 0;
  if (endType === 'crash') {
    try {
      const data = readFileSync(countFile, 'utf-8').trim();
      const [date, count] = data.split(':');
      crashCount = date === today ? parseInt(count, 10) + 1 : 1;
    } catch {
      crashCount = 1;
    }
    try {
      writeFileSync(countFile, `${today}:${crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  } else if (endType === 'daemon-crashed') {
    // Read-only: surface today's count to chief/analyst without mutating it.
    try {
      const data = readFileSync(countFile, 'utf-8').trim();
      const [date, count] = data.split(':');
      crashCount = date === today ? parseInt(count, 10) : 0;
    } catch {
      crashCount = 0;
    }
  }

  // Read last heartbeat for context
  let lastTask = '';
  try {
    const hb = JSON.parse(readFileSync(join(stateDir, 'heartbeat.json'), 'utf-8'));
    lastTask = hb.status || '';
  } catch { /* ignore */ }

  // Always log to crashes.log — we want visibility even when alerts are muted.
  // Log BOTH session (upstream audit id — no session_id dedup; two lines sharing
  // a session value make any duplicate-firing FP provable) AND sessionend_reason
  // (our diagnostic for suppressed events).
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} type=${endType} reason=${reason || 'none'} session=${sessionId || 'unknown'} last_task=${lastTask} sessionend_reason=${sessionEndReason || 'none'}\n`;
  try {
    appendFileSync(join(logDir, 'crashes.log'), logLine);
  } catch { /* ignore */ }

  // Decide whether to actually send to Telegram.
  const now = new Date();
  const quiet = isQuietHoursLA(now);
  if (quiet && QUIET_SUPPRESSED_TYPES.has(endType)) {
    return;
  }
  if (shouldSuppressDedup(stateDir, endType)) {
    return;
  }

  // Real-crash agent alerts: notify chief + analyst on crash and daemon-crashed
  // so silent failures get visibility on the bus, not just on Telegram. Gated
  // by the same dedup window as the Telegram send (handled above), and skipped
  // for clean exits / planned restarts / rate-limit pauses. Hoisted above the
  // Telegram-credential gate so agents without BOT_TOKEN/CHAT_ID still reach
  // the bus (issue #317).
  if (endType === 'crash' || endType === 'daemon-crashed') {
    const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
    const maxCrashes = readMaxCrashesPerDay(agentDir);
    const restartAttempted = maxCrashes === null || crashCount < maxCrashes;
    notifyAgents({
      agentName,
      endType,
      reason,
      lastTask,
      crashCount,
      restartAttempted,
      recipients: ['chief', 'analyst'],
    });
  }

  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  if (!botToken || !chatId) return;

  let message = '';
  switch (endType) {
    case 'planned-restart':
      message = reason?.startsWith('CONTEXT-FORCE-RESTART')
        ? `🔄 ${agentName} restarting with memory`
        : `🔄 ${agentName} restarted (planned): ${reason || 'no reason given'}`;
      break;
    case 'session-refresh':
      message = `♻️ ${agentName} session refresh (context exhaustion). Restarting with fresh session.`;
      break;
    case 'user-restart':
      message = `🔄 ${agentName} restarted by user: ${reason || 'no reason given'}`;
      break;
    case 'user-disable':
      message = `⏸️ ${agentName} disabled by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'user-stop':
      message = `⏹️ ${agentName} stopped by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'daemon-stop':
      message = `🛑 ${agentName} stopped (daemon shutdown).`;
      if (reason) message += ` (${reason})`;
      break;
    case 'daemon-crashed':
      // Deliberately NOT suppressed during quiet hours — a daemon crash at
      // 3am is genuinely worth waking for (historically it has preceded
      // fleet-wide restart storms). Crash-loop alerts from the daemon
      // itself add operator-level urgency; this is the per-agent variant
      // that replaces the misleading "🚨 agent crashed" message users
      // were getting on every daemon respawn.
      message = `🚨 ${agentName} — daemon crashed, session was interrupted. Resuming.`;
      if (reason) message += `\nCrash time: ${reason}`;
      break;
    case 'rate-limited':
      message = `⏳ ${agentName} paused — Anthropic rate limit hit. Will resume when the window resets.`;
      break;
    case 'crash':
      message = `🚨 CRASH: ${agentName} died unexpectedly.`;
      if (crashCount > 0) message += ` Crashes today: ${crashCount}.`;
      if (lastTask) message += `\nLast status: ${lastTask}`;
      break;
    // Suppressed types — logged to crashes.log but no Telegram alert.
    // planned-restart-aftershock: second SessionEnd fired within 60s of a
    //   planned restart (Claude Code emits SessionEnd twice on some exit paths).
    // session-event-*: clean Claude Code exits (clear/logout/compact/etc.) that
    //   are not crashes — most commonly auto-compact after a heavy session.
    case 'planned-restart-aftershock':
    default:
      // message stays '' — if (message) guard below prevents any send
      break;
  }

  if (message) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    } catch { /* ignore send failures */ }
  }
}

main().catch(() => process.exit(0));
