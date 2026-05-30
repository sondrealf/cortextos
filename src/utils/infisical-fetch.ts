/**
 * Pre-spawn Infisical secret fetcher (Phase 3).
 *
 * Reads INFISICAL_HOST / INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET
 * from the env we already built from secrets.env + agent .env, then
 * authenticates via Universal Auth and pulls secrets from
 *   /shared
 *   /agents/<agentName>     (for normal agents)
 *
 * Dual-read contract: returns a merged dict on success. On ANY failure
 * (missing creds, network blip, auth 401, secret read 403, malformed
 * response) the function returns {} and logs a warning to stderr —
 * the caller keeps using the .env values it already loaded.
 *
 * Infisical-fetched values overwrite .env values for the same key
 * (Infisical is the source of truth post-Phase-3); the caller decides
 * how to merge.
 *
 * No external dependencies — uses Node 20+ global fetch.
 *
 * All fetches go through fetchWithTimeout (5s deadline + 1 retry). This is the
 * pre-spawn overlay; a no-timeout fetch against a half-up Infisical hung every
 * agent spawn fleet-wide on 2026-05-29. A timeout aborts → throws → the catch
 * below soft-fails to .env. Fast-fail, never hang a spawn.
 */
import { fetchWithTimeout } from './vault-fetch-timeout.js';

const DEFAULT_PROJECT_SLUG = 'sondre-hq-bq-wx';

// Transient HTTP statuses worth retrying on a per-path read: rate-limit + 5xx.
// A 403 is NOT here — it's a legitimate out-of-scope deny (identity-scoped),
// handled as a skip, never a retry/degradation.
const TRANSIENT_READ_STATUSES = new Set([429, 500, 502, 503, 504]);
// Bounded per-path backoff (ms) between STATUS retries: 3 attempts total.
// Backoff-retry applies ONLY to transient STATUSES (429/5xx) — the server
// responds fast, so the HARD per-path ceiling is ~sum(backoff) ≈ 4s. A THROWN
// timeout (hung / half-up vault) is already retried once inside fetchWithTimeout
// (5s + 1) and then degrades FAST with NO extra path retries — preserving the
// fast-fail the spawn-hang fix (1af3ee8) bought. Worst case per path ≈ 10s
// (hung) — comfortably under the 60s spawn watchdog, never silent-drops.
const PATH_RETRY_BACKOFF_MS = [1000, 3000];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface FetchedSecrets {
  /** Map of secretKey → secretValue, merged across all paths read. */
  values: Record<string, string>;
  /** True if the fetch ran end-to-end successfully. */
  ok: boolean;
  /** Set on failure for diagnostics; never exposes secret values. */
  reason?: string;
}

/**
 * Fetch Infisical secrets for an agent. Soft-fails — returns ok:false
 * if anything goes wrong, never throws.
 *
 * @param env       Map of env vars already constructed by the caller.
 *                  Must contain INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET
 *                  for the fetch to attempt; otherwise returns {ok:false}.
 * @param agentName Agent folder name under /agents in the vault. Pass
 *                  empty string to fetch only /shared (e.g. for the
 *                  dashboard, which has its own custom paths).
 * @param extraPaths Additional secretPaths to read (e.g. ['/dashboard']).
 */
export async function fetchInfisicalSecrets(
  env: Record<string, string>,
  agentName: string,
  extraPaths: string[] = [],
): Promise<FetchedSecrets> {
  const host = env.INFISICAL_HOST?.replace(/\/+$/, '');
  const clientId = env.INFISICAL_CLIENT_ID;
  const clientSecret = env.INFISICAL_CLIENT_SECRET;
  const projectSlug = env.INFISICAL_PROJECT_SLUG || DEFAULT_PROJECT_SLUG;

  if (!host || !clientId || !clientSecret) {
    // Missing creds is the normal "agent hasn't migrated yet" path —
    // not an error worth logging.
    return { values: {}, ok: false, reason: 'INFISICAL_* not set' };
  }

  try {
    // 1) Universal Auth → JWT
    const loginRes = await fetchWithTimeout(`${host}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    if (!loginRes.ok) {
      const body = await loginRes.text().catch(() => '');
      console.warn(`[infisical] login failed (${loginRes.status}) for agent=${agentName}: ${body.slice(0, 200)}`);
      return { values: {}, ok: false, reason: `login ${loginRes.status}` };
    }
    const loginJson = await loginRes.json() as { accessToken?: string };
    const token = loginJson.accessToken;
    if (!token) {
      console.warn(`[infisical] login response missing accessToken for agent=${agentName}`);
      return { values: {}, ok: false, reason: 'no accessToken' };
    }

    // 2) Resolve workspaceId from the project slug. Cheap GET, cached
    //    server-side; ~10ms typical. Could be cached locally if this
    //    becomes hot, but each agent spawns once per restart so it's
    //    fine to re-resolve every time.
    const wsRes = await fetchWithTimeout(`${host}/api/v1/workspace`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!wsRes.ok) {
      console.warn(`[infisical] workspace lookup failed (${wsRes.status}) for agent=${agentName}`);
      return { values: {}, ok: false, reason: `workspace ${wsRes.status}` };
    }
    const wsJson = await wsRes.json() as { workspaces?: Array<{ id: string; slug: string }> };
    const project = wsJson.workspaces?.find(w => w.slug === projectSlug);
    if (!project) {
      console.warn(`[infisical] project '${projectSlug}' not visible to identity for agent=${agentName}`);
      return { values: {}, ok: false, reason: 'project not found' };
    }
    const projectId = project.id;

    // 3) Fetch every path. Per-identity custom roles deny non-scoped
    //    paths with 403; rather than 403 we just get an empty list
    //    (Infisical filters silently). Either way, missing paths don't
    //    abort the whole fetch.
    const paths = ['/shared'];
    if (agentName) paths.push(`/agents/${agentName}`);
    for (const p of extraPaths) paths.push(p);

    const merged: Record<string, string> = {};
    for (const path of paths) {
      const url = `${host}/api/v3/secrets/raw?workspaceId=${encodeURIComponent(projectId)}&environment=prod&secretPath=${encodeURIComponent(path)}`;
      // Per-path read. 200 → merge. 403/404 → out-of-scope/absent, legit skip.
      // 429/5xx → transient: retry with bounded backoff (never silent-drop).
      // Thrown timeout → already retried inside fetchWithTimeout; degrade fast.
      // Exhausted transient OR thrown timeout on a REQUESTED path → loud error +
      // ok:false (NO silent partial → no missing-secret boot → no restart-storm).
      let lastFailure: string | null = null;
      for (let attempt = 0; ; attempt++) {
        let sRes: Response | undefined;
        try {
          sRes = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
        } catch (e) {
          // Hung/half-up vault (timeout/network) — fetchWithTimeout already
          // retried once. Degrade FAST; do NOT add path retries (would re-hang).
          lastFailure = `read threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`;
          break;
        }
        if (sRes.ok) {
          const sJson = await sRes.json() as { secrets?: Array<{ secretKey: string; secretValue: string }> };
          for (const s of sJson.secrets ?? []) merged[s.secretKey] = s.secretValue;
          lastFailure = null;
          break;
        }
        if (sRes.status === 403 || sRes.status === 404) {
          // Out-of-scope deny / absent path — legitimate skip, NOT a degradation.
          lastFailure = null;
          break;
        }
        if (TRANSIENT_READ_STATUSES.has(sRes.status) && attempt < PATH_RETRY_BACKOFF_MS.length) {
          console.warn(`[infisical] read ${path} transient ${sRes.status} (attempt ${attempt + 1}) for agent=${agentName}; retrying`);
          await sleep(PATH_RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        // Exhausted transient retries, or a non-retryable/unexpected status.
        lastFailure = `HTTP ${sRes.status}`;
        break;
      }
      if (lastFailure) {
        // LOUD — never return a silent partial. A consumer must not boot with
        // missing secrets (→ crash → PM2 restart-storm that amplifies the limit).
        console.error(`[infisical] read ${path} FAILED (${lastFailure}) for agent=${agentName} after retries — refusing silent partial; returning degraded (ok:false)`);
        return { values: {}, ok: false, reason: `read ${path}: ${lastFailure}` };
      }
    }

    return { values: merged, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[infisical] fetch threw for agent=${agentName}: ${msg.slice(0, 200)}`);
    return { values: {}, ok: false, reason: msg.slice(0, 80) };
  }
}
