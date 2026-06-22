import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveMaxWaitMs,
  resolveProbeCreds,
  probeVaultReady,
  waitForVaultGate,
  type VaultGateCreds,
  type ProbeResult,
} from '../../../src/daemon/vault-boot-gate.js';

// Leg-1 vault boot gate (theta-0606 resilience). Units prove the gate's LOGIC;
// the running-runtime integration (daemon started with vault stopped) is a
// separate acceptance step per the units-prove-logic-not-wiring rule.

describe('resolveMaxWaitMs — bounded always (invariant 2)', () => {
  it('absent / 0 / negative / NaN → default 90s', () => {
    expect(resolveMaxWaitMs(undefined)).toBe(90_000);
    expect(resolveMaxWaitMs('0')).toBe(90_000);
    expect(resolveMaxWaitMs('-5')).toBe(90_000);
    expect(resolveMaxWaitMs('abc')).toBe(90_000);
  });
  it('valid value honored', () => {
    expect(resolveMaxWaitMs('30000')).toBe(30_000);
  });
  it('above the hard backstop clamps to the backstop (config cannot disable ceiling)', () => {
    expect(resolveMaxWaitMs('999999999')).toBe(300_000);
  });
});

describe('resolveProbeCreds — deterministic borrowed identity', () => {
  let dir: string;
  let agentsDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-gate-creds-'));
    agentsDir = join(dir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeAgentEnv(name: string, contents: string) {
    mkdirSync(join(agentsDir, name), { recursive: true });
    writeFileSync(join(agentsDir, name, '.env'), contents);
  }

  const TRIPLET = 'INFISICAL_HOST=http://localhost:8090\nINFISICAL_CLIENT_ID=cid\nINFISICAL_CLIENT_SECRET=sec\n';

  it('process.env triplet wins and is labeled (process.env)', () => {
    writeAgentEnv('alice', TRIPLET);
    const creds = resolveProbeCreds(
      { INFISICAL_HOST: 'http://env', INFISICAL_CLIENT_ID: 'e', INFISICAL_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv,
      agentsDir,
    );
    expect(creds?.identity).toBe('(process.env)');
    expect(creds?.host).toBe('http://env');
  });

  it('scans agents in SORTED order, borrows the first complete triplet', () => {
    writeAgentEnv('zeta', TRIPLET);
    writeAgentEnv('alpha', TRIPLET);
    const creds = resolveProbeCreds({} as NodeJS.ProcessEnv, agentsDir);
    expect(creds?.identity).toBe('alpha'); // sorted, not filesystem order
  });

  it('skips agents with an incomplete triplet', () => {
    writeAgentEnv('alpha', 'INFISICAL_HOST=http://x\nINFISICAL_CLIENT_ID=only-id\n'); // missing secret
    writeAgentEnv('beta', TRIPLET);
    const creds = resolveProbeCreds({} as NodeJS.ProcessEnv, agentsDir);
    expect(creds?.identity).toBe('beta');
  });

  it('no triplet anywhere → null', () => {
    writeAgentEnv('alpha', 'BOT_TOKEN=123\n');
    expect(resolveProbeCreds({} as NodeJS.ProcessEnv, agentsDir)).toBeNull();
  });

  it('missing agents dir → null (non-vault install)', () => {
    expect(resolveProbeCreds({} as NodeJS.ProcessEnv, join(dir, 'nonexistent'))).toBeNull();
  });
});

describe('probeVaultReady — readiness semantics (analyst refinement)', () => {
  const creds: VaultGateCreds = { host: 'http://vault', clientId: 'c', clientSecret: 's', identity: 'test' };
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(handler: (url: string) => Partial<Response> | Promise<Partial<Response>>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => handler(url) as Response));
  }

  it('login 200 + workspace 200 → ready', async () => {
    stubFetch((url) =>
      url.includes('/login')
        ? { status: 200, json: async () => ({ accessToken: 'tok' }) }
        : { status: 200 },
    );
    expect((await probeVaultReady(creds)).ready).toBe(true);
  });

  it('login 401 (stale borrowed cred) → ready: vault ANSWERED', async () => {
    stubFetch(() => ({ status: 401 }));
    const r = await probeVaultReady(creds);
    expect(r.ready).toBe(true);
    expect(r.reason).toMatch(/answered/);
  });

  it('login 403 → ready (answered)', async () => {
    stubFetch(() => ({ status: 403 }));
    expect((await probeVaultReady(creds)).ready).toBe(true);
  });

  it('login 500 → NOT ready (vault erroring/half-up)', async () => {
    stubFetch(() => ({ status: 500 }));
    expect((await probeVaultReady(creds)).ready).toBe(false);
  });

  it('login throws (timeout/connect-refused) → NOT ready', async () => {
    stubFetch(() => { throw new Error('ECONNREFUSED'); });
    const r = await probeVaultReady(creds);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/unreachable/);
  });

  it('login 200 but workspace 500 (half-up vault) → NOT ready', async () => {
    stubFetch((url) =>
      url.includes('/login')
        ? { status: 200, json: async () => ({ accessToken: 'tok' }) }
        : { status: 500 },
    );
    expect((await probeVaultReady(creds)).ready).toBe(false);
  });

  it('login 200 but workspace throws (hung) → NOT ready', async () => {
    stubFetch((url) => {
      if (url.includes('/login')) return { status: 200, json: async () => ({ accessToken: 'tok' }) };
      throw new Error('aborted');
    });
    expect((await probeVaultReady(creds)).ready).toBe(false);
  });
});

describe('waitForVaultGate — orchestration', () => {
  let dir: string;
  let agentsDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-gate-orch-'));
    agentsDir = join(dir, 'agents');
    mkdirSync(join(agentsDir, 'alice'), { recursive: true });
    writeFileSync(join(agentsDir, 'alice', '.env'),
      'INFISICAL_HOST=http://v\nINFISICAL_CLIENT_ID=c\nINFISICAL_CLIENT_SECRET=s\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function harness(over: Partial<Parameters<typeof waitForVaultGate>[0]> = {}) {
    const events: Array<{ outcome: string; meta: Record<string, unknown> }> = [];
    const logs: string[] = [];
    let clock = 0;
    const base = {
      org: 'acme',
      instanceId: 'test',
      agentsDir,
      env: {} as NodeJS.ProcessEnv,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      log: (m: string) => logs.push(m),
      emitEvent: (outcome: string, meta: Record<string, unknown>) => events.push({ outcome, meta }),
    };
    return { events, logs, opts: { ...base, ...over }, advance: (ms: number) => { clock += ms; } };
  }

  it('no creds anywhere → LOUD skip event, never silent', async () => {
    const h = harness({ agentsDir: join(dir, 'none') });
    await waitForVaultGate(h.opts);
    expect(h.events).toEqual([{ outcome: 'skipped-no-creds', meta: {} }]);
    expect(h.logs.some((l) => /skipping gate/.test(l))).toBe(true);
  });

  it('ready on first probe → ready-first-try event, no sleep', async () => {
    const h = harness({ probe: async (): Promise<ProbeResult> => ({ ready: true, reason: 'ok' }) });
    await waitForVaultGate(h.opts);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].outcome).toBe('ready-first-try');
    expect(h.events[0].meta.identity).toBe('alice');
  });

  it('not-ready then ready → backs off then cleared', async () => {
    let n = 0;
    const h = harness({ probe: async (): Promise<ProbeResult> => ({ ready: n++ >= 2, reason: 'warming' }) });
    await waitForVaultGate(h.opts);
    expect(h.events.at(-1)?.outcome).toBe('cleared');
    expect(h.events.at(-1)?.meta.probes).toBe(3);
  });

  it('always not-ready → gives up at the ceiling and fails open (bounded)', async () => {
    let probes = 0;
    const h = harness({
      maxWaitMs: 90_000,
      probe: async (): Promise<ProbeResult> => { probes++; return { ready: false, reason: 'down' }; },
    });
    await waitForVaultGate(h.opts);
    expect(h.events.at(-1)?.outcome).toBe('gave-up');
    expect((h.events.at(-1)?.meta.waitedMs as number)).toBeLessThanOrEqual(90_000);
    expect(probes).toBeGreaterThan(1);
    expect(probes).toBeLessThan(50); // bounded, no runaway loop
  });

  it('gave-up never throws — boot always proceeds', async () => {
    const h = harness({ maxWaitMs: 10_000, probe: async (): Promise<ProbeResult> => ({ ready: false, reason: 'x' }) });
    await expect(waitForVaultGate(h.opts)).resolves.toBeUndefined();
  });
});
