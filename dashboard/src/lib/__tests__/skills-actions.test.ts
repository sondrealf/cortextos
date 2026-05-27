import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// next/cache's revalidatePath only works inside a request scope — stub it.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// Build a temp framework root + isolated HOME BEFORE config.ts evaluates.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fw-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-home-'));
process.env.CTX_FRAMEWORK_ROOT = tmpRoot;
process.env.CTX_ROOT = tmpRoot;
process.env.HOME = tmpHome;

const CATALOG = path.join(tmpRoot, 'community', 'skills');
const ORG = 'testorg';
const CLAUDE_AGENT = 'claude-bot';
const CODEX_AGENT = 'codex-bot';

function writeSkill(dir: string, slug: string, name: string) {
  fs.mkdirSync(path.join(dir, slug), { recursive: true });
  fs.writeFileSync(
    path.join(dir, slug, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "Does ${name} things."\n---\n\n# ${name}\n`,
  );
}

function agentDir(agent: string) {
  return path.join(tmpRoot, 'orgs', ORG, 'agents', agent);
}

let fetchSkills: typeof import('../actions/skills')['fetchSkills'];
let installSkill: typeof import('../actions/skills')['installSkill'];
let uninstallSkill: typeof import('../actions/skills')['uninstallSkill'];

beforeAll(async () => {
  // Catalog: the "community" set is the source of truth.
  writeSkill(CATALOG, 'alpha', 'Alpha');
  writeSkill(CATALOG, 'beta', 'Beta');
  writeSkill(CATALOG, 'gamma', 'Gamma');
  // A stale top-level skills/ dir that should be ignored entirely (bug 1).
  writeSkill(path.join(tmpRoot, 'skills'), 'stale-only', 'StaleOnly');

  // claude-code agent: loads from .claude/skills
  fs.mkdirSync(path.join(agentDir(CLAUDE_AGENT), '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir(CLAUDE_AGENT), 'config.json'),
    JSON.stringify({ agent_name: CLAUDE_AGENT, runtime: 'claude-code' }),
  );
  // Pre-install alpha so detection has something to find.
  fs.symlinkSync(
    path.join(CATALOG, 'alpha'),
    path.join(agentDir(CLAUDE_AGENT), '.claude', 'skills', 'alpha'),
    'dir',
  );

  // codex-app-server agent: loads from plugins/cortextos-agent-skills/skills
  fs.mkdirSync(
    path.join(agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(agentDir(CODEX_AGENT), 'config.json'),
    JSON.stringify({ agent_name: CODEX_AGENT, runtime: 'codex-app-server' }),
  );
  fs.symlinkSync(
    path.join(CATALOG, 'beta'),
    path.join(agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills', 'beta'),
    'dir',
  );

  const mod = await import('../actions/skills');
  fetchSkills = mod.fetchSkills;
  installSkill = mod.installSkill;
  uninstallSkill = mod.uninstallSkill;
});

describe('skills actions — catalog + per-runtime install/detect', () => {
  it('fetchSkills reads the community catalog, not the stale skills/ dir', async () => {
    const skills = await fetchSkills();
    const slugs = skills.map(s => s.slug);
    expect(slugs).toEqual(['alpha', 'beta', 'gamma']);
    expect(slugs).not.toContain('stale-only');
  });

  it('detects pre-installed skills in both runtimes via the dir each actually loads', async () => {
    const skills = await fetchSkills();
    const alpha = skills.find(s => s.slug === 'alpha')!;
    const beta = skills.find(s => s.slug === 'beta')!;
    // alpha is in claude-bot/.claude/skills, beta is in codex-bot/plugins/...
    expect(alpha.installedFor).toContain(`${ORG}/${CLAUDE_AGENT}`);
    expect(beta.installedFor).toContain(`${ORG}/${CODEX_AGENT}`);
  });

  it('installs into .claude/skills for a claude-code agent', async () => {
    const res = await installSkill('gamma', ORG, CLAUDE_AGENT);
    expect(res.success).toBe(true);
    const link = path.join(agentDir(CLAUDE_AGENT), '.claude', 'skills', 'gamma');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('installs into plugins/ AND the ~/.codex/skills host link for a codex agent', async () => {
    const res = await installSkill('gamma', ORG, CODEX_AGENT);
    expect(res.success).toBe(true);
    const local = path.join(
      agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills', 'gamma',
    );
    const hostLink = path.join(tmpHome, '.codex', 'skills', `${CODEX_AGENT}__gamma`);
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(hostLink).isSymbolicLink()).toBe(true);
  });

  it('uninstall removes the codex host link as well as the local skill', async () => {
    const res = await uninstallSkill('gamma', ORG, CODEX_AGENT);
    expect(res.success).toBe(true);
    const local = path.join(
      agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills', 'gamma',
    );
    const hostLink = path.join(tmpHome, '.codex', 'skills', `${CODEX_AGENT}__gamma`);
    expect(fs.existsSync(local)).toBe(false);
    expect(fs.existsSync(hostLink)).toBe(false);
  });
});
