import { describe, it, expect, vi } from 'vitest';
import {
  provisionerProjectPermissions,
  projectReadPermissions,
  mintIdentity,
  mintProjectReadIdentity,
  createProvisionerIdentity,
  upsertSecret,
  findIdentityByName,
  type AdminSession,
  type FetchImpl,
} from '../../../src/provision/infisical-admin.js';

const SESSION: AdminSession = {
  token: 'tok', host: 'http://localhost:8090', projectId: 'proj-1', orgId: 'org-1',
};

/** Build a mock fetch that routes by `${METHOD} ${pathSuffix}` → response spec. */
function mockFetch(routes: Record<string, { ok?: boolean; status?: number; body?: any }>): { fn: FetchImpl; calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = String(url);
    calls.push({ method, url: u });
    // key = "METHOD /path-fragment"; match by method AND url-contains-fragment,
    // longest fragment wins (so /client-secrets beats the bare identity path).
    const key = Object.keys(routes)
      .filter(k => {
        const sp = k.indexOf(' ');
        const m = k.slice(0, sp);
        const frag = k.slice(sp + 1);
        return m === method && u.includes(frag);
      })
      .sort((a, b) => b.length - a.length)[0];
    const spec = key ? routes[key] : { ok: true, status: 200, body: {} };
    const status = spec.status ?? (spec.ok === false ? 400 : 200);
    return {
      ok: spec.ok ?? (status >= 200 && status < 300),
      status,
      text: async () => JSON.stringify(spec.body ?? {}),
    } as Response;
  }) as unknown as FetchImpl;
  return { fn, calls };
}

describe('infisical-admin CASL (scope-creep guard)', () => {
  describe('provisionerProjectPermissions', () => {
    const perms = provisionerProjectPermissions();

    it('grants secrets read+create+edit on /projects/** but NOT delete', () => {
      const projectsRule = perms.find(p => p.subject === 'secrets' && (p.conditions?.secretPath as any)?.$glob === '/projects/**');
      expect(projectsRule).toBeDefined();
      expect(projectsRule!.action.sort()).toEqual(['create', 'edit', 'read']);
      expect(projectsRule!.action).not.toContain('delete');
    });

    it('grants read on /shared/**', () => {
      const sharedRule = perms.find(p => p.subject === 'secrets' && (p.conditions?.secretPath as any)?.$glob === '/shared/**');
      expect(sharedRule).toBeDefined();
      expect(sharedRule!.action).toEqual(['read']);
    });

    it('grants secret-folders read+create on /projects/** (to establish namespaces) but NOT delete', () => {
      const folderRule = perms.find(p => p.subject === 'secret-folders');
      expect(folderRule).toBeDefined();
      expect((folderRule!.conditions?.secretPath as any)?.$glob).toBe('/projects/**');
      expect(folderRule!.action.sort()).toEqual(['create', 'read']);
      expect(folderRule!.action).not.toContain('delete');
    });

    it('grants project identity create+edit', () => {
      const idRule = perms.find(p => p.subject === 'identity');
      expect(idRule).toBeDefined();
      expect(idRule!.action.sort()).toEqual(['create', 'edit']);
    });

    it('grants project ROLE read+create+edit (for per-project read roles) but NOT delete, NOT org-level', () => {
      const roleRule = perms.find(p => p.subject === 'role');
      expect(roleRule).toBeDefined();
      expect(roleRule!.action.sort()).toEqual(['create', 'edit', 'read']);
      expect(roleRule!.action).not.toContain('delete');
    });

    it('DEFAULT-DENY: zero permission references /agents, /dashboard, or /infrastructure', () => {
      const serialized = JSON.stringify(perms);
      expect(serialized).not.toContain('/agents');
      expect(serialized).not.toContain('/dashboard');
      expect(serialized).not.toContain('/infrastructure');
    });

    it('has exactly 5 permission entries (no extras snuck in)', () => {
      expect(perms).toHaveLength(5);
    });
  });

  describe('projectReadPermissions', () => {
    const perms = projectReadPermissions('myapp');

    it('is read-only on /projects/myapp/** + /shared/**, nothing else', () => {
      expect(perms).toHaveLength(2);
      for (const p of perms) {
        expect(p.subject).toBe('secrets');
        expect(p.action).toEqual(['read']);   // read-only, never write
      }
      const globs = perms.map(p => (p.conditions?.secretPath as any)?.$glob).sort();
      expect(globs).toEqual(['/projects/myapp/**', '/shared/**']);
    });

    it('DEFAULT-DENY: zero reference to /agents, /dashboard, /infrastructure', () => {
      const serialized = JSON.stringify(perms);
      expect(serialized).not.toContain('/agents');
      expect(serialized).not.toContain('/dashboard');
      expect(serialized).not.toContain('/infrastructure');
    });

    it('scopes the project glob to the exact name (no wildcard leak across projects)', () => {
      const other = projectReadPermissions('other');
      expect(JSON.stringify(other)).not.toContain('/projects/myapp/');
    });
  });
});

describe('infisical-admin minting', () => {
  const baseRoutes = () => ({
    'POST /api/v1/identities': { body: { identity: { id: 'new-id' } } },
    'POST /api/v1/auth/universal-auth/identities/new-id/client-secrets': { body: { clientSecret: { clientSecret: 'SECRET-VALUE' } } },
    'POST /api/v1/auth/universal-auth/identities/existing-id/client-secrets': { body: { clientSecret: { clientSecret: 'SECRET-VALUE' } } },
    'POST /api/v1/auth/universal-auth/identities/new-id': { body: {} },
    'POST /api/v1/auth/universal-auth/identities/existing-id': { body: {} },
    'GET /api/v1/auth/universal-auth/identities/new-id': { body: { identityUniversalAuth: { clientId: 'CLIENT-ID-FROM-GET' } } },
    'GET /api/v1/auth/universal-auth/identities/existing-id': { body: { identityUniversalAuth: { clientId: 'CLIENT-ID-FROM-GET' } } },
    'POST /api/v2/workspace/proj-1/identity-memberships': { body: {} },
  });

  it('reads clientId from the GET, NOT the client-secrets POST (the gotcha)', async () => {
    const routes = baseRoutes();
    // identity does not exist yet
    const { fn } = mockFetch({ ...routes, 'GET /api/v2/organizations/org-1/identity-memberships': { body: { identityMemberships: [] } } });
    const result = await mintIdentity(SESSION, { name: 'thing', projectRoleSlug: 'r' }, fn);
    expect(result.clientId).toBe('CLIENT-ID-FROM-GET');
    expect(result.clientSecret).toBe('SECRET-VALUE');
  });

  it('idempotent: reuses an existing identity, issues NO POST /identities', async () => {
    const { fn, calls } = mockFetch({
      ...baseRoutes(),
      'GET /api/v2/organizations/org-1/identity-memberships': { body: { identityMemberships: [{ identity: { id: 'existing-id', name: 'thing' } }] } },
      'GET /api/v1/auth/universal-auth/identities/existing-id': { body: { identityUniversalAuth: { clientId: 'EXISTING-CLIENT-ID' } } },
    });
    const result = await mintIdentity(SESSION, { name: 'thing', projectRoleSlug: 'r' }, fn);
    expect(result.identityId).toBe('existing-id');
    expect(result.clientId).toBe('EXISTING-CLIENT-ID');
    const postIdentities = calls.filter(c => c.method === 'POST' && c.url.endsWith('/api/v1/identities'));
    expect(postIdentities).toHaveLength(0);  // <-- no duplicate identity created
  });

  it('creates a new identity (POST /identities) when none exists', async () => {
    const { fn, calls } = mockFetch({
      ...baseRoutes(),
      'GET /api/v2/organizations/org-1/identity-memberships': { body: { identityMemberships: [] } },
    });
    await mintIdentity(SESSION, { name: 'thing', projectRoleSlug: 'r' }, fn);
    const postIdentities = calls.filter(c => c.method === 'POST' && c.url.endsWith('/api/v1/identities'));
    expect(postIdentities).toHaveLength(1);
  });

  it('createProvisionerIdentity --dry-run makes ZERO network calls and returns the CASL', async () => {
    const { fn, calls } = mockFetch({});
    const result = await createProvisionerIdentity(SESSION, { dryRun: true }, fn);
    expect(calls).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect(result.identity).toBeNull();
    expect(result.roleSlug).toBe('newproject-provisioner');
    expect(result.permissions).toEqual(provisionerProjectPermissions());
  });

  it('mintProjectReadIdentity --dry-run makes ZERO network calls', async () => {
    const { fn, calls } = mockFetch({});
    const result = await mintProjectReadIdentity(SESSION, 'myapp', { dryRun: true }, fn);
    expect(calls).toHaveLength(0);
    expect(result.clientId).toBe('dry-run-client-id');
  });
});

describe('infisical-admin upsertSecret', () => {
  it('POST succeeds → no PATCH', async () => {
    const { fn, calls } = mockFetch({ 'POST /api/v3/secrets/raw/KEY': { ok: true, status: 200, body: {} } });
    await upsertSecret(SESSION, '/projects/x', 'KEY', 'v', fn);
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });

  it('POST 400 (exists) → PATCH update', async () => {
    const { fn, calls } = mockFetch({
      'POST /api/v3/secrets/raw/KEY': { ok: false, status: 400, body: {} },
      'PATCH /api/v3/secrets/raw/KEY': { ok: true, status: 200, body: {} },
    });
    await upsertSecret(SESSION, '/projects/x', 'KEY', 'v', fn);
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
});
