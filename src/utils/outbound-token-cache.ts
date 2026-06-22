import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from './atomic.js';

/**
 * Last-known-good outbound token cache (vault-dark boot resilience).
 *
 * Problem: vault-only agents (no .env BOT_TOKEN) that (re)start while
 * Infisical is down boot DARK — zero outbound Telegram — instead of
 * functional-degraded. Proven by the Gate-5 sim (2026-06-03, 8/8 agents
 * lost outbound), the 2026-05-31 host-reboot race, and the session-env
 * freeze. Worst consequence: the vault degraded-boot detector's own
 * Telegram alert leg is skipped when commander's creds are vault-frozen —
 * during exactly the outage class the detector exists to catch.
 *
 * Design (analyst spec 2026-06-03, task_1780419404190):
 *  - on every SUCCESSFUL vault fetch the daemon persists the agent's
 *    BOT_TOKEN to a per-agent cache file (atomic, 0600, rewritten only on
 *    value change)
 *  - when a boot-time vault fetch fails AND .env supplied no BOT_TOKEN,
 *    the daemon overlays the cached token for the outbound path only,
 *    with one loud log line
 *  - entries older than the staleness bound are refused
 *  - a Telegram 401 on a cached token deletes the entry (defunct tokens
 *    must not retry forever)
 *
 * Hard invariants (do not weaken):
 *  1. Detectors are NOT masked — recordAgentVaultFetch(name, false) still
 *     fires on a degraded boot; the cache restores outbound CAPABILITY,
 *     never the appearance of health.
 *  2. BOT_TOKEN only — CACHEABLE_OUTBOUND_KEYS is a hard allowlist.
 *     Never extend it toward the vault-fetch blocklist family (precedent:
 *     ANTHROPIC_AUTH_TOKEN poisoning P1, 0/8 dispatches).
 *  3. No secret VALUES in any log line on this path (precedent: 2026-06-03
 *     P2, vault-fetch arg misuse echoed org secrets into local logs).
 */

/** Hard allowlist. BOT_TOKEN, full stop — see invariant 2 above. */
export const CACHEABLE_OUTBOUND_KEYS: readonly string[] = Object.freeze(['BOT_TOKEN']);

/** Telegram tokens rotate rarely; the bound limits a stale-token tail. */
const DEFAULT_MAX_AGE_DAYS = 14;

interface OutboundTokenCacheEntry {
  key: string;
  value: string;
  fetched_at: string;
}

export interface CachedOutboundToken {
  value: string;
  ageMs: number;
}

export function outboundTokenCachePath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, 'state', agentName, '.outbound-token-cache.json');
}

/** Staleness bound in ms — tunable via CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS. */
export function outboundCacheMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.CTX_OUTBOUND_TOKEN_CACHE_MAX_AGE_DAYS);
  const effective = Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_AGE_DAYS;
  return effective * 24 * 60 * 60 * 1000;
}

function readEntry(path: string): OutboundTokenCacheEntry | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OutboundTokenCacheEntry;
    if (!parsed || typeof parsed.value !== 'string' || typeof parsed.fetched_at !== 'string') return null;
    return parsed;
  } catch {
    // Corrupt cache file is equivalent to no cache. Callers on the persist
    // path will atomically rewrite it on the next successful fetch.
    return null;
  }
}

/**
 * Persist the agent's BOT_TOKEN after a SUCCESSFUL vault fetch.
 * Atomic write (0600 via atomicWriteSync), and only when the value actually
 * changed — N fetches of the same value cost exactly 1 write.
 */
export function persistOutboundTokenCache(
  ctxRoot: string,
  agentName: string,
  fetchedValues: Record<string, string>,
  log?: (msg: string) => void,
): void {
  // Allowlist enforcement: read ONLY the cacheable keys out of the fetch
  // result. Nothing else ever reaches this file.
  const value = fetchedValues.BOT_TOKEN?.trim();
  if (!value) return;

  const path = outboundTokenCachePath(ctxRoot, agentName);
  const existing = readEntry(path);
  if (existing?.value === value) return;

  const entry: OutboundTokenCacheEntry = {
    key: 'BOT_TOKEN',
    value,
    fetched_at: new Date().toISOString(),
  };
  atomicWriteSync(path, JSON.stringify(entry));
  // Invariant 3: name the event, never the value.
  log?.(`[outbound-cache] BOT_TOKEN last-known-good ${existing ? 'updated' : 'written'} for ${agentName}`);
}

/**
 * Read the cached BOT_TOKEN for a degraded boot. Returns null when there is
 * no cache, the entry is malformed, or it exceeds the staleness bound.
 */
export function readOutboundTokenCache(
  ctxRoot: string,
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
  log?: (msg: string) => void,
): CachedOutboundToken | null {
  const path = outboundTokenCachePath(ctxRoot, agentName);
  const entry = readEntry(path);
  if (!entry || entry.key !== 'BOT_TOKEN' || !entry.value.trim()) return null;

  const fetchedAt = Date.parse(entry.fetched_at);
  if (!Number.isFinite(fetchedAt)) return null;
  const ageMs = Date.now() - fetchedAt;
  if (ageMs < 0) return null; // clock skew / tampered timestamp — refuse

  const maxAge = outboundCacheMaxAgeMs(env);
  if (ageMs > maxAge) {
    log?.(`[outbound-cache] cached BOT_TOKEN for ${agentName} refused: ${Math.round(ageMs / 86400000)}d old exceeds ${Math.round(maxAge / 86400000)}d bound`);
    return null;
  }

  return { value: entry.value.trim(), ageMs };
}

/** Delete the cache entry (Telegram 401 on a cached token = defunct). */
export function invalidateOutboundTokenCache(ctxRoot: string, agentName: string): void {
  try {
    unlinkSync(outboundTokenCachePath(ctxRoot, agentName));
  } catch {
    // Already gone (or unreadable dir) — nothing to invalidate.
  }
}
