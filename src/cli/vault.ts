/**
 * `cortextos vault` — Infisical vault management CLI.
 *
 * Subcommands:
 *   - list [path]                 List secret keys at a path (default /shared).
 *   - get <path>/<key>            Print a single secret value.
 *   - set <path>/<key> <value>    Write a secret (requires write scope).
 *   - rotate <path>/<key>         Interactive rotate: prompt new value, write,
 *                                 ask which consumer service to restart.
 *   - revoke-identity <name|id>   DELETE an identity. Warns if it looks like
 *                                 a permanent runtime identity.
 *
 * Identity resolution (used by every subcommand):
 *   1. `--identity <client_id>:<client_secret>` flag.
 *   2. `$INFISICAL_CLIENT_ID` + `$INFISICAL_CLIENT_SECRET` in process.env.
 *   3. Read commander's `.env` (the orchestrator agent owns admin-shaped
 *      read access by convention).
 *   4. Otherwise abort with the curl equivalent + a pointer to docs.
 *
 * Every error path prints the equivalent `curl` command so the operator can
 * fall back to raw API. The CLI is a convenience layer — not a single
 * source of truth — so when it can't help, it should still teach.
 */
import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { openAdminSession, createProvisionerIdentity, upsertSecret } from '../provision/infisical-admin.js';

const DEFAULT_HOST = process.env.INFISICAL_HOST || 'http://localhost:8090';
const DEFAULT_PROJECT_SLUG = process.env.INFISICAL_PROJECT_SLUG || 'sondre-hq-bq-wx';
const DOCS_REF = 'docs/infisical-vault.md';
const API_REF = 'https://infisical.com/docs/api-reference/overview';

interface Identity {
  host: string;
  clientId: string;
  clientSecret: string;
  source: 'flag' | 'env' | 'commander-env';
}

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Resolve which Universal Auth identity to use for the request.
 * Returns null and prints a friendly error if nothing is available.
 */
function resolveIdentity(opts: { identity?: string; host?: string }): Identity | null {
  // 1. --identity flag wins
  if (opts.identity) {
    const [clientId, clientSecret] = opts.identity.split(':');
    if (!clientId || !clientSecret) {
      process.stderr.write('Error: --identity must be in the form <client_id>:<client_secret>\n');
      return null;
    }
    return { host: opts.host || DEFAULT_HOST, clientId, clientSecret, source: 'flag' };
  }

  // 2. process.env (shell-sourced)
  if (process.env.INFISICAL_CLIENT_ID && process.env.INFISICAL_CLIENT_SECRET) {
    return {
      host: opts.host || process.env.INFISICAL_HOST || DEFAULT_HOST,
      clientId: process.env.INFISICAL_CLIENT_ID,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET,
      source: 'env',
    };
  }

  // 3. Commander's .env
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();
  const org = process.env.CTX_ORG || 'sondre-hq';
  const commanderEnv = join(frameworkRoot, 'orgs', org, 'agents', 'commander', '.env');
  const envFile = loadEnvFile(commanderEnv);
  if (envFile.INFISICAL_CLIENT_ID && envFile.INFISICAL_CLIENT_SECRET) {
    return {
      host: opts.host || envFile.INFISICAL_HOST || DEFAULT_HOST,
      clientId: envFile.INFISICAL_CLIENT_ID,
      clientSecret: envFile.INFISICAL_CLIENT_SECRET,
      source: 'commander-env',
    };
  }

  process.stderr.write(
    `Error: no Infisical identity available.\n` +
    `Provide one of:\n` +
    `  --identity <client_id>:<client_secret>\n` +
    `  $INFISICAL_CLIENT_ID + $INFISICAL_CLIENT_SECRET in env\n` +
    `  ${commanderEnv} with INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET set\n\n` +
    `Curl fallback (replace placeholders):\n` +
    `  curl -s -X POST ${opts.host || DEFAULT_HOST}/api/v1/auth/universal-auth/login \\\n` +
    `    -H 'Content-Type: application/json' \\\n` +
    `    -d '{"clientId":"...","clientSecret":"..."}'\n\n` +
    `Full API: ${API_REF}\n` +
    `Runbook: ${DOCS_REF}\n`,
  );
  return null;
}

interface Session {
  token: string;
  projectId: string;
  host: string;
}

/** Universal Auth login → workspace lookup. Returns null on any failure. */
async function openSession(ident: Identity): Promise<Session | null> {
  try {
    const loginRes = await fetch(`${ident.host}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: ident.clientId, clientSecret: ident.clientSecret }),
    });
    if (!loginRes.ok) {
      process.stderr.write(`Error: login failed (${loginRes.status})\n`);
      process.stderr.write(`Curl: curl -s -X POST ${ident.host}/api/v1/auth/universal-auth/login -H 'Content-Type: application/json' -d '{"clientId":"$CID","clientSecret":"$CS"}'\n`);
      process.stderr.write(`Full API: ${API_REF}\n`);
      return null;
    }
    const { accessToken } = await loginRes.json() as { accessToken?: string };
    if (!accessToken) {
      process.stderr.write(`Error: login response missing accessToken\n`);
      return null;
    }

    const wsRes = await fetch(`${ident.host}/api/v1/workspace`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!wsRes.ok) {
      process.stderr.write(`Error: workspace lookup failed (${wsRes.status})\n`);
      return null;
    }
    const { workspaces = [] } = await wsRes.json() as { workspaces?: { id: string; slug: string }[] };
    const project = workspaces.find(w => w.slug === DEFAULT_PROJECT_SLUG);
    if (!project) {
      process.stderr.write(`Error: identity has no membership in project '${DEFAULT_PROJECT_SLUG}'.\n`);
      process.stderr.write(`Available: ${workspaces.map(w => w.slug).join(', ') || '(none)'}\n`);
      process.stderr.write(`Runbook: ${DOCS_REF}\n`);
      return null;
    }
    return { token: accessToken, projectId: project.id, host: ident.host };
  } catch (err) {
    process.stderr.write(`Error: network/parse failure: ${(err as Error).message}\n`);
    return null;
  }
}

/** Split a path-with-key argument like "/shared/MY_KEY" into [path, key]. */
function splitPathKey(pathKey: string): { path: string; key: string } | null {
  const trimmed = pathKey.startsWith('/') ? pathKey : `/${pathKey}`;
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const path = trimmed.slice(0, lastSlash) || '/';
  const key = trimmed.slice(lastSlash + 1);
  if (!key) return null;
  return { path, key };
}

/** Print "Curl equivalent:" block for read at a path. */
function curlReadList(host: string, projectId: string, path: string): string {
  return (
    `Curl equivalent:\n` +
    `  TOKEN=$(curl -s -X POST ${host}/api/v1/auth/universal-auth/login \\\n` +
    `    -H 'Content-Type: application/json' -d '{"clientId":"$CID","clientSecret":"$CS"}' | jq -r .accessToken)\n` +
    `  curl -s '${host}/api/v3/secrets/raw?workspaceId=${projectId}&environment=prod&secretPath=${encodeURIComponent(path)}' \\\n` +
    `    -H "Authorization: Bearer $TOKEN" | jq -r '.secrets[].secretKey'\n`
  );
}

function curlReadOne(host: string, projectId: string, path: string, key: string): string {
  return (
    `Curl equivalent:\n` +
    `  curl -s '${host}/api/v3/secrets/raw/${encodeURIComponent(key)}?workspaceId=${projectId}&environment=prod&secretPath=${encodeURIComponent(path)}' \\\n` +
    `    -H "Authorization: Bearer $TOKEN" | jq -r .secret.secretValue\n`
  );
}

function curlWrite(host: string, projectId: string, path: string, key: string): string {
  return (
    `Curl equivalent:\n` +
    `  curl -s -X POST ${host}/api/v3/secrets/raw/${encodeURIComponent(key)} \\\n` +
    `    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\\n` +
    `    -d '{"workspaceId":"${projectId}","environment":"prod","secretValue":"<NEW_VALUE>","secretPath":"${path}","type":"shared"}'\n`
  );
}

function curlPatch(host: string, projectId: string, path: string, key: string): string {
  return (
    `Curl equivalent (update existing):\n` +
    `  curl -s -X PATCH ${host}/api/v3/secrets/raw/${encodeURIComponent(key)} \\\n` +
    `    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\\n` +
    `    -d '{"workspaceId":"${projectId}","environment":"prod","secretValue":"<NEW_VALUE>","secretPath":"${path}"}'\n`
  );
}

function curlDeleteIdentity(host: string, idOrName: string): string {
  return (
    `Curl equivalent:\n` +
    `  # If you have the identity name, list first:\n` +
    `  curl -s ${host}/api/v1/organization/identities \\\n` +
    `    -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.identities[] | select(.identity.name=="${idOrName}")'\n` +
    `  # Then delete by id:\n` +
    `  curl -s -X DELETE ${host}/api/v1/identities/<identity-id> \\\n` +
    `    -H "Authorization: Bearer $ADMIN_TOKEN"\n`
  );
}

async function listSecrets(session: Session, path: string, identitySource: Identity['source']): Promise<string[] | null> {
  const url = `${session.host}/api/v3/secrets/raw?workspaceId=${session.projectId}&environment=prod&secretPath=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!res.ok) {
    process.stderr.write(`Error: read failed at ${path} (${res.status}).\n`);
    if (identitySource === 'commander-env') {
      process.stderr.write(`Note: current identity (commander) is read-scoped to /shared + /agents/commander only.\n`);
      process.stderr.write(`If you need a wider path, pass --identity, set $INFISICAL_CLIENT_ID, or mint an admin identity (see ${DOCS_REF} — bootstrap-new-consumer section).\n`);
    }
    process.stderr.write(curlReadList(session.host, session.projectId, path));
    process.stderr.write(`Runbook: ${DOCS_REF}\n`);
    return null;
  }
  const { secrets = [] } = await res.json() as { secrets?: { secretKey: string }[] };
  return secrets.map(s => s.secretKey).sort();
}

async function getSecret(session: Session, path: string, key: string, identitySource: Identity['source']): Promise<string | null> {
  const url = `${session.host}/api/v3/secrets/raw/${encodeURIComponent(key)}?workspaceId=${session.projectId}&environment=prod&secretPath=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!res.ok) {
    if (res.status === 404) {
      process.stderr.write(`Error: secret ${path}/${key} not found (or current identity has no read scope on ${path}).\n`);
    } else {
      process.stderr.write(`Error: read failed (${res.status}).\n`);
    }
    if (identitySource === 'commander-env') {
      process.stderr.write(`Note: current identity (commander) is read-scoped to /shared + /agents/commander only.\n`);
      process.stderr.write(`If you need a wider path, pass --identity, set $INFISICAL_CLIENT_ID, or mint an admin identity (see ${DOCS_REF} — bootstrap-new-consumer section).\n`);
    }
    process.stderr.write(curlReadOne(session.host, session.projectId, path, key));
    process.stderr.write(`Runbook: ${DOCS_REF}\n`);
    return null;
  }
  const body = await res.json() as { secret?: { secretValue?: string } };
  return body.secret?.secretValue ?? null;
}

async function setSecret(session: Session, path: string, key: string, value: string): Promise<boolean> {
  // POST creates; if it already exists, fall through to PATCH.
  const url = `${session.host}/api/v3/secrets/raw/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: session.projectId,
      environment: 'prod',
      secretValue: value,
      secretPath: path,
      type: 'shared',
    }),
  });
  if (res.ok) return true;

  // 409 = already exists → PATCH.
  if (res.status === 409 || res.status === 400) {
    const patchRes = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: session.projectId,
        environment: 'prod',
        secretValue: value,
        secretPath: path,
      }),
    });
    if (patchRes.ok) return true;
    process.stderr.write(`Error: write failed (POST ${res.status}, PATCH ${patchRes.status}).\n`);
    process.stderr.write(`If your identity is read-only, mint a write-scoped admin identity first.\n`);
    process.stderr.write(curlPatch(session.host, session.projectId, path, key));
    process.stderr.write(`Runbook: ${DOCS_REF}\n`);
    return false;
  }

  if (res.status === 401 || res.status === 403) {
    process.stderr.write(`Error: identity lacks write scope on ${path} (${res.status}).\n`);
    process.stderr.write(`Mint a temp write identity via the UI at ${DEFAULT_HOST}, then re-run with --identity.\n`);
    process.stderr.write(curlWrite(session.host, session.projectId, path, key));
    process.stderr.write(`Runbook: ${DOCS_REF}\n`);
    return false;
  }

  process.stderr.write(`Error: write failed (${res.status}).\n`);
  process.stderr.write(curlWrite(session.host, session.projectId, path, key));
  process.stderr.write(`Full API: ${API_REF}\n`);
  return false;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

// --- Commands ---

const vaultCommand = new Command('vault')
  .description('Manage Infisical vault secrets and identities');

vaultCommand
  .command('list [path]')
  .description('List secret keys at a vault path (default /shared)')
  .option('--identity <id:secret>', 'Use ad-hoc Universal Auth identity (instead of env / commander)')
  .option('--host <url>', 'Override Infisical host (default: $INFISICAL_HOST or http://localhost:8090)')
  .action(async (path: string | undefined, opts: { identity?: string; host?: string }) => {
    const ident = resolveIdentity(opts);
    if (!ident) process.exit(1);
    const session = await openSession(ident!);
    if (!session) process.exit(1);

    const targetPath = path || '/shared';
    const keys = await listSecrets(session!, targetPath, ident!.source);
    if (keys === null) process.exit(1);

    if (keys!.length === 0) {
      // Infisical silently returns an empty list — not a 403 — when an
      // identity has no read scope on the path. The user can't tell
      // "genuinely empty" from "out of scope" without this hint. Always
      // print it; the wording reads fine even when the path is truly
      // empty (rare for any populated org path).
      process.stderr.write(`No secrets at ${targetPath}.\n`);
      process.stderr.write(`If you expected results, your identity may lack scope on this path. Try:\n`);
      process.stderr.write(`  cortextos vault list ${targetPath} --identity <client_id>:<client_secret>\n`);
      process.stderr.write(`Or: set $INFISICAL_CLIENT_ID + $INFISICAL_CLIENT_SECRET in env.\n`);
      process.stderr.write(`See ${DOCS_REF} for identity options.\n`);
      return;
    }
    process.stdout.write(`${targetPath} (${keys!.length} secret${keys!.length === 1 ? '' : 's'}):\n`);
    for (const k of keys!) process.stdout.write(`  ${k}\n`);
  });

vaultCommand
  .command('get <pathkey>')
  .description('Print a single vault secret value (e.g. cortextos vault get /shared/MY_KEY)')
  .option('--identity <id:secret>', 'Use ad-hoc identity')
  .option('--host <url>', 'Override Infisical host')
  .option('--quiet', 'Print just the value (no path/key header)')
  .action(async (pathkey: string, opts: { identity?: string; host?: string; quiet?: boolean }) => {
    const parts = splitPathKey(pathkey);
    if (!parts) {
      process.stderr.write(`Error: argument must be a path with key, e.g. /shared/MY_KEY\n`);
      process.exit(1);
    }
    const ident = resolveIdentity(opts);
    if (!ident) process.exit(1);
    const session = await openSession(ident!);
    if (!session) process.exit(1);

    const value = await getSecret(session!, parts!.path, parts!.key, ident!.source);
    if (value === null) process.exit(1);

    if (opts.quiet) process.stdout.write(`${value}\n`);
    else process.stdout.write(`${parts!.path}/${parts!.key}=${value}\n`);
  });

vaultCommand
  .command('set <pathkey> <value>')
  .description('Write a secret (POST, or PATCH if it already exists). Requires write scope.')
  .option('--identity <id:secret>', 'Use ad-hoc identity (recommended — your default identity is usually read-only)')
  .option('--host <url>', 'Override Infisical host')
  .action(async (pathkey: string, value: string, opts: { identity?: string; host?: string }) => {
    const parts = splitPathKey(pathkey);
    if (!parts) {
      process.stderr.write(`Error: argument must be a path with key, e.g. /shared/MY_KEY\n`);
      process.exit(1);
    }
    const ident = resolveIdentity(opts);
    if (!ident) process.exit(1);
    const session = await openSession(ident!);
    if (!session) process.exit(1);

    const ok = await setSecret(session!, parts!.path, parts!.key, value);
    if (!ok) process.exit(1);
    process.stdout.write(`Wrote ${parts!.path}/${parts!.key} (${value.length} chars).\n`);
    process.stdout.write(`Reminder: consumer agents/services need a hard restart to pick up the new value — \`cortextos restart <agent>\` or \`pm2 restart <name>\`.\n`);
  });

vaultCommand
  .command('rotate <pathkey>')
  .description('Interactive rotate: read current, prompt new, write, prompt which consumer to restart.')
  .option('--identity <id:secret>', 'Use ad-hoc identity (recommended for write)')
  .option('--host <url>', 'Override Infisical host')
  .action(async (pathkey: string, opts: { identity?: string; host?: string }) => {
    const parts = splitPathKey(pathkey);
    if (!parts) {
      process.stderr.write(`Error: argument must be a path with key, e.g. /shared/MY_KEY\n`);
      process.exit(1);
    }
    const ident = resolveIdentity(opts);
    if (!ident) process.exit(1);
    const session = await openSession(ident!);
    if (!session) process.exit(1);

    const current = await getSecret(session!, parts!.path, parts!.key, ident!.source);
    if (current === null) process.exit(1);
    process.stdout.write(`Current value of ${parts!.path}/${parts!.key}: ${current!.length} chars, starts ${current!.slice(0, 6)}...\n`);

    const newValue = (await prompt('New value (or blank to abort): ')).trim();
    if (!newValue) {
      process.stdout.write('Aborted — no change.\n');
      process.exit(0);
    }

    const ok = await setSecret(session!, parts!.path, parts!.key, newValue);
    if (!ok) process.exit(1);
    process.stdout.write(`Wrote new value (${newValue.length} chars).\n`);

    const target = (await prompt('Restart which consumer? (e.g. "cortextos:dev", "pm2:freellmapi", "pm2:dashboard-preview", or blank to skip): ')).trim();
    if (!target) {
      process.stdout.write('Skipped restart. Remember to do it manually.\n');
      process.exit(0);
    }

    const [system, name] = target.split(':');
    if (system === 'cortextos' && name) {
      await new Promise<void>((res) => {
        const p = spawn('cortextos', ['restart', name], { stdio: 'inherit' });
        p.on('close', () => res());
      });
    } else if (system === 'pm2' && name) {
      await new Promise<void>((res) => {
        const p = spawn('pm2', ['restart', name], { stdio: 'inherit' });
        p.on('close', () => res());
      });
    } else {
      process.stdout.write(`Unrecognised consumer "${target}". Restart manually.\n`);
    }
  });

vaultCommand
  .command('revoke-identity <nameOrId>')
  .description('DELETE an Infisical machine identity by name or id. Warns on runtime identities.')
  .option('--identity <id:secret>', 'Use ad-hoc admin identity (required — read-only identities cannot revoke)')
  .option('--host <url>', 'Override Infisical host')
  .option('--force', 'Skip confirm prompt')
  .action(async (nameOrId: string, opts: { identity?: string; host?: string; force?: boolean }) => {
    const ident = resolveIdentity(opts);
    if (!ident) process.exit(1);
    const session = await openSession(ident!);
    if (!session) process.exit(1);

    // Resolve to identityId. Try name lookup first; fall back to treating
    // the arg as a raw UUID. We pull the org's identity list and search.
    let identityId = nameOrId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId);
    let resolvedName: string | undefined;
    if (!isUuid) {
      const listRes = await fetch(`${session!.host}/api/v1/organization/identities?limit=200`, {
        headers: { Authorization: `Bearer ${session!.token}` },
      });
      if (!listRes.ok) {
        process.stderr.write(`Error: identity list failed (${listRes.status}).\n`);
        process.stderr.write(curlDeleteIdentity(session!.host, nameOrId));
        process.stderr.write(`Full API: ${API_REF}\n`);
        process.exit(1);
      }
      const body = await listRes.json() as { identities?: { identity: { id: string; name: string } }[] };
      const matches = (body.identities || []).filter(e => e.identity?.name === nameOrId);
      if (matches.length === 0) {
        process.stderr.write(`Error: no identity named "${nameOrId}".\n`);
        process.stderr.write(curlDeleteIdentity(session!.host, nameOrId));
        process.exit(1);
      }
      if (matches.length > 1) {
        process.stderr.write(`Error: ${matches.length} identities named "${nameOrId}". Pass the UUID instead.\n`);
        for (const m of matches) process.stderr.write(`  ${m.identity.id}\n`);
        process.exit(1);
      }
      identityId = matches[0].identity.id;
      resolvedName = matches[0].identity.name;
    }

    // Heuristic: if the name ends in "-runtime" it is a long-lived consumer
    // identity; deleting it would break a live service. Require --force.
    if (resolvedName && /-runtime$/.test(resolvedName) && !opts.force) {
      process.stderr.write(`Refusing to delete "${resolvedName}" — looks like a runtime identity.\n`);
      process.stderr.write(`If you really mean it, re-run with --force.\n`);
      process.exit(1);
    }

    if (!opts.force) {
      const confirm = (await prompt(`Delete identity "${resolvedName || identityId}" (${identityId})? [yes/N] `)).trim().toLowerCase();
      if (confirm !== 'yes' && confirm !== 'y') {
        process.stdout.write('Aborted.\n');
        process.exit(0);
      }
    }

    const delRes = await fetch(`${session!.host}/api/v1/identities/${identityId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session!.token}` },
    });
    if (!delRes.ok) {
      process.stderr.write(`Error: delete failed (${delRes.status}).\n`);
      process.stderr.write(`Your identity may not have org-admin scope.\n`);
      process.stderr.write(curlDeleteIdentity(session!.host, nameOrId));
      process.stderr.write(`Full API: ${API_REF}\n`);
      process.exit(1);
    }
    process.stdout.write(`Deleted identity ${resolvedName || ''} (${identityId}).\n`);
  });

vaultCommand
  .command('create-provisioner')
  .description('ONE-TIME: create the newproject-provisioner identity with the scoped CASL (plan §1). Requires a short-lived ADMIN identity via --identity.')
  .option('--identity <id:secret>', 'Short-lived ADMIN Universal Auth identity (Sondre mints, then revokes)')
  .option('--host <url>', 'Override Infisical host')
  .option('--name <name>', 'Identity name', 'newproject-provisioner')
  .option('--dry-run', 'Print the role + exact CASL that WOULD be created; make no network calls')
  .option('--store', 'After creating, write the creds to /agents/project-bootstrap/PROVISIONER_CLIENT_ID|SECRET')
  .action(async (opts: { identity?: string; host?: string; name: string; dryRun?: boolean; store?: boolean }) => {
    if (opts.dryRun) {
      // No creds needed — show the exact permission set that would be applied.
      const { roleSlug, permissions, orgRoleSlug, orgPermissions } = await createProvisionerIdentity(
        { token: '', host: '', projectId: '', orgId: '' },
        { name: opts.name, dryRun: true },
      );
      process.stdout.write(`[dry-run] would create PROJECT role '${roleSlug}' with CASL:\n`);
      process.stdout.write(JSON.stringify(permissions, null, 2) + '\n');
      process.stdout.write(`[dry-run] would create ORG role '${orgRoleSlug}' (least-priv, needs org-admin to apply) with CASL:\n`);
      process.stdout.write(JSON.stringify(orgPermissions, null, 2) + '\n');
      process.stdout.write(`[dry-run] would mint identity '${opts.name}' with org role '${orgRoleSlug}' + project role '${roleSlug}'.\n`);
      process.stdout.write(`[dry-run] no network calls made.\n`);
      return;
    }

    const ident = resolveIdentity(opts);
    if (!ident) process.exit(1);
    let result;
    try {
      const session = await openAdminSession({ host: ident!.host, clientId: ident!.clientId, clientSecret: ident!.clientSecret });
      result = await createProvisionerIdentity(session, { name: opts.name });
      if (opts.store && result.identity) {
        await upsertSecret(session, '/agents/project-bootstrap', 'PROVISIONER_CLIENT_ID', result.identity.clientId);
        await upsertSecret(session, '/agents/project-bootstrap', 'PROVISIONER_CLIENT_SECRET', result.identity.clientSecret);
        process.stdout.write(`Stored PROVISIONER_CLIENT_ID|SECRET at /agents/project-bootstrap.\n`);
      }
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.stderr.write(`This requires an admin-scoped identity. See ${DOCS_REF} (bootstrap-new-consumer).\n`);
      process.exit(1);
    }
    process.stdout.write(`Created provisioner identity '${opts.name}' (role: ${result.roleSlug}).\n`);
    if (!opts.store) {
      process.stdout.write(`clientId:     ${result.identity!.clientId}\n`);
      process.stdout.write(`clientSecret: ${result.identity!.clientSecret}\n`);
      process.stdout.write(`Store these at /agents/project-bootstrap/PROVISIONER_CLIENT_ID|SECRET (or re-run with --store).\n`);
    }
  });

export { vaultCommand };
