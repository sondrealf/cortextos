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
 */

const DEFAULT_PROJECT_SLUG = 'sondre-hq-bq-wx';

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
    const loginRes = await fetch(`${host}/api/v1/auth/universal-auth/login`, {
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
    const wsRes = await fetch(`${host}/api/v1/workspace`, {
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
      const sRes = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!sRes.ok) {
        console.warn(`[infisical] read ${path} failed (${sRes.status}) for agent=${agentName}`);
        continue;
      }
      const sJson = await sRes.json() as {
        secrets?: Array<{ secretKey: string; secretValue: string }>;
      };
      for (const s of sJson.secrets ?? []) {
        merged[s.secretKey] = s.secretValue;
      }
    }

    return { values: merged, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[infisical] fetch threw for agent=${agentName}: ${msg.slice(0, 200)}`);
    return { values: {}, ok: false, reason: msg.slice(0, 80) };
  }
}
