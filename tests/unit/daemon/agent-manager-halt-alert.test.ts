/**
 * tests/unit/daemon/agent-manager-halt-alert.test.ts
 *
 * Crash-alert routing-gap fix (task_1781589894239): agent HALT alerts used to go
 * to the HALTED agent's OWN (unwatched) bot thread via
 *   tgApi.sendMessage(tgChatId, "...HALTED...").catch(() => {})
 * — so a multi-agent halt (e.g. a bad fleet-wide auto-update) scattered across
 * unwatched threads AND any send failure was silently swallowed.
 *
 * The fix mirrors emitStallAlert: route HALT to the OPERATOR (commander) with a
 * durable event ALWAYS + a debounced, AGGREGATED operator Telegram. These tests
 * prove the three load-bearing properties:
 *   1. durable event is written for EVERY halt (independent of Telegram/creds),
 *   2. halts within the window AGGREGATE into one pending operator alert,
 *   3. the operator message reads correctly for 1 vs N agents,
 *   4. flush is best-effort — no creds → no throw, buffer still clears.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the PTY / checker / telegram layers so no native bindings or HTTP.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class { async start() {} async stop() {} getStatus() { return { name: '', status: 'stopped' }; } onExit() {} },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));

// Spy on the durable event sink — emitHaltAlert MUST call this for every halt.
const logEvent = vi.fn();
vi.mock('../../../src/bus/event.js', () => ({ logEvent: (...args: unknown[]) => logEvent(...args) }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager — HALT alert operator-routing + aggregation', () => {
  let dir: string;
  let mgr: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    logEvent.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'cortextos-halt-test-'));
    mgr = new AgentManager('test-instance', dir, dir, 'test-org');
  });

  afterEach(() => {
    mgr.clearHaltAggregatorForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a durable critical agent_halted event for every halt', () => {
    mgr.emitHaltAlertForTest('openrouter');
    expect(logEvent).toHaveBeenCalledTimes(1);
    const args = logEvent.mock.calls[0];
    // logEvent(paths, agent, org, category, event, severity, detail)
    expect(args).toContain('openrouter');
    expect(args).toContain('agent_halted');
    expect(args).toContain('critical');
    expect(String(args[args.length - 1])).toContain('cortextos start openrouter');
  });

  it('aggregates halts within the window into ONE pending operator alert', () => {
    mgr.emitHaltAlertForTest('alpha');
    mgr.emitHaltAlertForTest('bravo');
    mgr.emitHaltAlertForTest('charlie');
    // One durable event per agent (none lost) ...
    expect(logEvent).toHaveBeenCalledTimes(3);
    // ... but a SINGLE pending Telegram holding all three (sorted, deduped).
    expect(mgr.haltBufferForTest()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('dedupes a repeated halt of the same agent in the window', () => {
    mgr.emitHaltAlertForTest('openrouter');
    mgr.emitHaltAlertForTest('openrouter');
    expect(mgr.haltBufferForTest()).toEqual(['openrouter']);
  });

  it('flush clears the buffer (and does not throw without commander creds)', () => {
    mgr.emitHaltAlertForTest('alpha');
    mgr.emitHaltAlertForTest('bravo');
    expect(() => mgr.flushHaltAlertsForTest()).not.toThrow();
    expect(mgr.haltBufferForTest()).toEqual([]);
  });

  it('buildHaltMessage: single-agent wording names the agent + restart command', () => {
    const msg = AgentManager.buildHaltMessage(['openrouter']);
    expect(msg).toContain('agent HALTED');
    expect(msg).toContain('openrouter');
    expect(msg).toContain('cortextos start openrouter');
    expect(msg).not.toContain('agents HALTED'); // not the plural form
  });

  it('buildHaltMessage: multi-agent wording reports count + every name', () => {
    const msg = AgentManager.buildHaltMessage(['alpha', 'bravo', 'charlie']);
    expect(msg).toContain('3 agents HALTED');
    expect(msg).toContain('alpha');
    expect(msg).toContain('bravo');
    expect(msg).toContain('charlie');
  });
});
