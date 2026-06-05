/**
 * tests/integration/outbound-cache-fallback.test.ts
 *
 * Integration test for the last-known-good BOT_TOKEN cache (vault-dark boot
 * resilience, analyst spec 2026-06-03). Drives AgentManager.resolvePollerVaultOverlay
 * — the EXACT method _startAgentImpl calls for the poller env — with the vault
 * fetch mocked at the module boundary, a real temp ctxRoot on disk, and the
 * real detector tick. Covers the spec's rollout-risk table where the unit
 * tests can't:
 *
 *   risk 1 (overlay ordering): a HEALTHY fetch always beats the cache — the
 *           cache is read only on the ok:false path, and a healthy boot logs
 *           NO engage line.
 *   risk 3 (cache masks outage): Detector A STILL fires persistent-tokenless
 *           while the agent runs on cached outbound — the cache restores
 *           capability, never the appearance of health.
 *   risk 5 (half-up vault): the overlay decision keys off the fetch result
 *           for THIS agent only.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/utils/infisical-fetch.js', () => ({
  fetchInfisicalSecrets: vi.fn(),
}));

import { AgentManager } from '../../src/daemon/agent-manager';
import { DEGRADED_ALERT_MS, type VaultBootAlert } from '../../src/daemon/vault-boot-observer';
import { fetchInfisicalSecrets } from '../../src/utils/infisical-fetch.js';
import { outboundTokenCachePath } from '../../src/utils/outbound-token-cache.js';

const mockedFetch = vi.mocked(fetchInfisicalSecrets);

const TICK_MS = 20;
const WAIT_MS = TICK_MS * 6;
const AGENT = 'free-mode';
const CACHED_TOKEN = '111111:CACHED-token';
const FRESH_TOKEN = '222222:FRESH-token';

const managers: AgentManager[] = [];
let tmpRoot: string;

function makeManager(alerts: VaultBootAlert[], clock: () => number): AgentManager {
  const mgr = new AgentManager('test-instance', tmpRoot, tmpRoot, 'test-org', {
    vaultTickIntervalMs: TICK_MS,
    vaultClock: clock,
    onVaultAlert: (a) => alerts.push(a),
  });
  managers.push(mgr);
  return mgr;
}

function seedCache(value = CACHED_TOKEN, fetchedAt = new Date().toISOString()): void {
  const p = outboundTokenCachePath(tmpRoot, AGENT);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ key: 'BOT_TOKEN', value, fetched_at: fetchedAt }));
}

function readCache(): any {
  return JSON.parse(fs.readFileSync(outboundTokenCachePath(tmpRoot, AGENT), 'utf-8'));
}

const settle = () => new Promise((r) => setTimeout(r, WAIT_MS));

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-int-'));
  mockedFetch.mockReset();
});

afterEach(() => {
  for (const m of managers.splice(0)) m.clearVaultBootTickForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('outbound cache-fallback (production overlay path)', () => {
  it('ENGAGE: vault-dark boot + no .env BOT_TOKEN → cached token overlaid, loud log line', async () => {
    seedCache();
    mockedFetch.mockResolvedValue({ ok: false, reason: 'fetch timeout', values: {} } as any);

    const mgr = makeManager([], () => 0);
    const envMap: Record<string, string> = { INFISICAL_CLIENT_ID: 'x', INFISICAL_CLIENT_SECRET: 'y' };
    const lines: string[] = [];
    await mgr.resolvePollerVaultOverlay(AGENT, envMap, (m) => lines.push(m));

    expect(envMap.BOT_TOKEN).toBe(CACHED_TOKEN);
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(true);
    expect(lines.some((l) => l.includes(`outbound cache-fallback engaged for ${AGENT}`))).toBe(true);
    // invariant 3: no token value in any log line
    for (const l of lines) expect(l).not.toContain(CACHED_TOKEN);
  });

  it('INVARIANT (risk 3): Detector A still alerts persistent-tokenless WHILE outbound runs on cache', async () => {
    seedCache();
    mockedFetch.mockResolvedValue({ ok: false, reason: 'fetch timeout', values: {} } as any);

    const alerts: VaultBootAlert[] = [];
    let now = 0;
    const mgr = makeManager(alerts, () => now);
    const envMap: Record<string, string> = { INFISICAL_CLIENT_ID: 'x', INFISICAL_CLIENT_SECRET: 'y' };
    await mgr.resolvePollerVaultOverlay(AGENT, envMap, () => {});

    expect(envMap.BOT_TOKEN).toBe(CACHED_TOKEN); // outbound restored…
    now += DEGRADED_ALERT_MS + 1_000;
    await settle();
    const fired = alerts.filter((a) => a.detector === 'persistent-tokenless' && a.agent === AGENT);
    expect(fired).toHaveLength(1);              // …and the degraded boot still alerts
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(true);
  });

  it('ORDERING (risk 1): healthy fetch beats stale cache — vault value wins, cache rewritten, NO engage line', async () => {
    seedCache(CACHED_TOKEN);
    mockedFetch.mockResolvedValue({ ok: true, values: { BOT_TOKEN: FRESH_TOKEN } } as any);

    const mgr = makeManager([], () => 0);
    const envMap: Record<string, string> = { INFISICAL_CLIENT_ID: 'x', INFISICAL_CLIENT_SECRET: 'y' };
    const lines: string[] = [];
    await mgr.resolvePollerVaultOverlay(AGENT, envMap, (m) => lines.push(m));

    expect(envMap.BOT_TOKEN).toBe(FRESH_TOKEN);
    expect(readCache().value).toBe(FRESH_TOKEN);
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(false);
    expect(lines.some((l) => l.includes('cache-fallback engaged'))).toBe(false);
  });

  it('ENV PRECEDENCE: failed fetch with a .env BOT_TOKEN present → .env soft-fall stands, cache untouched', async () => {
    seedCache();
    mockedFetch.mockResolvedValue({ ok: false, reason: 'fetch timeout', values: {} } as any);

    const mgr = makeManager([], () => 0);
    const envMap: Record<string, string> = {
      INFISICAL_CLIENT_ID: 'x', INFISICAL_CLIENT_SECRET: 'y',
      BOT_TOKEN: '333333:FROM-DOTENV',
    };
    await mgr.resolvePollerVaultOverlay(AGENT, envMap, () => {});

    expect(envMap.BOT_TOKEN).toBe('333333:FROM-DOTENV');
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(false);
  });

  it('NO CACHE: vault-dark boot with nothing cached → boots dark (no token invented)', async () => {
    mockedFetch.mockResolvedValue({ ok: false, reason: 'fetch timeout', values: {} } as any);

    const mgr = makeManager([], () => 0);
    const envMap: Record<string, string> = { INFISICAL_CLIENT_ID: 'x', INFISICAL_CLIENT_SECRET: 'y' };
    const lines: string[] = [];
    await mgr.resolvePollerVaultOverlay(AGENT, envMap, (m) => lines.push(m));

    expect(envMap.BOT_TOKEN).toBeUndefined();
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(false);
    expect(lines.some((l) => l.includes('cache-fallback engaged'))).toBe(false);
  });

  it('STALENESS: an over-bound cache entry is refused on the engage path', async () => {
    seedCache(CACHED_TOKEN, new Date(Date.now() - 15 * 86_400_000).toISOString());
    mockedFetch.mockResolvedValue({ ok: false, reason: 'fetch timeout', values: {} } as any);

    const mgr = makeManager([], () => 0);
    const envMap: Record<string, string> = { INFISICAL_CLIENT_ID: 'x', INFISICAL_CLIENT_SECRET: 'y' };
    await mgr.resolvePollerVaultOverlay(AGENT, envMap, () => {});

    expect(envMap.BOT_TOKEN).toBeUndefined();
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(false);
  });

  it('HEAL: a later healthy fetch clears the engaged flag', async () => {
    seedCache();
    mockedFetch.mockResolvedValueOnce({ ok: false, reason: 'fetch timeout', values: {} } as any);
    mockedFetch.mockResolvedValueOnce({ ok: true, values: { BOT_TOKEN: FRESH_TOKEN } } as any);

    const mgr = makeManager([], () => 0);
    const envMap: Record<string, string> = { INFISICAL_CLIENT_ID: 'x', INFISICAL_CLIENT_SECRET: 'y' };
    await mgr.resolvePollerVaultOverlay(AGENT, envMap, () => {});
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(true);

    await mgr.resolvePollerVaultOverlay(AGENT, envMap, () => {});
    expect(mgr.isOutboundCacheEngagedForTest(AGENT)).toBe(false);
    expect(envMap.BOT_TOKEN).toBe(FRESH_TOKEN);
  });
});
