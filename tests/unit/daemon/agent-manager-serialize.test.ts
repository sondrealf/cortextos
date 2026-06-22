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
    // tick — this is the race window we want to close.
    let stopResolvedAt = 0;
    let stopStartedAt = 0;
    let startEnteredImplAt = 0;
    const fakeProcess = {
      stop: async () => {
        stopStartedAt = Date.now();
        await new Promise((r) => setTimeout(r, 20));
        stopResolvedAt = Date.now();
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
        startEnteredImplAt = Date.now();
        return undefined;
      });

    // Dispatch both ops without awaiting either — same shape as the IPC
    // server's fire-and-forget pattern (ipc-server.ts).
    const stopP = am.stopAgent('alice');
    const startP = am.startAgent('alice', '');

    await Promise.all([stopP, startP]);

    // The start must not have entered its impl until AFTER the stop's
    // PTY-exit await resolved. Without serialization this assertion would
    // fail because startAgent would have entered _startAgentImpl while the
    // 20ms stop await was still in flight.
    expect(stopStartedAt).toBeGreaterThan(0);
    expect(stopResolvedAt).toBeGreaterThanOrEqual(stopStartedAt + 20);
    expect(startEnteredImplAt).toBeGreaterThanOrEqual(stopResolvedAt);

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
    // they ran in parallel, not serialized behind a global lock.
    expect(bobStopExitedAt - t0).toBeLessThan(25);
    expect(aliceStopExitedAt - t0).toBeGreaterThanOrEqual(30);
  });
});
