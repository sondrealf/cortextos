import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../src/daemon/fast-checker';
import type { BusPaths } from '../../src/types';

/**
 * Detector-B spawn-path wiring proof.
 *
 * The compiling-but-wrong risk on the replanted (upstream-based) daemon: the
 * FastChecker constructor ACCEPTS onSpawnInitiated/onBootstrapComplete and
 * AgentManager WIRES them to noteAgentSpawnInitiated/noteAgentBootstrapComplete
 * (agent-manager.ts FastChecker creation), but nothing proved that
 * FastChecker.start() actually INVOKES them — the `?.()` optional calls would
 * silently no-op if the wiring regressed, leaving Detector B inert.
 *
 * This asserts the seam directly against the REAL FastChecker.start() on the
 * upstream code path: onSpawnInitiated fires at spawn ("Starting. Waiting for
 * bootstrap..."), onBootstrapComplete fires once bootstrap is reached. Combined
 * with vault-boot-tick-invocation.test.ts (which proves the observer feed →
 * live tick → alert), this closes the full Detector-B chain end to end.
 */
function createMockAgent(name = 'wired-agent', bootstrapped = true) {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(bootstrapped),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

describe('Detector-B spawn-path wiring (FastChecker → observer feed seam)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    vi.useFakeTimers();
    testDir = mkdtempSync(join(tmpdir(), 'detb-wiring-'));
    paths = createTestPaths(testDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('WIRING: start() invokes onSpawnInitiated at spawn AND onBootstrapComplete after bootstrap', async () => {
    const agent = createMockAgent('wired-agent', true);
    const onSpawnInitiated = vi.fn();
    const onBootstrapComplete = vi.fn();
    const checker = new FastChecker(agent, paths, '/tmp/framework', {
      onSpawnInitiated,
      onBootstrapComplete,
    });

    // start() fires onSpawnInitiated synchronously (before the first await).
    checker.start();
    expect(onSpawnInitiated).toHaveBeenCalledTimes(1);
    // Not yet complete — bootstrap-complete only after waitForBootstrap resolves.
    expect(onBootstrapComplete).not.toHaveBeenCalled();

    // Flush the awaited waitForBootstrap() (isBootstrapped()=true → resolves
    // immediately) so onBootstrapComplete fires.
    await vi.advanceTimersByTimeAsync(1);
    expect(onBootstrapComplete).toHaveBeenCalledTimes(1);

    checker.stop();
    checker.wake();
  });

  it('WIRING: onBootstrapComplete does NOT fire while the agent has not bootstrapped (hung spawn)', async () => {
    const agent = createMockAgent('hung-agent', false); // never bootstraps
    const onSpawnInitiated = vi.fn();
    const onBootstrapComplete = vi.fn();
    const checker = new FastChecker(agent, paths, '/tmp/framework', {
      onSpawnInitiated,
      onBootstrapComplete,
    });

    checker.start();
    // Spawn-initiated still fires (this is what arms Detector B's watchdog)...
    expect(onSpawnInitiated).toHaveBeenCalledTimes(1);
    // ...but bootstrap-complete must NOT fire while waitForBootstrap polls.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onBootstrapComplete).not.toHaveBeenCalled();

    checker.stop();
    checker.wake();
  });
});
