import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  CACHEABLE_OUTBOUND_KEYS,
  outboundTokenCachePath,
  outboundCacheMaxAgeMs,
  persistOutboundTokenCache,
  readOutboundTokenCache,
  invalidateOutboundTokenCache,
} from '../../../src/utils/outbound-token-cache.js';

// Unit tests for the last-known-good BOT_TOKEN cache (vault-dark boot
// resilience). Maps to the analyst spec's rollout-risk table:
//   risk 1 (overlay ordering)  — covered in agent-manager wiring, but the
//                                 read/persist primitives are proven here
//   risk 2 (secret at rest)    — 0600 mode assertion
//   risk 4 (hot-path I/O)      — same-value fetches cost exactly 1 write
// plus staleness bound, invalidation, allowlist, and corrupt-file handling.

let ctxRoot: string;
const AGENT = 'test-agent';
const TOKEN = '123456:TEST-token_abc';

function cacheFile(): string {
  return outboundTokenCachePath(ctxRoot, AGENT);
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'outbound-cache-'));
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  delete process.env.CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS;
});

describe('allowlist', () => {
  it('is BOT_TOKEN only — hard invariant', () => {
    expect([...CACHEABLE_OUTBOUND_KEYS]).toEqual(['BOT_TOKEN']);
    expect(Object.isFrozen(CACHEABLE_OUTBOUND_KEYS)).toBe(true);
  });

  it('persists nothing when the fetch result has no BOT_TOKEN', () => {
    persistOutboundTokenCache(ctxRoot, AGENT, {
      ANTHROPIC_AUTH_TOKEN: 'never-cache-me',
      GEMINI_API_KEY: 'never-cache-me-either',
    });
    expect(existsSync(cacheFile())).toBe(false);
  });

  it('never writes non-allowlisted values even when BOT_TOKEN is present', () => {
    persistOutboundTokenCache(ctxRoot, AGENT, {
      BOT_TOKEN: TOKEN,
      ANTHROPIC_AUTH_TOKEN: 'never-cache-me',
    });
    const raw = readFileSync(cacheFile(), 'utf-8');
    expect(raw).toContain(TOKEN);
    expect(raw).not.toContain('never-cache-me');
  });
});

describe('persist', () => {
  it('writes an entry with key/value/fetched_at at mode 0600', () => {
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN });
    const entry = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
    expect(entry.key).toBe('BOT_TOKEN');
    expect(entry.value).toBe(TOKEN);
    expect(Number.isFinite(Date.parse(entry.fetched_at))).toBe(true);
    // risk 2: secret-at-rest must be owner-only
    expect((statSync(cacheFile()).mode & 0o777)).toBe(0o600);
  });

  it('does not rewrite when the value is unchanged (risk 4: hot-path I/O)', () => {
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN });
    const mtime1 = statSync(cacheFile()).mtimeMs;
    const stamp1 = JSON.parse(readFileSync(cacheFile(), 'utf-8')).fetched_at;
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN });
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN });
    expect(statSync(cacheFile()).mtimeMs).toBe(mtime1);
    expect(JSON.parse(readFileSync(cacheFile(), 'utf-8')).fetched_at).toBe(stamp1);
  });

  it('overwrites on value change (fresh fetch wins)', () => {
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN });
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: '999999:ROTATED' });
    expect(JSON.parse(readFileSync(cacheFile(), 'utf-8')).value).toBe('999999:ROTATED');
  });

  it('never logs the token value', () => {
    const lines: string[] = [];
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN }, (m) => lines.push(m));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(TOKEN);
  });
});

describe('read', () => {
  it('returns the cached value with its age', () => {
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN });
    const got = readOutboundTokenCache(ctxRoot, AGENT);
    expect(got?.value).toBe(TOKEN);
    expect(got!.ageMs).toBeGreaterThanOrEqual(0);
    expect(got!.ageMs).toBeLessThan(60_000);
  });

  it('returns null when no cache exists', () => {
    expect(readOutboundTokenCache(ctxRoot, AGENT)).toBeNull();
  });

  it('refuses entries past the staleness bound (default 14d)', () => {
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ key: 'BOT_TOKEN', value: TOKEN, fetched_at: old }));
    expect(readOutboundTokenCache(ctxRoot, AGENT)).toBeNull();
  });

  it('honors CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS', () => {
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ key: 'BOT_TOKEN', value: TOKEN, fetched_at: old }));
    expect(readOutboundTokenCache(ctxRoot, AGENT, { CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS: '30' } as any)).not.toBeNull();
    expect(readOutboundTokenCache(ctxRoot, AGENT, { CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS: '1' } as any)).toBeNull();
  });

  it('refuses future-dated and unparsable timestamps', () => {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    writeFileSync(cacheFile(), JSON.stringify({ key: 'BOT_TOKEN', value: TOKEN, fetched_at: future }));
    expect(readOutboundTokenCache(ctxRoot, AGENT)).toBeNull();
    writeFileSync(cacheFile(), JSON.stringify({ key: 'BOT_TOKEN', value: TOKEN, fetched_at: 'not-a-date' }));
    expect(readOutboundTokenCache(ctxRoot, AGENT)).toBeNull();
  });

  it('treats corrupt JSON as no cache', () => {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), '{half a json');
    expect(readOutboundTokenCache(ctxRoot, AGENT)).toBeNull();
  });

  it('refuses entries whose key is not BOT_TOKEN', () => {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ key: 'ANTHROPIC_AUTH_TOKEN', value: 'x', fetched_at: new Date().toISOString() }));
    expect(readOutboundTokenCache(ctxRoot, AGENT)).toBeNull();
  });
});

describe('invalidate', () => {
  it('deletes the entry (defunct token must not retry forever)', () => {
    persistOutboundTokenCache(ctxRoot, AGENT, { BOT_TOKEN: TOKEN });
    expect(existsSync(cacheFile())).toBe(true);
    invalidateOutboundTokenCache(ctxRoot, AGENT);
    expect(existsSync(cacheFile())).toBe(false);
    expect(readOutboundTokenCache(ctxRoot, AGENT)).toBeNull();
  });

  it('is a no-op when nothing is cached', () => {
    expect(() => invalidateOutboundTokenCache(ctxRoot, AGENT)).not.toThrow();
  });
});

describe('staleness bound default', () => {
  it('is 14 days unless overridden', () => {
    expect(outboundCacheMaxAgeMs({} as any)).toBe(14 * 86_400_000);
    expect(outboundCacheMaxAgeMs({ CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS: '7' } as any)).toBe(7 * 86_400_000);
    // garbage values fall back to the default rather than disabling the bound
    expect(outboundCacheMaxAgeMs({ CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS: '-3' } as any)).toBe(14 * 86_400_000);
    expect(outboundCacheMaxAgeMs({ CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS: 'lots' } as any)).toBe(14 * 86_400_000);
  });
});
