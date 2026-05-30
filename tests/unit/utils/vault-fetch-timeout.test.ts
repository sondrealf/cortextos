import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchWithTimeout } from '../../../src/utils/vault-fetch-timeout.js';
import { fetchInfisicalSecrets } from '../../../src/utils/infisical-fetch.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function okResponse(body: any = {}): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
}

describe('fetchWithTimeout', () => {
  it('returns the response on success without retrying', async () => {
    const spy = vi.fn(async () => okResponse({ ok: 1 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const res = await fetchWithTimeout('http://x/');
    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries once then succeeds', async () => {
    let n = 0;
    globalThis.fetch = (async () => { n++; if (n === 1) throw new Error('boom'); return okResponse(); }) as unknown as typeof fetch;
    const res = await fetchWithTimeout('http://x/', {}, { timeoutMs: 50, retries: 1 });
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it('aborts on timeout and throws FAST (does not hang) — the fleet-fix', async () => {
    // Simulate a half-up vault: accepts the request but never responds, only
    // settling when the AbortController fires. Without the timeout this hangs
    // forever (the 2026-05-29 fleet-hang). With it, we reject within ~timeoutMs.
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const start = Date.now();
    await expect(fetchWithTimeout('http://x/', {}, { timeoutMs: 30, retries: 1 })).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // two ~30ms attempts, nowhere near a hang
  });
});

describe('fetchInfisicalSecrets soft-fails fast on an unresponsive vault', () => {
  it('returns ok:false quickly instead of hanging the spawn', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const start = Date.now();
    const result = await fetchInfisicalSecrets(
      { INFISICAL_HOST: 'http://localhost:8090', INFISICAL_CLIENT_ID: 'cid', INFISICAL_CLIENT_SECRET: 'sec' },
      'dev',
    );
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);          // soft-fail, caller proceeds on .env
    expect(elapsed).toBeLessThan(13000);     // bounded by 5s timeout + 1 retry (~10s), not infinite
  }, 15000); // test deadline > the bounded ~10s vault timeout it's asserting
});
