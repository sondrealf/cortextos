import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchInfisicalSecrets } from '../../../src/utils/infisical-fetch.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

const ENV = {
  INFISICAL_HOST: 'http://localhost:8090',
  INFISICAL_CLIENT_ID: 'cid',
  INFISICAL_CLIENT_SECRET: 'sec',
  INFISICAL_PROJECT_SLUG: 'sondre-hq-bq-wx',
};

function res(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

/**
 * Mock global fetch: login + workspace always succeed; the secrets/raw read
 * (the path read) is driven by `pathResponder(callIndex)` so a test can return
 * 429-then-200, always-503, throw, etc. for the FIRST requested path (/shared).
 */
function mockFetch(pathResponder: (i: number) => Response | 'throw') {
  let pathCalls = 0;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes('/auth/universal-auth/login')) return res(200, { accessToken: 'tok' });
    if (u.includes('/api/v1/workspace')) return res(200, { workspaces: [{ id: 'proj-1', slug: 'sondre-hq-bq-wx' }] });
    // secrets/raw path read
    const r = pathResponder(pathCalls++);
    if (r === 'throw') throw new Error('ETIMEDOUT');
    return r;
  }) as unknown as typeof fetch;
}

describe('fetchInfisicalSecrets — transient retry (no silent partial → no restart-storm)', () => {
  it('retries a transient 429 then succeeds — no silent drop', async () => {
    // /shared: 429 on first attempt, 200 with the secret on retry.
    mockFetch((i) => i === 0 ? res(429, {}) : res(200, { secrets: [{ secretKey: 'BOT_TOKEN', secretValue: 'T' }] }));
    const r = await fetchInfisicalSecrets(ENV, ''); // agentName '' → only /shared
    expect(r.ok).toBe(true);
    expect(r.values.BOT_TOKEN).toBe('T'); // recovered, not dropped
  });

  it('403 out-of-scope is a legit skip, NOT a degradation', async () => {
    mockFetch(() => res(403, { message: 'forbidden' }));
    const r = await fetchInfisicalSecrets(ENV, '');
    expect(r.ok).toBe(true);          // skip, not failure
    expect(Object.keys(r.values)).toHaveLength(0);
  });

  it('exhausted 5xx → ok:false (loud), never a silent partial', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(() => res(503, {}));    // always 503 → exhausts retries
    const r = await fetchInfisicalSecrets(ENV, '');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('503');
    expect(Object.values(r.values)).toHaveLength(0); // no partial returned
    expect(errSpy).toHaveBeenCalled(); // loud
  }, 10000);

  it('a thrown timeout on a requested path → ok:false FAST (no extra path retries)', async () => {
    const start = Date.now();
    mockFetch(() => 'throw');         // path read throws (post fetchWithTimeout retries)
    const r = await fetchInfisicalSecrets(ENV, '');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/read .*threw/);
    expect(Date.now() - start).toBeLessThan(4000); // fast-fail, not 3× backoff
  });

  it('healthy read returns ok:true with the secrets (baseline)', async () => {
    mockFetch(() => res(200, { secrets: [{ secretKey: 'K', secretValue: 'V' }] }));
    const r = await fetchInfisicalSecrets(ENV, '');
    expect(r.ok).toBe(true);
    expect(r.values.K).toBe('V');
  });
});
