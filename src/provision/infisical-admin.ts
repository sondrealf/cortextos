/**
 * Infisical admin/write operations for the /new-project provisioning flow.
 *
 * `src/utils/infisical-fetch.ts` only does login + read. This module adds the
 * WRITE side the bootstrap flow needs: minting scoped machine identities,
 * creating custom roles (CASL), and upserting secrets. It is used by:
 *   - `cortextos vault create-provisioner` (one-time setup, admin token)
 *   - `cortextos new-project` provisioning step (per-project, provisioner token)
 *
 * Design notes:
 *   - All network calls go through an injectable `fetchImpl` (defaults to global
 *     fetch) so the logic is unit-testable without a live Infisical instance.
 *   - LIVE validation is project-bootstrap's job per the production-readiness
 *     plan; these functions are built to the documented Infisical v1/v2 API
 *     shapes. Endpoints flagged `VERIFY@first-run` are the ones whose exact
 *     payload couldn't be exercised without an admin token at author time.
 *   - clientId gotcha (Phase-3 learning): the `clientId` does NOT come back from
 *     the `client-secrets` mint POST — it must be read from
 *     `GET /auth/universal-auth/identities/<id>.identityUniversalAuth.clientId`.
 */

import { vaultFetch } from '../utils/vault-fetch-timeout.js';

export type FetchImpl = typeof fetch;

const DEFAULT_PROJECT_SLUG = 'sondre-hq-bq-wx';
const ENV_SLUG = 'prod';

export interface AdminCreds {
  host: string;
  clientId: string;
  clientSecret: string;
  projectSlug?: string;
}

export interface AdminSession {
  token: string;
  host: string;
  projectId: string;
  orgId: string;
}

export interface MintedIdentity {
  identityId: string;
  clientId: string;
  clientSecret: string;
}

/** A single CASL permission entry as Infisical's permission API expects. */
export interface CaslPermission {
  subject: string;
  action: string[];
  conditions?: Record<string, unknown>;
}

function trimHost(host: string): string {
  return host.replace(/\/+$/, '');
}

async function asJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/**
 * Universal Auth login → resolve workspaceId + orgId from the project slug.
 * Throws on any failure (callers in the provisioning flow want a hard stop,
 * unlike the soft-fail read path).
 */
export async function openAdminSession(creds: AdminCreds, fetchImpl: FetchImpl = vaultFetch): Promise<AdminSession> {
  const host = trimHost(creds.host);
  const slug = creds.projectSlug || DEFAULT_PROJECT_SLUG;

  const loginRes = await fetchImpl(`${host}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
  });
  if (!loginRes.ok) throw new Error(`infisical login failed (${loginRes.status})`);
  const { accessToken } = await asJson(loginRes);
  if (!accessToken) throw new Error('infisical login: no accessToken');

  const wsRes = await fetchImpl(`${host}/api/v1/workspace`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!wsRes.ok) throw new Error(`infisical workspace lookup failed (${wsRes.status})`);
  const { workspaces = [] } = await asJson(wsRes);
  const project = workspaces.find((w: any) => w.slug === slug);
  if (!project) throw new Error(`infisical project '${slug}' not visible to this identity`);

  return { token: accessToken, host, projectId: project.id, orgId: project.orgId ?? project.organization };
}

/**
 * The EXACT CASL for the standing `newproject-provisioner` PROJECT role
 * (plan §1). Org-level `identity:create` is granted via the identity's org
 * role, separately (see createProvisionerIdentity). Deliberately:
 *   - secrets read+create+edit on **\/projects\/**  (NO delete — rollback via .bak)
 *   - secrets read on **\/shared\/**                 (needed to grant new ids /shared read)
 *   - identity create+edit (project)                 (mint + scope per-project ids)
 *   - NOTHING referencing /agents, /dashboard, /infrastructure → default-deny.
 */
export function provisionerProjectPermissions(): CaslPermission[] {
  return [
    {
      subject: 'secrets',
      action: ['read', 'create', 'edit'],
      conditions: { environment: { $eq: ENV_SLUG }, secretPath: { $glob: '/projects/**' } },
    },
    // secret-folders create/read scoped to /projects/** — needed to establish
    // each per-project /projects/<name>/ namespace before writing its secrets.
    // (Infisical separates `secrets` and `secret-folders` subjects; without
    // this, secret-create under a not-yet-existing folder 404s.)
    {
      subject: 'secret-folders',
      action: ['read', 'create'],
      conditions: { environment: { $eq: ENV_SLUG }, secretPath: { $glob: '/projects/**' } },
    },
    {
      subject: 'secrets',
      action: ['read'],
      conditions: { environment: { $eq: ENV_SLUG }, secretPath: { $glob: '/shared/**' } },
    },
    { subject: 'identity', action: ['create', 'edit'] },
    // Project-ROLE management: mintProjectReadIdentity() creates a per-project
    // read role (POST /api/v2/workspace/{id}/roles) as its first op, so the
    // provisioner needs `role` create/edit/read. NO delete (rollback is by
    // .bak, not role-delete) and NOT org-level — project-role mgmt only.
    // (Found live by project-bootstrap: without this the first vault op 403s.
    // Project roles aren't path-scoped objects, so this grant can't be
    // glob-narrowed further — it's the irreducible role-mgmt grant, the
    // analogue of identity:create. Per-project ISOLATION is still preserved by
    // the read role it builds being scoped to /projects/<name>/** only.)
    { subject: 'role', action: ['read', 'create', 'edit'] },
  ];
}

/**
 * ORG-level CASL for the provisioner (least privilege). The provisioner must
 * mint per-project machine identities AND their Universal-Auth client secrets;
 * the built-in "member" org role can create an identity + attach UA but NOT
 * mint a client secret (403) — that needs the org `identity` action
 * `create-token` (found live by project-bootstrap 2026-05-30). We grant exactly
 * `identity: read/create/edit/create-token` and NOTHING else — no delete, no
 * revoke-auth, no grant-privileges, no other subject, NOT org-admin.
 */
export function orgProvisionerPermissions(): CaslPermission[] {
  return [
    { subject: 'identity', action: ['read', 'create', 'edit', 'create-token'] },
  ];
}

/**
 * CASL for a per-project READ-ONLY consumer identity (plan §2 step 2):
 * read-only on /projects/<name>/** + /shared/**, nothing else.
 */
export function projectReadPermissions(projectName: string): CaslPermission[] {
  return [
    {
      subject: 'secrets',
      action: ['read'],
      conditions: { environment: { $eq: ENV_SLUG }, secretPath: { $glob: `/projects/${projectName}/**` } },
    },
    {
      subject: 'secrets',
      action: ['read'],
      conditions: { environment: { $eq: ENV_SLUG }, secretPath: { $glob: '/shared/**' } },
    },
  ];
}

/**
 * Create a custom ORG role with the given permissions, converge-on-conflict
 * (PATCH) like createProjectRole. Returns its slug. NOTE: org-role management
 * is an org-admin capability — a project-admin token (e.g. the short-lived
 * temp-admin) gets 403 here; this runs only when create-provisioner is invoked
 * by an org admin (or Sondre creates the role in the UI).
 */
export async function createOrgRole(
  session: AdminSession,
  roleSlug: string,
  roleName: string,
  permissions: CaslPermission[],
  fetchImpl: FetchImpl = vaultFetch,
): Promise<string> {
  const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  const base = `${session.host}/api/v1/organization/${session.orgId}/roles`;
  const res = await fetchImpl(base, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ slug: roleSlug, name: roleName, permissions }),
  });
  if (res.ok) return roleSlug;
  if (res.status === 400 || res.status === 409 || res.status === 422) {
    const listRes = await fetchImpl(base, { headers: { Authorization: `Bearer ${session.token}` } });
    if (listRes.ok) {
      const list = await asJson(listRes);
      const existing = (list.roles ?? []).find((r: any) => r.slug === roleSlug);
      if (existing?.id) {
        const patchRes = await fetchImpl(`${base}/${existing.id}`, {
          method: 'PATCH', headers: auth, body: JSON.stringify({ name: roleName, permissions }),
        });
        if (patchRes.ok) return roleSlug;
        throw new Error(`update org role '${roleSlug}' failed (${patchRes.status})`);
      }
    }
  }
  throw new Error(`create org role '${roleSlug}' failed (${res.status})`);
}

/** Set an existing identity's ORG role (idempotent — covers the reuse path). */
export async function setIdentityOrgRole(
  session: AdminSession,
  identityId: string,
  roleSlug: string,
  fetchImpl: FetchImpl = vaultFetch,
): Promise<void> {
  const res = await fetchImpl(`${session.host}/api/v1/identities/${identityId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: roleSlug }),
  });
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    throw new Error(`set org role '${roleSlug}' on identity failed (${res.status})`);
  }
}

/**
 * Find an existing org identity by name. Returns its id or null. Used to make
 * minting idempotent — re-running a provision must NOT create a duplicate
 * identity. Soft: returns null on any read failure (caller then attempts create).
 */
export async function findIdentityByName(
  session: AdminSession,
  name: string,
  fetchImpl: FetchImpl = vaultFetch,
): Promise<string | null> {
  const res = await fetchImpl(`${session.host}/api/v2/organizations/${session.orgId}/identity-memberships`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) return null;
  const json = await asJson(res);
  const memberships = json.identityMemberships ?? json.identities ?? [];
  for (const m of memberships) {
    const ident = m.identity ?? m;
    if (ident?.name === name && ident?.id) return ident.id;
  }
  return null;
}

/** Create a custom project role with the given permissions. Returns its slug. */
export async function createProjectRole(
  session: AdminSession,
  roleSlug: string,
  roleName: string,
  permissions: CaslPermission[],
  fetchImpl: FetchImpl = vaultFetch,
): Promise<string> {
  // Project-roles collection is /api/v2 on this Infisical version (v1 → 404,
  // confirmed live 2026-05-30). Body shape: { slug, name, permissions }.
  const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  const res = await fetchImpl(`${session.host}/api/v2/workspace/${session.projectId}/roles`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ slug: roleSlug, name: roleName, permissions }),
  });
  if (res.ok) return roleSlug;
  // Already exists → converge it: find the role id, PATCH its permissions so a
  // re-run applies the current CASL (idempotent AND self-correcting).
  if (res.status === 400 || res.status === 409 || res.status === 422) {
    const listRes = await fetchImpl(`${session.host}/api/v2/workspace/${session.projectId}/roles`, { headers: { Authorization: `Bearer ${session.token}` } });
    if (listRes.ok) {
      const list = await asJson(listRes);
      const existing = (list.roles ?? []).find((r: any) => r.slug === roleSlug);
      if (existing?.id) {
        const patchRes = await fetchImpl(`${session.host}/api/v2/workspace/${session.projectId}/roles/${existing.id}`, {
          method: 'PATCH', headers: auth, body: JSON.stringify({ name: roleName, permissions }),
        });
        if (patchRes.ok) return roleSlug;
        throw new Error(`update project role '${roleSlug}' failed (${patchRes.status})`);
      }
    }
  }
  throw new Error(`create project role '${roleSlug}' failed (${res.status})`);
}

/**
 * Ensure a secret folder path exists (idempotent). Creates the leaf folder
 * under its parent; tolerates "already exists". Used to establish the
 * /projects/<name>/ namespace before writing its secrets.
 */
export async function ensureFolder(
  session: AdminSession,
  parentPath: string,
  name: string,
  fetchImpl: FetchImpl = vaultFetch,
): Promise<void> {
  const res = await fetchImpl(`${session.host}/api/v1/folders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: session.projectId, environment: ENV_SLUG, path: parentPath, name }),
  });
  if (!res.ok && res.status !== 409 && res.status !== 400) {
    throw new Error(`ensure folder ${parentPath}/${name} failed (${res.status})`);
  }
}

/**
 * Mint a machine identity, attach Universal Auth, create a client secret, and
 * read back the clientId (from the GET, not the mint POST — the gotcha).
 * Adds it to the project with `projectRoleSlug` if provided.
 *
 * @param orgRole  org membership role slug for the new identity. Per-project
 *                 read identities use 'no-access' (least privilege; all real
 *                 power comes from the scoped project role).
 */
export async function mintIdentity(
  session: AdminSession,
  opts: { name: string; orgRole?: string; projectRoleSlug?: string; dryRun?: boolean },
  fetchImpl: FetchImpl = vaultFetch,
): Promise<MintedIdentity> {
  if (opts.dryRun) {
    return { identityId: 'dry-run-identity-id', clientId: 'dry-run-client-id', clientSecret: 'dry-run-client-secret' };
  }
  const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };

  // 1) Idempotency: reuse an existing identity of this name rather than
  //    creating a duplicate. Only POST /identities when none exists.
  let identityId = await findIdentityByName(session, opts.name, fetchImpl);
  if (!identityId) {
    const createRes = await fetchImpl(`${session.host}/api/v1/identities`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: opts.name, organizationId: session.orgId, role: opts.orgRole ?? 'no-access' }),
    });
    if (!createRes.ok) throw new Error(`create identity '${opts.name}' failed (${createRes.status})`);
    const created = await asJson(createRes);
    identityId = created.identity?.id;
    if (!identityId) throw new Error(`create identity '${opts.name}': no id in response`);
  }

  // 2) Attach Universal Auth.
  const uaRes = await fetchImpl(`${session.host}/api/v1/auth/universal-auth/identities/${identityId}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ accessTokenTTL: 2592000, accessTokenMaxTTL: 2592000, clientSecretTrustedIps: [{ ipAddress: '0.0.0.0/0' }], accessTokenTrustedIps: [{ ipAddress: '0.0.0.0/0' }] }),
  });
  // 409/400 = UA already attached (idempotent re-run) — tolerate it.
  if (!uaRes.ok && uaRes.status !== 409 && uaRes.status !== 400) {
    throw new Error(`attach universal-auth to '${opts.name}' failed (${uaRes.status})`);
  }

  // 3) Mint a client secret. NOTE: this response does NOT carry clientId.
  const csRes = await fetchImpl(`${session.host}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ description: `cortextos new-project (${opts.name})`, numUsesLimit: 0, ttl: 0 }),
  });
  if (!csRes.ok) throw new Error(`mint client secret for '${opts.name}' failed (${csRes.status})`);
  const csJson = await asJson(csRes);
  const clientSecret = csJson.clientSecret?.clientSecret ?? csJson.clientSecret;
  if (!clientSecret || typeof clientSecret !== 'string') throw new Error(`mint client secret for '${opts.name}': no clientSecret in response`);

  // 4) clientId GOTCHA: read it from the GET, not the mint POST above.
  const getRes = await fetchImpl(`${session.host}/api/v1/auth/universal-auth/identities/${identityId}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!getRes.ok) throw new Error(`read clientId for '${opts.name}' failed (${getRes.status})`);
  const getJson = await asJson(getRes);
  const clientId = getJson.identityUniversalAuth?.clientId;
  if (!clientId) throw new Error(`read clientId for '${opts.name}': not in identityUniversalAuth`);

  // 5) Add to project with the scoped role (privilege-escalation prevention in
  //    Infisical caps the granted role at ≤ the granter's own scope).
  if (opts.projectRoleSlug) {
    const memUrl = `${session.host}/api/v2/workspace/${session.projectId}/identity-memberships/${identityId}`;
    const memBody = JSON.stringify({ role: opts.projectRoleSlug });
    let memRes = await fetchImpl(memUrl, { method: 'POST', headers: auth, body: memBody });
    // Some Infisical versions expose this as PUT; fall back on 404/405.
    if (memRes.status === 404 || memRes.status === 405) {
      memRes = await fetchImpl(memUrl, { method: 'PUT', headers: auth, body: memBody });
    }
    // 409/400 = identity already a member of the project (idempotent re-run).
    if (!memRes.ok && memRes.status !== 409 && memRes.status !== 400) {
      throw new Error(`add '${opts.name}' to project failed (${memRes.status})`);
    }
  }

  return { identityId, clientId, clientSecret };
}

/**
 * Mint (or idempotently reuse) a per-project READ-ONLY consumer identity:
 * `project-<name>-runtime`, scoped read-only to /projects/<name>/** + /shared/**.
 * Creates the scoped read role (idempotent) then mints the identity with it.
 * This is the identity whose creds go into the scaffolded child's .env.
 */
export async function mintProjectReadIdentity(
  session: AdminSession,
  projectName: string,
  opts: { dryRun?: boolean } = {},
  fetchImpl: FetchImpl = vaultFetch,
): Promise<MintedIdentity> {
  const roleSlug = `project-${projectName}-read`;
  if (opts.dryRun) {
    return { identityId: 'dry-run-identity-id', clientId: 'dry-run-client-id', clientSecret: 'dry-run-client-secret' };
  }
  await createProjectRole(session, roleSlug, `Read-only: project ${projectName}`, projectReadPermissions(projectName), fetchImpl);
  return mintIdentity(session, { name: `project-${projectName}-runtime`, orgRole: 'no-access', projectRoleSlug: roleSlug, dryRun: false }, fetchImpl);
}

/** Upsert a secret: POST (create) then PATCH (update) on 4xx-conflict. Idempotent. */
export async function upsertSecret(
  session: AdminSession,
  path: string,
  key: string,
  value: string,
  fetchImpl: FetchImpl = vaultFetch,
): Promise<void> {
  const base = `${session.host}/api/v3/secrets/raw/${encodeURIComponent(key)}`;
  const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  const createRes = await fetchImpl(base, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ workspaceId: session.projectId, environment: ENV_SLUG, secretPath: path, secretValue: value, type: 'shared' }),
  });
  if (createRes.ok) return;
  if (createRes.status === 400 || createRes.status === 409) {
    const patchRes = await fetchImpl(base, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ workspaceId: session.projectId, environment: ENV_SLUG, secretPath: path, secretValue: value }),
    });
    if (!patchRes.ok) throw new Error(`upsert ${path}/${key} PATCH failed (${patchRes.status})`);
    return;
  }
  throw new Error(`upsert ${path}/${key} POST failed (${createRes.status})`);
}

/**
 * One-time creation of the standing `newproject-provisioner` identity with the
 * exact CASL from plan §1. Runs LATER with a short-lived admin token Sondre
 * provides — NOT during a normal bootstrap run.
 *
 * Returns the provisioner clientId + clientSecret (caller stores them at
 * /agents/project-bootstrap/PROVISIONER_CLIENT_ID|SECRET). dryRun returns the
 * planned role + permissions without mutating anything.
 */
export async function createProvisionerIdentity(
  session: AdminSession,
  opts: { name?: string; dryRun?: boolean } = {},
  fetchImpl: FetchImpl = vaultFetch,
): Promise<{ identity: MintedIdentity | null; roleSlug: string; permissions: CaslPermission[]; orgRoleSlug: string; orgPermissions: CaslPermission[]; dryRun: boolean }> {
  const name = opts.name ?? 'newproject-provisioner';
  const roleSlug = 'newproject-provisioner';
  const orgRoleSlug = 'newproject-provisioner-org';
  const permissions = provisionerProjectPermissions();
  const orgPermissions = orgProvisionerPermissions();

  if (opts.dryRun) {
    return { identity: null, roleSlug, permissions, orgRoleSlug, orgPermissions, dryRun: true };
  }

  await createProjectRole(session, roleSlug, 'New-project provisioner', permissions, fetchImpl);
  // One-time: establish the /projects namespace root (admin-created here so the
  // provisioner's /projects/** folder-create scope can make per-project subfolders).
  await ensureFolder(session, '/', 'projects', fetchImpl);
  // Least-privilege ORG role: lets the provisioner mint per-project identities +
  // their client secrets (identity:create-token) without org-admin. Creating an
  // org role needs org-admin — a project-admin token 403s here, by design (the
  // live grant is Sondre's call).
  await createOrgRole(session, orgRoleSlug, 'New-project provisioner (org)', orgPermissions, fetchImpl);
  const identity = await mintIdentity(session, { name, orgRole: orgRoleSlug, projectRoleSlug: roleSlug, dryRun: false }, fetchImpl);
  // Ensure the org role sticks on the reuse path too (mintIdentity only sets it on create).
  await setIdentityOrgRole(session, identity.identityId, orgRoleSlug, fetchImpl);
  return { identity, roleSlug, permissions, orgRoleSlug, orgPermissions, dryRun: false };
}

export { DEFAULT_PROJECT_SLUG, ENV_SLUG };
