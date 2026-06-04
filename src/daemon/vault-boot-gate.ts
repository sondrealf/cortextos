/**
 * Bounded wait-for-vault gate at daemon start (theta-0606 resilience bundle,
 * leg 1). Analyst spec: 20260604-analyst-reboot-ordering-spec-sim-plan.md.
 *
 * PROBLEM: on host reboot the daemon races Infisical and wins — agents spawn
 * before the vault can answer, so the whole fleet boots on .env fallback
 * (vault-dark for BOT_TOKEN since Phase 3). Proven 2026-05-31 + 2026-06-02.
 * There was no wait/retry gate of any kind.
 *
 * DESIGN: one bounded gate, ONCE, in daemon startup BEFORE discoverAndStart.
 * Never per-agent — the sequential spawn loop would multiply any wait by fleet
 * size (9 agents x 90s = unacceptable). Probe = login + /api/v1/workspace via
 * the existing fetchWithTimeout (the half-up-vault readiness signal, not a
 * shallow /status). Backoff to a hard ceiling, then FAIL-OPEN into today's
 * exact degraded path (agents on .env fallback beat no agents).
 *
 * READINESS SEMANTICS (analyst refinement, the subtle part): the vault
 * returning ANY non-5xx HTTP response is liveness proof — a login 401/403 on a
 * stale borrowed credential means the vault ANSWERED, so the gate proceeds
 * (the per-agent fetches own their own auth outcomes). Only timeout /
 * connect-refused / 5xx count as not-ready and burn gate budget. Otherwise a
 * stale borrowed cred would force a false 90s wait on every boot.
 *
 * CREDS: the daemon process env carries no INFISICAL_* and neither does
 * secrets.env (verified 2026-06-04) — the triplet lives only in per-agent
 * .env. So the gate borrows one: process.env first, else a DETERMINISTIC
 * (sorted) scan of agents/<name>/.env for the first complete triplet. Any
 * identity proves vault liveness; no dedicated/standing gate credential (v1).
 *
 * INVARIANTS (mirror the cache-fallback spec):
 *  1. Detectors NOT masked — the gate shortens the degraded window, never
 *     hides one. Per-agent recordAgentVaultFetch still fires after the gate.
 *  2. Bounded ALWAYS — no config value disables the ceiling (0/absent =
 *     default, never infinite; hard backstop above the default).
 *  3. No value logging — the probe touches login creds; log identity NAME,
 *     reasons, timings only.
 *  4. Never silent-inert — a no-creds skip is LOUD (warn + durable event), so
 *     the gate can't ship dead the way an env surprise would let it.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fetchWithTimeout } from '../utils/vault-fetch-timeout.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';

const DEFAULT_MAX_WAIT_MS = 90_000;
/** Absolute backstop — config can tune the wait but never exceed this. */
const HARD_CEILING_MS = 300_000;
/** Backoff between probes; after the list is exhausted, the last value repeats. */
const BACKOFF_SCHEDULE_MS = [2_000, 5_000, 10_000, 15_000];

export interface VaultGateCreds {
  host: string;
  clientId: string;
  clientSecret: string;
  /** Where the creds came from — agent name, or '(process.env)'. Logged; never values. */
  identity: string;
}

export interface ProbeResult {
  ready: boolean;
  reason: string;
}

/**
 * Resolve the wait ceiling, clamped (invariant 2). 0 / negative / absent /
 * NaN → default; anything above the hard backstop → the backstop. A config
 * value can never disable the ceiling or make the gate wait forever.
 */
export function resolveMaxWaitMs(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_WAIT_MS;
  return Math.min(n, HARD_CEILING_MS);
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/**
 * Find a complete INFISICAL_* triplet to probe with. process.env first, then a
 * DETERMINISTIC (sorted agent name) scan of agents/<name>/.env for the first
 * complete triplet. Returns null if none exists anywhere (non-vault install).
 */
export function resolveProbeCreds(env: NodeJS.ProcessEnv, agentsDir: string): VaultGateCreds | null {
  if (env.INFISICAL_HOST && env.INFISICAL_CLIENT_ID && env.INFISICAL_CLIENT_SECRET) {
    return {
      host: env.INFISICAL_HOST,
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
      identity: '(process.env)',
    };
  }
  if (!existsSync(agentsDir)) return null;
  // Deterministic: sorted names so probe behavior is reproducible across boots.
  const agents = readdirSync(agentsDir).sort();
  for (const a of agents) {
    const envFile = join(agentsDir, a, '.env');
    if (!existsSync(envFile)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvFile(envFile);
    } catch {
      continue; // unreadable .env — skip, keep scanning
    }
    if (parsed.INFISICAL_HOST && parsed.INFISICAL_CLIENT_ID && parsed.INFISICAL_CLIENT_SECRET) {
      return {
        host: parsed.INFISICAL_HOST,
        clientId: parsed.INFISICAL_CLIENT_ID,
        clientSecret: parsed.INFISICAL_CLIENT_SECRET,
        identity: a,
      };
    }
  }
  return null;
}

/**
 * Probe vault readiness. Ready = vault returned a non-5xx HTTP response
 * (incl. 401/403 — it answered). Not-ready = timeout / connect-refused / 5xx.
 * On a healthy login (200) we go one level deeper to the workspace GET, which
 * is the readiness signal against the half-up-vault class (TCP-accepting but
 * not serving — the 2026-05-29 poison case).
 */
export async function probeVaultReady(creds: VaultGateCreds): Promise<ProbeResult> {
  const host = creds.host.replace(/\/+$/, '');
  let loginRes: Response;
  try {
    loginRes = await fetchWithTimeout(`${host}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
    });
  } catch (e) {
    return { ready: false, reason: `login unreachable (${(e instanceof Error ? e.message : String(e)).slice(0, 40)})` };
  }
  if (loginRes.status >= 500) return { ready: false, reason: `login ${loginRes.status}` };
  // Non-5xx, non-200: the vault answered (e.g. 401/403 on a stale borrowed
  // cred). That is liveness — proceed; per-agent fetches own their own auth.
  if (loginRes.status !== 200) return { ready: true, reason: `vault answered (login ${loginRes.status})` };

  let token: string | undefined;
  try {
    token = ((await loginRes.json()) as { accessToken?: string }).accessToken;
  } catch {
    return { ready: true, reason: 'login 200 (unparseable body — answered)' };
  }
  if (!token) return { ready: true, reason: 'login 200 (no token — answered)' };

  let wsRes: Response;
  try {
    wsRes = await fetchWithTimeout(`${host}/api/v1/workspace`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ready: false, reason: `workspace unreachable (${(e instanceof Error ? e.message : String(e)).slice(0, 40)})` };
  }
  if (wsRes.status >= 500) return { ready: false, reason: `workspace ${wsRes.status}` };
  return { ready: true, reason: `vault ready (workspace ${wsRes.status})` };
}

export interface VaultGateOpts {
  org: string;
  instanceId: string;
  /** orgs/<org>/agents dir to scan for borrowed creds. */
  agentsDir: string;
  env?: NodeJS.ProcessEnv;
  maxWaitMs?: number;
  // Injectables for tests:
  probe?: (creds: VaultGateCreds) => Promise<ProbeResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  emitEvent?: (outcome: string, meta: Record<string, unknown>) => void;
}

/**
 * Run the boot gate ONCE. Returns when the vault is ready, the ceiling is hit
 * (fail-open), or no creds exist (loud skip). Never throws — boot must proceed.
 */
export async function waitForVaultGate(opts: VaultGateOpts): Promise<void> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const probe = opts.probe ?? probeVaultReady;
  const maxWaitMs = opts.maxWaitMs ?? resolveMaxWaitMs(env.CTX_VAULT_BOOT_GATE_MAX_WAIT_MS);
  const emit = opts.emitEvent ?? ((outcome, meta) => {
    // Durable event in events/daemon/<date>.jsonl (NOT just stdout — Gate-5
    // forensics gotcha: sims assert on the jsonl). Best-effort; never block boot.
    try {
      const paths = resolvePaths('daemon', opts.instanceId, opts.org);
      logEvent(paths, 'daemon', opts.org, 'action', 'vault_boot_gate', outcome === 'gave-up' ? 'error' : 'info', { outcome, ...meta });
    } catch { /* event is best-effort */ }
  });

  const creds = resolveProbeCreds(env, opts.agentsDir);
  if (!creds) {
    // LOUD skip (invariant 4) — never silent-inert.
    log('[vault-gate] no INFISICAL_* triplet in daemon env or any agent .env — skipping gate (non-vault install?)');
    emit('skipped-no-creds', {});
    return;
  }

  const start = now();
  let attempt = 0;
  // NOTE (ceiling semantics): maxWaitMs bounds the SLEEP budget, not total
  // wall-clock. The elapsed check runs after each probe, and a single probe is
  // itself bounded but non-zero (login + workspace, each 5s timeout + 1 retry
  // via fetchWithTimeout ⇒ ≤~20s worst case). So real wall-clock can exceed the
  // ceiling by up to one probe duration (~110s at the 90s default). That's the
  // intended bound — assert ">= ceiling", never "== ceiling", in sims.
  for (;;) {
    const result = await probe(creds);
    if (result.ready) {
      const waitedMs = now() - start;
      if (attempt === 0) {
        // Healthy boot — one probe (~10ms), zero behavior change downstream.
        emit('ready-first-try', { identity: creds.identity, waitedMs, reason: result.reason });
      } else {
        log(`[vault-gate] vault ready after ${(waitedMs / 1000).toFixed(1)}s (${attempt + 1} probe(s)) via identity '${creds.identity}'`);
        emit('cleared', { identity: creds.identity, waitedMs, probes: attempt + 1, reason: result.reason });
      }
      return;
    }

    const elapsed = now() - start;
    const remaining = maxWaitMs - elapsed;
    if (remaining <= 0) {
      // Ceiling hit — FAIL-OPEN into the existing degraded path (invariant 1:
      // Detector A still records degraded per agent after this returns).
      log(`[vault-gate] giving up after ${(elapsed / 1000).toFixed(1)}s — proceeding with degraded boot (last: ${result.reason})`);
      emit('gave-up', { identity: creds.identity, waitedMs: elapsed, probes: attempt + 1, lastReason: result.reason });
      return;
    }

    const backoff = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)];
    const wait = Math.min(backoff, remaining);
    log(`[vault-gate] infisical not ready (probe ${attempt + 1}, ${result.reason}); waiting ${(wait / 1000).toFixed(1)}s...`);
    await sleep(wait);
    attempt++;
  }
}
