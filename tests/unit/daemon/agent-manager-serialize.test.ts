import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// BUG-011 follow-up: pins per-agent serialization. The legacy fix used a
// pendingRestarts Set + warn lines as a safety net; this test guarantees the
// underlying race is structurally impossible — concurrent start/stop dispatches
// for the same agent are run in strict order, never interleaved.
//
// Mocks mirror agent-manager.test.ts so we can build AgentManager without
// spawning any real PTY/Telegram resources.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager — BUG-011 follow-up: per-agent op serialization', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-serialize-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('a stop with a slow PTY-exit await fully completes before a concurrently-dispatched start runs', async () => {
    // Reproduces the BUG-011 race window: stopAgent does
    // `await entry.process.stop()` *then* `agents.delete(name)`. Without
    // serialization, a fire-and-forget startAgent dispatched during that
    // await sees agents.has(name) === true and hits the legacy
    // pendingRestarts branch. With serialization, the start sleeps on the
    // op chain and runs against an empty registry after stop fully resolves.

    // Plant a fake registry entry whose process.stop() takes a measurable
    // tick — this is the race window we want to close. Ordering is tracked
    // via an event array (monotonic by construction) rather than Date.now()
    // timestamps, whose 1ms granularity vs setTimeout's early-fire rounding
    // made duration assertions flake in full-suite runs.
    const order: string[] = [];
    const fakeProcess = {
      stop: async () => {
        order.push('stop:enter');
        await new Promise((r) => setTimeout(r, 20));
        order.push('stop:exit');
      },
    };
    (am as any).agents.set('alice', {
      process: fakeProcess,
      checker: { stop() {} },
      poller: undefined,
      activityPoller: undefined,
    });

    // Spy on _startAgentImpl so we can record when the start actually runs.
    // Mock it to a no-op so we don't try to spawn a real PTY in the test.
    const startImplSpy = vi
      .spyOn(am as any, '_startAgentImpl')
      .mockImplementation(async () => {
        order.push('start:enter');
        return undefined;
      });

    // Dispatch both ops without awaiting either — same shape as the IPC
    // server's fire-and-forget pattern (ipc-server.ts).
    const stopP = am.stopAgent('alice');
    const startP = am.startAgent('alice', '');

    await Promise.all([stopP, startP]);

    // The start must not have entered its impl until AFTER the stop's
    // PTY-exit await resolved. Without serialization this would be
    // ['stop:enter', 'start:enter', 'stop:exit'] — startAgent would have
    // entered _startAgentImpl while the 20ms stop await was still in flight.
    expect(order).toEqual(['stop:enter', 'stop:exit', 'start:enter']);

    // And: by the time the start runs, the registry is empty (the stop
    // deleted the entry). This is what unblocks the start's own
    // already-running check.
    expect((am as any).agents.has('alice')).toBe(false);

    // No legacy pendingRestarts Set lingers — it was removed entirely.
    expect((am as any).pendingRestarts).toBeUndefined();

    startImplSpy.mockRestore();
  });

  it('multiple concurrent start/stop/restart dispatches run strictly in arrival order', async () => {
    // A noisier version of the race — issues four ops back-to-back and
    // confirms each one runs to completion before the next begins. Without
    // serialization, the interleavings would corrupt the registry state.
    const calls: string[] = [];

    (am as any).agents.set('alice', {
      process: {
        stop: async () => {
          calls.push('stop:enter');
          await new Promise((r) => setTimeout(r, 5));
          calls.push('stop:exit');
        },
      },
      checker: { stop() {} },
      poller: undefined,
      activityPoller: undefined,
    });

    vi.spyOn(am as any, '_startAgentImpl').mockImplementation(async () => {
      calls.push('start:enter');
      await new Promise((r) => setTimeout(r, 5));
      calls.push('start:exit');
      // Simulate a successful start by re-inserting the registry entry, so the
      // next stop in the chain has something to tear down.
      (am as any).agents.set('alice', {
        process: {
          stop: async () => {
            calls.push('stop:enter');
            await new Promise((r) => setTimeout(r, 5));
            calls.push('stop:exit');
          },
        },
        checker: { stop() {} },
      });
      return undefined;
    });

    // Fire-and-forget burst: stop → start → stop → start
    const p1 = am.stopAgent('alice');
    const p2 = am.startAgent('alice', '');
    const p3 = am.stopAgent('alice');
    const p4 = am.startAgent('alice', '');

    await Promise.all([p1, p2, p3, p4]);

    expect(calls).toEqual([
      'stop:enter', 'stop:exit',
      'start:enter', 'start:exit',
      'stop:enter', 'stop:exit',
      'start:enter', 'start:exit',
    ]);
  });

  it('a failing op does not poison subsequent ops on the same agent chain', async () => {
    // The serialize helper catches errors on the prior link before chaining
    // the next op — so one failed stop must not deadlock or skip later
    // start/stop calls for the same agent.
    (am as any).agents.set('alice', {
      process: { stop: async () => { throw new Error('boom'); } },
      checker: { stop() {} },
      poller: undefined,
      activityPoller: undefined,
    });

    const startImplSpy = vi
      .spyOn(am as any, '_startAgentImpl')
      .mockResolvedValue(undefined);

    const stopP = am.stopAgent('alice');
    const startP = am.startAgent('alice', '');

    await expect(stopP).rejects.toThrow('boom');
    // The start must still complete, even after the prior stop rejected.
    await expect(startP).resolves.toBeUndefined();
    expect(startImplSpy).toHaveBeenCalledTimes(1);

    startImplSpy.mockRestore();
  });

  it('ops on different agents run in parallel (chains are per-agent, not global)', async () => {
    // Sanity check: serialization is keyed by agent name, so a slow stop on
    // alice must not block a stop on bob.
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });

    let aliceStopExitedAt = 0;
    let bobStopExitedAt = 0;

    (am as any).agents.set('alice', {
      process: {
        stop: async () => {
          await new Promise((r) => setTimeout(r, 30));
          aliceStopExitedAt = Date.now();
        },
      },
      checker: { stop() {} },
      poller: undefined,
      activityPoller: undefined,
    });
    (am as any).agents.set('bob', {
      process: {
        stop: async () => {
          await new Promise((r) => setTimeout(r, 5));
          bobStopExitedAt = Date.now();
        },
      },
      checker: { stop() {} },
      poller: undefined,
      activityPoller: undefined,
    });

    const t0 = Date.now();
    await Promise.all([am.stopAgent('alice'), am.stopAgent('bob')]);

    // Bob's 5ms stop must complete well before alice's 30ms stop — proving
    // they ran in parallel, not serialized behind a global lock. Alice's
    // lower bound carries a 2ms tolerance: setTimeout can fire ~1ms early
    // relative to Date.now() granularity (same flake class as the ordering
    // test above).
    expect(bobStopExitedAt - t0).toBeLessThan(25);
    expect(aliceStopExitedAt - t0).toBeGreaterThanOrEqual(28);
  });

  describe('inspectAgentOp — classify against the chain\'s predicted end-state', () => {
    // 2026-06-03 free-mode incident: `cortextos stop X && cortextos start X`
    // classified the start DEDUPED ("already in registry") while the stop was
    // mid-teardown — yet the daemon chained and ran the start anyway. The
    // operator-facing response said the opposite of what happened. These
    // tests pin the corrected semantics: classification follows the registry
    // state the in-flight op chain will LEAVE BEHIND, not the live registry.

    function plantRunningAgent(name = 'alice', stopDelayMs = 20) {
      (am as any).agents.set(name, {
        process: {
          stop: async () => {
            await new Promise((r) => setTimeout(r, stopDelayMs));
          },
        },
        checker: { stop() {} },
        poller: undefined,
        activityPoller: undefined,
      });
    }

    it('start during an in-flight stop is OK (chained respawn), not DEDUPED', async () => {
      plantRunningAgent();
      const startImplSpy = vi
        .spyOn(am as any, '_startAgentImpl')
        .mockResolvedValue(undefined);

      const stopP = am.stopAgent('alice'); // teardown in flight, registry still populated
      const insp = am.inspectAgentOp('start', 'alice');
      expect(insp).toEqual({ ok: true });

      // And the daemon honors it: the dispatched start runs after teardown.
      const startP = am.startAgent('alice', '');
      await Promise.all([stopP, startP]);
      expect(startImplSpy).toHaveBeenCalledTimes(1);

      startImplSpy.mockRestore();
    });

    it('start while running with an idle chain stays DEDUPED', () => {
      plantRunningAgent();
      const insp = am.inspectAgentOp('start', 'alice');
      expect(insp).toMatchObject({ ok: false, code: 'DEDUPED' });
    });

    it('start during an in-flight start is DEDUPED', async () => {
      const startImplSpy = vi
        .spyOn(am as any, '_startAgentImpl')
        .mockImplementation(() => new Promise((r) => setTimeout(r, 20)));

      const startP = am.startAgent('alice', '');
      const insp = am.inspectAgentOp('start', 'alice');
      expect(insp).toMatchObject({ ok: false, code: 'DEDUPED' });

      await startP;
      startImplSpy.mockRestore();
    });

    it('second stop during an in-flight stop is DEDUPED, not NOT_FOUND', async () => {
      plantRunningAgent();
      const stopP = am.stopAgent('alice');
      const insp = am.inspectAgentOp('stop', 'alice');
      expect(insp).toMatchObject({ ok: false, code: 'DEDUPED' });
      await stopP;
    });

    it('stop during an in-flight start is OK even though the registry is still empty', async () => {
      // start was dispatched but _startAgentImpl has not populated the
      // registry yet — the chain's end-state is "running", so a stop is
      // meaningful and will chain behind the start.
      const startImplSpy = vi
        .spyOn(am as any, '_startAgentImpl')
        .mockImplementation(() => new Promise((r) => setTimeout(r, 20)));

      const startP = am.startAgent('alice', '');
      expect((am as any).agents.has('alice')).toBe(false); // registry not yet populated
      const insp = am.inspectAgentOp('stop', 'alice');
      expect(insp).toEqual({ ok: true });

      await startP;
      startImplSpy.mockRestore();
    });

    it('stop of an absent agent with an idle chain stays NOT_FOUND', () => {
      const insp = am.inspectAgentOp('stop', 'ghost');
      expect(insp).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('pending-op tracking drains with the chain — classification falls back to registry truth', async () => {
      plantRunningAgent();
      const stopP = am.stopAgent('alice');
      expect((am as any).pendingOps.get('alice')).toBe('stop');
      await stopP;
      // Chain drained: tracking cleared, registry empty → start OK, stop NOT_FOUND.
      expect((am as any).pendingOps.has('alice')).toBe(false);
      expect(am.inspectAgentOp('start', 'alice')).toEqual({ ok: true });
      expect(am.inspectAgentOp('stop', 'alice')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });
  });
});
