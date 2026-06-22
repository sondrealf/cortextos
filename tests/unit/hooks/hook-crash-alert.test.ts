import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { readMaxCrashesPerDay, notifyAgents, classifySessionEndFallthrough, classifyStuckSessionAftershock, classifyFromMarkers, NON_CRASH_REASONS } from '../../../src/hooks/hook-crash-alert';
import { clearEndMarkers } from '../../../src/bus/heartbeat';

describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

describe('notifyAgents', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('classifySessionEndFallthrough', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-fallthrough-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns crash when reason is empty and no cookie exists', () => {
    expect(classifySessionEndFallthrough({ sessionEndReason: '', stateDir: tmp })).toBe('crash');
  });

  it('returns crash when reason is "other" (not in NON_CRASH_REASONS)', () => {
    expect(classifySessionEndFallthrough({ sessionEndReason: 'other', stateDir: tmp })).toBe('crash');
  });

  it.each([...NON_CRASH_REASONS])('reclassifies "%s" as a session-event-{reason} type', (reason) => {
    expect(classifySessionEndFallthrough({ sessionEndReason: reason, stateDir: tmp }))
      .toBe(`session-event-${reason}`);
  });

  it('returns planned-restart-aftershock when cookie is fresh', () => {
    writeFileSync(join(tmp, '.recent-planned-restart-at'), String(Date.now()), 'utf-8');
    expect(classifySessionEndFallthrough({ sessionEndReason: '', stateDir: tmp }))
      .toBe('planned-restart-aftershock');
  });

  it('returns crash when cookie is older than 60s', () => {
    const staleTs = Date.now() - 61_000;
    writeFileSync(join(tmp, '.recent-planned-restart-at'), String(staleTs), 'utf-8');
    expect(classifySessionEndFallthrough({ sessionEndReason: '', stateDir: tmp })).toBe('crash');
  });

  it('non-crash reason takes priority over fresh cookie', () => {
    writeFileSync(join(tmp, '.recent-planned-restart-at'), String(Date.now()), 'utf-8');
    expect(classifySessionEndFallthrough({ sessionEndReason: 'clear', stateDir: tmp }))
      .toBe('session-event-clear');
  });

  it('returns crash when cookie file contains non-numeric content', () => {
    writeFileSync(join(tmp, '.recent-planned-restart-at'), 'not-a-number', 'utf-8');
    expect(classifySessionEndFallthrough({ sessionEndReason: '', stateDir: tmp })).toBe('crash');
  });
});

describe('classifyStuckSessionAftershock — wedged-session repeat-alert suppression', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-stuck-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('FIRST crash for a session → crash (alerts) and stamps the cookie', () => {
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 1_000 }))
      .toBe('crash');
  });

  it('SECOND crash, SAME session within window → aftershock (suppressed)', () => {
    classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 1_000 });
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 120_000 }))
      .toBe('stuck-session-aftershock');
  });

  it('STORM stays suppressed: many same-session crashes within the sliding window → all aftershocks after the first', () => {
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 0 })).toBe('crash');
    // 8 repeats spread over ~15 min, each within 30min of the previous → all suppressed.
    for (let i = 1; i <= 8; i++) {
      expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: i * 120_000 }))
        .toBe('stuck-session-aftershock');
    }
  });

  it('DIFFERENT session_id (real respawn/crash-loop) → crash, never suppressed', () => {
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 1_000 })).toBe('crash');
    // A genuine crash-loop respawns a NEW session each time → each alerts.
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-B', now: 2_000 })).toBe('crash');
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-C', now: 3_000 })).toBe('crash');
  });

  it('same session but OUTSIDE the window → treated as a fresh crash', () => {
    classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 0 });
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 30 * 60_000 + 1 }))
      .toBe('crash');
  });

  it('missing session_id → fails OPEN (crash), never silently swallowed', () => {
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: '', now: 1_000 })).toBe('crash');
    // even with a prior cookie present, an empty session_id still alerts
    classifyStuckSessionAftershock({ stateDir: tmp, sessionId: 'sess-A', now: 1_000 });
    expect(classifyStuckSessionAftershock({ stateDir: tmp, sessionId: '', now: 2_000 })).toBe('crash');
  });
});

describe('classifyFromMarkers', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-markers-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('no marker present → endType crash', () => {
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('fresh marker → classified by type, with its reason', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    const r = classifyFromMarkers(tmp, MARKERS);
    expect(r.endType).toBe('planned-restart');
    expect(r.reason).toBe('planned reboot');
  });

  it('does NOT consume the marker — both firings of a restart see it', () => {
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    // Firing #1 — the dying PTY's SessionEnd.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    // Firing #2 — the next PTY's fresh-launch cleanup. Marker must still be
    // there: this is the FP that the old unlink-on-read code produced.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
  });

  it('marker older than the TTL → treated as stale: ignored AND lazy-unlinked', () => {
    const markerPath = join(tmp, '.restart-planned');
    writeFileSync(markerPath, 'stale planned restart', 'utf-8');
    // Simulate a marker whose first-heartbeat clear never fired (failed
    // start): classify with a "now" well past the 5-minute TTL.
    const farFuture = Date.now() + 10 * 60 * 1000;
    const r = classifyFromMarkers(tmp, MARKERS, farFuture);
    expect(r.endType).toBe('crash'); // stale marker must NOT mask a real crash
    expect(existsSync(markerPath)).toBe(false); // lazy-unlinked
  });

  it('first matching marker wins (precedence order preserved)', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned', 'utf-8');
    writeFileSync(join(tmp, '.user-stop'), 'stopped', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
  });
});

describe('clearEndMarkers (via heartbeat)', () => {
  let tmp: string;
  const ALL = ['.restart-planned', '.session-refresh', '.user-restart', '.user-stop', '.daemon-stop'];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-clear-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a post-grace heartbeat removes every pending end-type marker', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs well past the grace window — the markers are no longer in-flight.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(false);
  });

  it('leaves a fresh (within-grace) marker in place — an in-flight restart', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs ≈ marker mtime → every marker is within the grace window.
    clearEndMarkers(tmp);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(true);
  });

  it('is a no-op when no markers are present', () => {
    expect(() => clearEndMarkers(tmp)).not.toThrow();
  });
});

describe('marker lifecycle (classify → clearEndMarkers → classify)', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('both restart firings classify, a post-grace heartbeat clears, then a real crash classifies as crash', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    // Firing #1 and #2 of the dying restart — both must see the marker.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    // Post-restart session heartbeats past the grace window → marker cleared.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    expect(existsSync(join(tmp, '.restart-planned'))).toBe(false);
    // A genuine crash AFTER the clear must classify as crash — not be masked.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('a heartbeat DURING the in-flight restart (within grace) does NOT wipe the marker — firing#2 still classifies', () => {
    // This is the Finding-1 race: a fast-booting successor heartbeats before
    // the dying restart's second SessionEnd firing lands.
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #1
    clearEndMarkers(tmp); // successor's first heartbeat — marker still within grace
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #2 — no false crash
  });
});
