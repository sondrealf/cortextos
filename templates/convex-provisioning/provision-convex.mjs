/**
 * Convex managed-cloud auto-provisioning for the cortextOS /new-project flow.
 *
 * Goal: a Convex-backed scaffold materializes its own cloud deployment with
 * ZERO manual signup/login per project. The project-bootstrap agent runs this
 * once during scaffolding; the child repo never carries the account token.
 *
 * ── Credential model (verified against convex CLI v1.39.1 source + docs) ──
 *
 *   There are TWO distinct Convex credential classes:
 *
 *   1. ACCOUNT ACCESS TOKEN  — the only credential that can CREATE a new
 *      project + deployment. Sondre minted it once via `npx convex login`
 *      (stored at ~/.convex/config.json {accessToken}). We keep the durable
 *      copy in Infisical at /agents/project-bootstrap/CONVEX_ACCESS_TOKEN so
 *      ONLY the provisioner can read it (it can create/delete projects across
 *      the whole Convex account — least-privilege demands tight scoping).
 *
 *   2. DEPLOY KEY (CONVEX_DEPLOY_KEY) — scoped to an EXISTING project or
 *      deployment. CANNOT create a project. This is what a scaffolded child
 *      repo gets for ongoing `convex deploy` in its own CI, so the broad
 *      account token never lives in the child.
 *
 *   How the account token is consumed (verified in source):
 *     if (process.env.CONVEX_OVERRIDE_ACCESS_TOKEN) -> use it as the account
 *     token; else fall back to ~/.convex/config.json {accessToken}.
 *   We use the env-var path: vault-fetch the token, export it AS
 *   CONVEX_OVERRIDE_ACCESS_TOKEN for the convex subprocess only. Nothing is
 *   written to disk, precedence is deterministic, and it dodges the
 *   `--env-file` re-auth-loop bug (get-convex/convex-backend#370).
 *
 * ── Flow ──
 *   1. vault-fetch CONVEX_ACCESS_TOKEN (path /agents/project-bootstrap, with
 *      /shared as a merge fallback). Hard-fail if absent — unlike a normal
 *      vault overlay this token IS the point of the operation.
 *   2. `npx convex dev --once --configure new --team <slug> --project <slug>
 *      --dev-deployment cloud --typecheck=disable`  with
 *      CONVEX_OVERRIDE_ACCESS_TOKEN set in the subprocess env. This creates the
 *      managed-cloud project + dev deployment and writes CONVEX_DEPLOYMENT +
 *      CONVEX_URL / NEXT_PUBLIC_CONVEX_URL into <projectDir>/.env.local.
 *   3. (Hardening) mint a project-scoped deploy key and hand THAT to the child
 *      repo for ongoing CI deploys. Non-fatal: provisioning succeeds without
 *      it; the child can fall back to interactive `convex deploy` until a key
 *      is minted.
 *
 * Usage (CLI):
 *   node provision-convex.mjs \
 *     --project-dir /path/to/new-project \
 *     --project <convex-project-slug> \
 *     --team <convex-team-slug> \
 *     [--vault-path /agents/project-bootstrap] \
 *     [--no-deploy-key]
 *
 * Requires INFISICAL_HOST + INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET in
 * env (the project-bootstrap identity, read-scoped to its own path + /shared).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fetchInfisicalSecrets } from './vault-fetch.mjs';

const TOKEN_KEY = 'CONVEX_ACCESS_TOKEN';
const DEFAULT_VAULT_PATH = '/agents/project-bootstrap';
const CONVEX_MGMT_API = process.env.CONVEX_MGMT_API ?? 'https://api.convex.dev';

function parseArgs(argv) {
  const opts = { deployKey: true, vaultPath: DEFAULT_VAULT_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-dir') opts.projectDir = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--team') opts.team = argv[++i];
    else if (a === '--vault-path') opts.vaultPath = argv[++i];
    else if (a === '--no-deploy-key') opts.deployKey = false;
  }
  return opts;
}

/**
 * Fetch the Convex account token from vault. The token lives at
 * /agents/project-bootstrap so only the provisioner can read it; /shared is
 * merged first so a future relocation to /shared also works without a code
 * change (last path wins, per the vault path-merge rule).
 */
export async function fetchConvexAccountToken(env = process.env, vaultPath = DEFAULT_VAULT_PATH) {
  const result = await fetchInfisicalSecrets({
    host: env.INFISICAL_HOST,
    clientId: env.INFISICAL_CLIENT_ID,
    clientSecret: env.INFISICAL_CLIENT_SECRET,
    projectSlug: env.INFISICAL_PROJECT_SLUG,
    paths: ['/shared', vaultPath],
  });
  if (!result.ok) {
    throw new Error(`vault fetch failed: ${result.reason}`);
  }
  const token = result.values[TOKEN_KEY];
  if (!token) {
    throw new Error(
      `${TOKEN_KEY} not found at ${vaultPath} (or /shared). ` +
      `Sondre must add it to Infisical before Convex projects can self-provision.`,
    );
  }
  return token;
}

/**
 * Auto-resolve the Convex team slug from the account token via the management
 * API (so it isn't a manual input). Returns the slug, or null if it can't be
 * resolved unambiguously (zero or multiple teams) — caller then escalates.
 */
export async function resolveTeamSlug(token, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${CONVEX_MGMT_API}/api/dashboard/teams`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const teams = await res.json();
    const list = Array.isArray(teams) ? teams : (teams.teams ?? []);
    if (list.length === 1) return list[0].slug ?? list[0].name ?? null;
    return null; // 0 or >1 teams → ambiguous, escalate rather than guess
  } catch {
    return null;
  }
}

/**
 * Create the managed-cloud project + dev deployment. Returns the deployment
 * coordinates parsed from the .env.local the CLI writes.
 */
export function createCloudDeployment({ token, projectDir, project, team }) {
  if (!projectDir || !project || !team) {
    throw new Error('createCloudDeployment requires { projectDir, project, team }');
  }
  const args = [
    'convex', 'dev', '--once',
    '--configure', 'new',
    '--team', team,
    '--project', project,
    '--dev-deployment', 'cloud',
    '--typecheck=disable',
  ];
  const res = spawnSync('npx', args, {
    cwd: projectDir,
    stdio: 'inherit',
    // Token is injected ONLY into this subprocess env, never the parent and
    // never written to disk. CONVEX_OVERRIDE_ACCESS_TOKEN is the highest-
    // priority account-token source in the convex CLI.
    env: { ...process.env, CONVEX_OVERRIDE_ACCESS_TOKEN: token },
  });
  if (res.status !== 0) {
    throw new Error(`\`npx convex dev --once --configure new\` exited with ${res.status}`);
  }
  return readDeploymentEnv(projectDir);
}

/** Parse CONVEX_DEPLOYMENT + URL out of the .env.local the CLI writes. */
export function readDeploymentEnv(projectDir) {
  const envPath = join(projectDir, '.env.local');
  if (!existsSync(envPath)) {
    return { deployment: null, url: null, envPath };
  }
  const text = readFileSync(envPath, 'utf8');
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
  };
  return {
    deployment: get('CONVEX_DEPLOYMENT'),
    url: get('NEXT_PUBLIC_CONVEX_URL') ?? get('CONVEX_URL') ?? get('VITE_CONVEX_URL'),
    envPath,
  };
}

/**
 * Mint a project-scoped deploy key so the child repo can run `convex deploy`
 * in CI without the broad account token. Non-fatal: returns null on any
 * failure so provisioning still succeeds.
 *
 * NOTE: the Convex management deploy-key endpoint shape is documented at
 * https://docs.convex.dev/management-api/create-deploy-key but has NOT been
 * smoke-tested live here (no token available at author time). The first real
 * provisioning run is the verification point — if the endpoint/payload differ,
 * adjust here; nothing else depends on this step.
 */
export async function mintProjectDeployKey({ token, project, team }) {
  try {
    const res = await fetch(`${CONVEX_MGMT_API}/api/deploy_key/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectSlug: project, teamSlug: team, name: 'cortextos-ci' }),
    });
    if (!res.ok) {
      console.warn(`[convex] deploy-key mint skipped (HTTP ${res.status}); child can use interactive deploy until a key is provisioned`);
      return null;
    }
    const data = await res.json();
    return data.deployKey ?? data.adminKey ?? null;
  } catch (err) {
    console.warn(`[convex] deploy-key mint skipped (${(err?.message ?? err)}); non-fatal`);
    return null;
  }
}

export async function provisionConvex(opts) {
  const { projectDir, project, vaultPath, deployKey } = opts;
  let team = opts.team;

  const token = await fetchConvexAccountToken(process.env, vaultPath);
  console.log(`[convex] account token resolved from vault (${vaultPath} / /shared)`);

  // Team slug is auto-resolved from the account token unless explicitly passed.
  if (!team) {
    team = await resolveTeamSlug(token);
    if (!team) {
      throw new Error(
        'could not auto-resolve a single Convex team from the account token ' +
        '(zero or multiple teams). Pass --team <slug> explicitly, or escalate to commander.',
      );
    }
    console.log(`[convex] team slug auto-resolved: ${team}`);
  }
  console.log(`[convex] provisioning managed-cloud deployment for project '${project}' (team '${team}')`);

  const deployment = createCloudDeployment({ token, projectDir, project, team });
  console.log(`[convex] deployment created: ${deployment.deployment ?? '(unknown)'} url=${deployment.url ?? '(unknown)'}`);

  let projectDeployKey = null;
  if (deployKey) {
    projectDeployKey = await mintProjectDeployKey({ token, project, team });
    if (projectDeployKey) console.log('[convex] project-scoped deploy key minted for child CI');
  }

  return { ...deployment, deployKey: projectDeployKey };
}

// --- CLI entry point (basename compare; see vault-fetch.mjs for rationale) ---
const argvFile = process.argv[1] ? process.argv[1].split('/').pop() : '';
const isMain = !!argvFile && import.meta.url.endsWith('/' + argvFile);

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.projectDir || !opts.project || !opts.team) {
    console.error('usage: node provision-convex.mjs --project-dir <dir> --project <slug> --team <slug> [--vault-path <path>] [--no-deploy-key]');
    process.exit(2);
  }
  try {
    const result = await provisionConvex(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[convex] provisioning failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
