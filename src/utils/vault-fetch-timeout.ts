/**
 * Timeout + bounded-retry wrapper for vault (Infisical) fetches.
 *
 * WHY THIS EXISTS — 2026-05-29 fleet-hang incident: a host watchdog reboot
 * brought Infisical back up mid-migration in a HALF-UP state (TCP-accepting but
 * not responding). The pre-spawn vault overlay (`fetchInfisicalSecrets`) ran a
 * plain `fetch()` with NO timeout, so every agent spawn blocked on that fetch
 * INDEFINITELY → the whole fleet went unresponsive and only a full restart
 * cleared it. A clean ECONNREFUSED fast-fails; a half-up socket hangs forever.
 *
 * The fix: every vault fetch gets an AbortController deadline (default 5s) and
 * one retry. On exhaustion it throws — callers already treat a throw as
 * soft-fail (proceed on .env), so this converts an indefinite hang into a
 * bounded fast-fail. Never let a vault call hang a spawn again.
 */

export interface VaultFetchOpts {
  /** Per-attempt abort deadline in ms (default 5000). */
  timeoutMs?: number;
  /** Extra attempts after the first (default 1 → up to 2 total). */
  retries?: number;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  opts: VaultFetchOpts = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Drop-in `fetch`-shaped function with vault-appropriate 5s timeout + 1 retry.
 * Use as the default `fetchImpl` anywhere a vault call would otherwise use the
 * raw global fetch.
 */
export const vaultFetch = ((url: string, init?: RequestInit) =>
  fetchWithTimeout(url, init ?? {}, { timeoutMs: 5000, retries: 1 })) as typeof fetch;
