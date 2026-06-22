/**
 * `cortextos new-project <name>` — scaffold a production-ready project with
 * per-project vault provisioning, ECC capability payload, and optional Convex
 * backend + GitHub remote.
 *
 * This is the deterministic mechanical entrypoint. The project-bootstrap
 * `new-project` SKILL wraps it in the Superpowers orchestration spine
 * (brainstorming → writing-plans gates → THIS scaffold+provision → wave2 TDD →
 * review → verification → finish-branch).
 *
 * Decisions baked in (commander, production-readiness plan §DECISIONS):
 *   - Per-project read identity (NOT a shared reader).
 *   - Secrets namespace = /projects/<name>/.
 *   - GitHub = personal (sondrealf), PRIVATE, --remote OPT-IN: ALWAYS git-init
 *     locally; create+push a remote ONLY with --remote. Default = local-only.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, renameSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { validateAgentName } from '../utils/validate.js';
import { fetchInfisicalSecrets } from '../utils/infisical-fetch.js';
import { openAdminSession, mintProjectReadIdentity, upsertSecret, ensureFolder, type AdminCreds } from '../provision/infisical-admin.js';
import { renderStack, allocatePortsAsync, genSecret, type StackTokens } from './project-stack.js';

export const SUPPORTED_LANGS = ['typescript', 'python', 'go', 'rust'] as const;
export type Lang = typeof SUPPORTED_LANGS[number];

const LANG_ALIASES: Record<string, Lang> = {
  ts: 'typescript', node: 'typescript', nodejs: 'typescript', js: 'typescript', javascript: 'typescript',
  py: 'python', golang: 'go', rs: 'rust',
};

/** Resolve a language token (or detect from existing files in dir). Pure. */
export function resolveLang(explicit: string | undefined, dirFiles: string[] = []): Lang {
  if (explicit) {
    const t = explicit.toLowerCase();
    if ((SUPPORTED_LANGS as readonly string[]).includes(t)) return t as Lang;
    if (LANG_ALIASES[t]) return LANG_ALIASES[t];
    throw new Error(`unsupported --lang '${explicit}'. Supported: ${SUPPORTED_LANGS.join(', ')} (+ aliases)`);
  }
  // detect from marker files
  if (dirFiles.includes('package.json') || dirFiles.includes('tsconfig.json')) return 'typescript';
  if (dirFiles.includes('pyproject.toml') || dirFiles.includes('requirements.txt')) return 'python';
  if (dirFiles.includes('go.mod')) return 'go';
  if (dirFiles.includes('Cargo.toml')) return 'rust';
  return 'typescript'; // default
}

/**
 * Render the child project's .env with the per-project identity's INFISICAL_*
 * triplet + project slug. Pure. Plaintext secrets are NEVER written here — they
 * live in vault and are fetched at boot by the dropped vault-fetch helper.
 */
export function renderChildEnv(opts: { clientId: string; clientSecret: string; host: string; projectSlug: string }): string {
  return [
    '# cortextOS-provisioned vault wiring (per-project read identity).',
    '# Secrets are fetched from Infisical at boot by vault-fetch.mjs — NOT stored here.',
    `INFISICAL_HOST=${opts.host}`,
    `INFISICAL_CLIENT_ID=${opts.clientId}`,
    `INFISICAL_CLIENT_SECRET=${opts.clientSecret}`,
    `INFISICAL_PROJECT_SLUG=${opts.projectSlug}`,
    '',
  ].join('\n');
}

/**
 * Strip plaintext secret-looking assignments from an existing .env body, keeping
 * only non-secret config + the INFISICAL_* triplet. Returns the cleaned body.
 * Pure. (The original is preserved by the caller as .env.pre-bootstrap.bak.)
 */
export function stripPlaintextSecrets(envBody: string): string {
  const KEEP_PREFIXES = ['INFISICAL_', 'PORT', 'NODE_ENV', 'CTX_', 'NEXT_PUBLIC_CONVEX_URL', 'CONVEX_DEPLOYMENT', 'VITE_'];
  const out: string[] = [];
  for (const line of envBody.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) { out.push(line); continue; }
    const eq = t.indexOf('=');
    if (eq <= 0) { out.push(line); continue; }
    const key = t.slice(0, eq);
    if (KEEP_PREFIXES.some(p => key.startsWith(p))) { out.push(line); continue; }
    // a secret-looking key — drop the value, leave a breadcrumb
    out.push(`# ${key}= (moved to vault /projects/<name>/; fetched at boot)`);
  }
  return out.join('\n');
}

export function renderClaudeMd(name: string, lang: Lang, convex: boolean, stack?: { dbPort: number; devPort: number } | null): string {
  const backend = convex ? ' + Convex' : stack ? ' + Postgres-stack' : '';
  return `# ${name}

Scaffolded by \`cortextos new-project\` (${lang}${backend}).

## Secrets
Vault-driven via Infisical (\`vault-fetch.mjs\`). Never commit plaintext secrets;
add new ones under \`/projects/${name}/\` in the vault, not to \`.env\`.
${stack ? `
## Stack (Next.js + project-local Postgres + Drizzle + Auth.js)
- **DB:** project-local Postgres in Docker — \`npm run db:up\` (fetches POSTGRES_PASSWORD from vault), host port **${stack.dbPort}**.
- **Migrate:** \`npm run db:generate\` then \`npm run db:migrate\` (vaulted DATABASE_URL).
- **Run:** \`npm run dev\` (port ${stack.devPort}) or \`npm run start\` (boot.mjs → vault → \`next start\`).
- Switching to a central Postgres later = repoint the vaulted \`DATABASE_URL\`; no app-code change.
` : ''}
## Capability payload
ECC ${lang} skills/agents/rules are installed in \`.claude/\` (see MOC.md).
`;
}

/**
 * Read the ECC payload actually installed in <projectDir>/.claude — the
 * ground truth for MOC.md. cherry-pick-ecc.mjs is an external script whose
 * stdout we only echo, so inspect the disk instead of parsing it.
 * Layout: skills/<name>/, agents/<name>.md, rules/<name>/.
 * (M2 e2e FINDING-2: MOC.md rendered "(none)" despite a full install because
 * the renderMoc call site hardcoded empty lists.)
 */
export function readEccPayload(claudeDir: string): { skills: string[]; agents: string[]; rules: string[] } {
  const list = (sub: string, stripExt = false): string[] => {
    try {
      return readdirSync(join(claudeDir, sub))
        .map((f) => (stripExt ? f.replace(/\.md$/, '') : f))
        .sort();
    } catch {
      return []; // subdir absent (e.g. lang with no payload) — render "(none)"
    }
  };
  return { skills: list('skills'), agents: list('agents', true), rules: list('rules') };
}

export function renderMoc(name: string, lang: Lang, copied: { skills: string[]; agents: string[]; rules: string[] }): string {
  return `# ${name} — Map of Content

- **Language:** ${lang}
- **ECC skills:** ${copied.skills.join(', ') || '(none)'}
- **ECC reviewer/build agents:** ${copied.agents.join(', ') || '(none)'}
- **ECC rules:** ${copied.rules.join(', ') || '(none)'}
- **.env:** vault-wired (INFISICAL_* triplet); secrets in vault \`/projects/${name}/\`
`;
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Resolve the framework root (templates/, toolkits/) relative to THIS BUILD's
 * own location — NOT CTX_FRAMEWORK_ROOT or cwd.
 *
 * FINDING-1 (M2 e2e evidence, 2026-06-03): agent shells carry
 * CTX_FRAMEWORK_ROOT=<live checkout>, so a worktree-built CLI run from one
 * rendered templates from the WRONG checkout and crashed pre-provisioning —
 * the same CTX_* env-leak family as the npm-test guard trap. Anchoring on
 * __dirname means each build always uses its own checkout's assets:
 *   bundled dist/cli.js  → __dirname = <checkout>/dist     → one level up
 *   src via tsx/vitest   → __dirname = <checkout>/src/cli  → two levels up
 * The legacy env/cwd lookup survives only as a last resort (e.g. a relocated
 * binary with no templates/ sibling) rather than crashing outright.
 */
export function resolveFrameworkRoot(): string {
  const candidates = [join(__dirname, '..'), join(__dirname, '..', '..')];
  for (const c of candidates) {
    if (existsSync(join(c, 'templates'))) return c;
  }
  return process.env.CTX_FRAMEWORK_ROOT || process.cwd();
}

export const newProjectCommand = new Command('new-project')
  .argument('<name>', 'Project name (kebab-case)')
  .option('--lang <lang>', `Target language (${SUPPORTED_LANGS.join(', ')}); auto-detect if omitted`)
  .option('--framework <fw>', 'Framework (e.g. django)')
  .option('--convex', 'Provision a managed-cloud Convex backend (opt-in alt; replaces the default Postgres stack)', false)
  .option('--no-stack', 'Skip the default Next.js+Postgres+Auth.js stack (bare git+ECC; for non-web TS libs)')
  .option('--remote', 'Create + push a PRIVATE GitHub remote (personal). Default: local-only, no push.', false)
  .option('--dir <path>', 'Parent directory for the project', process.cwd())
  .option('--org <org>', 'Org name', process.env.CTX_ORG || 'sondre-hq')
  .option('--dry-run', 'Scaffold locally but skip vault writes, Convex, and GitHub', false)
  .description('Scaffold a production-ready project with vault provisioning + ECC payload')
  .action(async (name: string, opts: { lang?: string; framework?: string; convex: boolean; stack: boolean; remote: boolean; dir: string; org: string; dryRun: boolean }) => {
    try {
      validateAgentName(name);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    // FINDING-1 fix: dist-anchored, immune to leaked CTX_FRAMEWORK_ROOT/cwd.
    const frameworkRoot = resolveFrameworkRoot();
    const projectDir = resolve(opts.dir, name);
    if (existsSync(projectDir)) {
      console.error(`Error: ${projectDir} already exists.`);
      process.exit(1);
    }
    const lang = resolveLang(opts.lang);
    // Default stack = Next.js + project-local Postgres + Drizzle + Auth.js (decision A).
    // TS-only; --convex swaps in the managed-cloud backend; --no-stack opts out (bare git+ECC).
    const wantStack = lang === 'typescript' && !opts.convex && opts.stack;
    console.log(`[new-project] ${name} (${lang}${opts.framework ? '+' + opts.framework : ''}${opts.convex ? ', convex' : wantStack ? ', postgres-stack' : ''}) -> ${projectDir}`);

    // 1) Scaffold dir + git init (ALWAYS local).
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    const gitInit = run('git', ['init'], projectDir);
    if (!gitInit.ok) { console.error(`Error: git init failed: ${gitInit.out}`); process.exit(1); }

    // 2) ECC capability payload (selective, per-language).
    const eccArgs = ['toolkits/ecc/cherry-pick-ecc.mjs', '--language', lang, '--project-dir', projectDir];
    if (opts.framework) eccArgs.push('--framework', opts.framework);
    const ecc = run('node', eccArgs.map(a => a.startsWith('toolkits/') ? join(frameworkRoot, a) : a), frameworkRoot);
    console.log(ecc.out.trim());

    // 2.5) Default stack: emit the Next.js+Postgres+Drizzle+Auth.js skeleton with
    // per-project collision-free ports (the project-local-Postgres crux).
    let ports: { dbPort: number; devPort: number } | null = null;
    if (wantStack) {
      const { dbPort, devPort } = await allocatePortsAsync(name);
      ports = { dbPort, devPort };
      const tokens: StackTokens = { PROJECT_NAME: name, DB_PORT: String(dbPort), DEV_PORT: String(devPort) };
      const templateDir = join(frameworkRoot, 'templates', 'nextjs-postgres');
      const written = renderStack(templateDir, projectDir, tokens);
      console.log(`[new-project] stack: rendered ${written.length} files (Postgres :${dbPort}, Next dev :${devPort}).`);
    }

    // 3) Convex module copy (+ run later, after vault provision).
    if (opts.convex) {
      for (const f of ['provision-convex.mjs', 'vault-fetch.mjs']) {
        const src = join(frameworkRoot, 'templates', 'convex-provisioning', f);
        if (existsSync(src)) copyFileSync(src, join(projectDir, f));
      }
    } else {
      // non-convex projects still get the canonical vault-fetch helper (carries the blocklist).
      const src = join(frameworkRoot, 'templates', 'convex-provisioning', 'vault-fetch.mjs');
      if (existsSync(src)) copyFileSync(src, join(projectDir, 'vault-fetch.mjs'));
    }

    // 4) Vault provisioning (skipped on --dry-run; needs the provisioner identity).
    if (!opts.dryRun) {
      try {
        await provisionVault({ name, projectDir, org: opts.org, stackPorts: ports });
        if (opts.convex) {
          const r = run('node', [join(projectDir, 'provision-convex.mjs'), '--project-dir', projectDir, '--project', name], projectDir);
          console.log(r.out.trim());
        }
      } catch (err) {
        console.error(`[new-project] vault provisioning failed: ${(err as Error).message}`);
        console.error(`[new-project] (the newproject-provisioner identity must exist — run 'cortextos vault create-provisioner' first.)`);
        process.exit(1);
      }
    } else {
      console.log('[new-project] --dry-run: skeleton emitted; skipping vault provisioning (POSTGRES_PASSWORD/AUTH_SECRET/DATABASE_URL), Convex, GitHub.');
    }

    // 5) Docs.
    writeFileSync(join(projectDir, 'CLAUDE.md'), renderClaudeMd(name, lang, opts.convex, ports));
    writeFileSync(join(projectDir, 'MOC.md'), renderMoc(name, lang, readEccPayload(join(projectDir, '.claude'))));

    // 6) GitHub remote — OPT-IN only.
    if (opts.remote && !opts.dryRun) {
      const gh = run('gh', ['repo', 'create', name, '--private', '--source', '.', '--push'], projectDir);
      console.log(gh.ok ? `[new-project] pushed private GitHub remote '${name}'.` : `[new-project] gh remote skipped: ${gh.out.trim()}`);
    } else {
      console.log('[new-project] local-only (no remote). Pass --remote to create a private GitHub repo.');
    }

    console.log(`[new-project] done: ${projectDir}`);
  });

/**
 * Per-project vault provisioning (plan §2): fetch provisioner creds from
 * /agents/project-bootstrap, mint a per-project read identity, wire the child
 * .env, drop the vault-fetch helper, strip plaintext + keep .bak.
 */
async function provisionVault(args: { name: string; projectDir: string; org: string; stackPorts?: { dbPort: number; devPort: number } | null }): Promise<void> {
  // Provisioner creds live at /agents/project-bootstrap/PROVISIONER_CLIENT_ID|SECRET,
  // readable by PB's runtime identity (which is what's in this process's env).
  const fetched = await fetchInfisicalSecrets(process.env as Record<string, string>, 'project-bootstrap');
  const pid = fetched.values.PROVISIONER_CLIENT_ID;
  const psec = fetched.values.PROVISIONER_CLIENT_SECRET;
  const host = process.env.INFISICAL_HOST || 'http://localhost:8090';
  if (!pid || !psec) {
    throw new Error('PROVISIONER_CLIENT_ID/SECRET not in vault (run `cortextos vault create-provisioner`)');
  }
  const creds: AdminCreds = { host, clientId: pid, clientSecret: psec };
  const session = await openAdminSession(creds);

  // Mint the per-project read-only identity (idempotent).
  const minted = await mintProjectReadIdentity(session, args.name);

  // Establish the /projects/<name>/ folder before writing its secrets, then
  // write a marker (idempotent).
  await ensureFolder(session, '/projects', args.name);
  await upsertSecret(session, `/projects/${args.name}`, 'PROVISIONED_AT', new Date().toISOString().slice(0, 10)).catch(() => {});

  // Default-stack secrets: mint a Postgres password + Auth.js secret + the
  // DATABASE_URL the app/migrate/db-up read at boot. NEVER written to .env —
  // vault-only, fetched by vault-fetch.mjs. DATABASE_URL points at the
  // project-local Postgres on its allocated host port (decision A).
  if (args.stackPorts) {
    const pgPassword = genSecret(24);
    const authSecret = genSecret(32);
    const databaseUrl = `postgres://app:${pgPassword}@localhost:${args.stackPorts.dbPort}/appdb`;
    await upsertSecret(session, `/projects/${args.name}`, 'POSTGRES_PASSWORD', pgPassword);
    await upsertSecret(session, `/projects/${args.name}`, 'AUTH_SECRET', authSecret);
    await upsertSecret(session, `/projects/${args.name}`, 'DATABASE_URL', databaseUrl);
    console.log(`[new-project] vault: minted POSTGRES_PASSWORD + AUTH_SECRET + DATABASE_URL (Postgres :${args.stackPorts.dbPort}).`);
  }

  // Wire the child .env (preserve any existing as .bak, strip plaintext).
  const envPath = join(args.projectDir, '.env');
  if (existsSync(envPath)) {
    renameSync(envPath, `${envPath}.pre-bootstrap.bak`);
    const cleaned = stripPlaintextSecrets(readFileSync(`${envPath}.pre-bootstrap.bak`, 'utf-8'));
    writeFileSync(envPath, cleaned + '\n' + renderChildEnv({ clientId: minted.clientId, clientSecret: minted.clientSecret, host, projectSlug: session.host ? 'sondre-hq-bq-wx' : 'sondre-hq-bq-wx' }));
  } else {
    writeFileSync(envPath, renderChildEnv({ clientId: minted.clientId, clientSecret: minted.clientSecret, host, projectSlug: 'sondre-hq-bq-wx' }));
  }
  console.log(`[new-project] vault: minted read identity for /projects/${args.name}, wired child .env.`);
}
