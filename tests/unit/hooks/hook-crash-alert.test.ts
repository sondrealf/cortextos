import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { readMaxCrashesPerDay, notifyAgents, classifySessionEndFallthrough, classifyStuckSessionAftershock, NON_CRASH_REASONS, CRASH_ALERT_RECIPIENTS } from '../../../src/hooks/hook-crash-alert';

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

describe('CRASH_ALERT_RECIPIENTS - operator routing', () => {
  it('routes real-crash alerts to the operator (commander)', () => {
    expect(CRASH_ALERT_RECIPIENTS).toContain('commander');
  });

  it('keeps analyst for fleet-health visibility', () => {
    expect(CRASH_ALERT_RECIPIENTS).toContain('analyst');
  });

  it('drops the dead "chief" recipient (no such agent exists)', () => {
    expect(CRASH_ALERT_RECIPIENTS).not.toContain('chief');
  });

  it('forwards each recipient through the bus when used by notifyAgents', () => {
    execFileMock.mockReset();
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'segfault',
      lastTask: 'building',
      crashCount: 1,
      restartAttempted: true,
      recipients: CRASH_ALERT_RECIPIENTS,
    });
    const targets = execFileMock.mock.calls.map(c => (c[1] as string[])[2]);
    expect(targets).toEqual(CRASH_ALERT_RECIPIENTS);
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
