/**
 * Minimal Infisical Universal-Auth fetch helper — programmatic-only variant
 * for use inside the dashboard's Next.js instrumentation hook.
 *
 * Mirrors `/root/cortextos/dashboard/vault-fetch.mjs` (the canonical repo-root
 * copy that also exposes a CLI entry point). The CLI block is stripped here
 * because Turbopack walks every import path — including the edge runtime,
 * which has no `process.argv` and forbids `process.exit`. Keeping only the
 * pure-function exports lets Turbopack bundle this without warnings.
 *
 * Contract (mirrors the cortextos daemon's contract exactly):
 *   - Reads INFISICAL_HOST + INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET
 *     from the env you pass in (default: process.env).
 *   - Universal Auth login → workspace lookup → GET /api/v3/secrets/raw
 *     for each path you request.
 *   - On success: returns { ok: true, values: { KEY: VALUE, ... } }.
 *   - On ANY failure: returns { ok: false, reason: 'short string' } —
 *     never throws.
 */

const DEFAULT_PROJECT_SLUG = 'sondre-hq-bq-wx';

// Keys this helper must NEVER overlay onto process.env, even if they
// exist in vault. They look like secrets but are actually local-routing
// config (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL point at the local
// claude-code-router; agents that hit api.anthropic.com directly get
// 401'd if the "cortextos" router APIKEY leaks). Mirrors the daemon-side
// blocklist in cortextos/src/utils/vault-overlay-blocklist.ts.
const VAULT_OVERLAY_BLOCKLIST = process.env.VAULT_FETCH_NO_BLOCKLIST === '1'
  ? new Set()
  : new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);

// Timeout wrapper (5s + 1 retry): a no-timeout fetch against a half-up Infisical
// (TCP-accepting, not responding) hung the agent fleet on 2026-05-29. Abort ->
// throw -> the existing soft-fail catch proceeds on .env. Never hang on vault.
async function vfetch(url, init = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try { return await globalThis.fetch(url, { ...init, signal: ac.signal }); }
    catch (err) { lastErr = err; }
    finally { clearTimeout(timer); }
  }
  throw lastErr;
}

export async function fetchInfisicalSecrets({
  host,
  clientId,
  clientSecret,
  projectSlug = DEFAULT_PROJECT_SLUG,
  paths = ['/shared'],
}) {
  const normalizedHost = host?.replace(/\/+$/, '');
  if (!normalizedHost || !clientId || !clientSecret) {
    return { values: {}, ok: false, reason: 'INFISICAL_* not set' };
  }

  // INFISICAL_LOG=1 prints every step to stderr — debug helper for the
  // dashboard's instrumentation hook when vault values seem stale.
  const debug = process.env.INFISICAL_LOG === '1';
  const log = (msg) => { if (debug) process.stderr.write(`[vault-fetch:debug] ${msg}\n`); };

  try {
    log(`POST ${normalizedHost}/api/v1/auth/universal-auth/login (clientId=${clientId.slice(0, 8)}...)`);
    const loginRes = await vfetch(`${normalizedHost}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    log(`login ${loginRes.status}`);
    if (!loginRes.ok) {
      return { values: {}, ok: false, reason: `login ${loginRes.status}` };
    }
    const { accessToken: token } = await loginRes.json();
    if (!token) return { values: {}, ok: false, reason: 'no accessToken' };

    log(`GET ${normalizedHost}/api/v1/workspace`);
    const wsRes = await vfetch(`${normalizedHost}/api/v1/workspace`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    log(`workspace ${wsRes.status}`);
    if (!wsRes.ok) {
      return { values: {}, ok: false, reason: `workspace ${wsRes.status}` };
    }
    const { workspaces = [] } = await wsRes.json();
    const project = workspaces.find(w => w.slug === projectSlug);
    if (!project) {
      log(`project '${projectSlug}' not found in [${workspaces.map(w => w.slug).join(', ')}]`);
      return { values: {}, ok: false, reason: 'project not found' };
    }
    log(`project ${projectSlug} → ${project.id}`);

    const merged = {};
    for (const path of paths) {
      const url = `${normalizedHost}/api/v3/secrets/raw?workspaceId=${encodeURIComponent(project.id)}&environment=prod&secretPath=${encodeURIComponent(path)}`;
      const sRes = await vfetch(url, { headers: { Authorization: `Bearer ${token}` } });
      log(`GET secretPath=${path} → ${sRes.status}`);
      if (!sRes.ok) continue;
      const { secrets = [] } = await sRes.json();
      log(`  ${path} returned ${secrets.length} secret(s): ${secrets.map(s => s.secretKey).join(', ')}`);
      for (const s of secrets) merged[s.secretKey] = s.secretValue;
    }

    log(`merged ${Object.keys(merged).length} total: ${Object.keys(merged).join(', ')}`);
    return { values: merged, ok: true };
  } catch (err) {
    return { values: {}, ok: false, reason: (err?.message ?? String(err)).slice(0, 80) };
  }
}

export async function loadInfisical(opts = {}) {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? ['/shared'];
  const log = opts.log ?? ((msg) => console.warn(msg));

  const result = await fetchInfisicalSecrets({
    host: env.INFISICAL_HOST,
    clientId: env.INFISICAL_CLIENT_ID,
    clientSecret: env.INFISICAL_CLIENT_SECRET,
    projectSlug: env.INFISICAL_PROJECT_SLUG,
    paths,
  });

  if (!result.ok) {
    if (result.reason !== 'INFISICAL_* not set') {
      log(`[vault-fetch] skipped (${result.reason}); falling back to .env`);
    }
    return false;
  }

  let count = 0;
  for (const [k, v] of Object.entries(result.values)) {
    if (VAULT_OVERLAY_BLOCKLIST.has(k)) continue;
    process.env[k] = v;
    count++;
  }
  log(`[vault-fetch] loaded ${count} secret(s) from vault (paths: ${paths.join(', ')})`);
  return true;
}
