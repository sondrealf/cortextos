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

const INTERNAL = path.join(tmpRoot, 'community', 'skills'); // "Agent skills"
const EXTERNAL = path.join(tmpRoot, 'skills');               // "Power skills"
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
  // Internal catalog (community/skills)
  writeSkill(INTERNAL, 'alpha', 'Alpha');
  writeSkill(INTERNAL, 'beta', 'Beta');
  writeSkill(INTERNAL, 'gamma', 'Gamma');
  writeSkill(INTERNAL, 'dup', 'Dup-Internal'); // overlaps external; internal wins
  // External catalog (frameworkRoot/skills)
  writeSkill(EXTERNAL, 'power', 'Power');
  writeSkill(EXTERNAL, 'dup', 'Dup-External'); // overlap — should NOT win

  // claude-code agent: loads from .claude/skills
  fs.mkdirSync(path.join(agentDir(CLAUDE_AGENT), '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir(CLAUDE_AGENT), 'config.json'),
    JSON.stringify({ agent_name: CLAUDE_AGENT, runtime: 'claude-code' }),
  );
  fs.symlinkSync(
    path.join(INTERNAL, 'alpha'),
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
    path.join(INTERNAL, 'beta'),
    path.join(agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills', 'beta'),
    'dir',
  );

  const mod = await import('../actions/skills');
  fetchSkills = mod.fetchSkills;
  installSkill = mod.installSkill;
  uninstallSkill = mod.uninstallSkill;
});

describe('skills actions — dual catalog, categories, per-runtime install/detect', () => {
  it('unions both catalogs and tags category; overlap resolves to internal', async () => {
    const skills = await fetchSkills();
    const slugs = skills.map(s => s.slug);
    // alpha, beta, dup, gamma (internal) + power (external), deduped & sorted
    expect(slugs).toEqual(['alpha', 'beta', 'dup', 'gamma', 'power']);

    const cat = (slug: string) => skills.find(s => s.slug === slug)!.category;
    expect(cat('alpha')).toBe('internal');
    expect(cat('power')).toBe('external');
    expect(cat('dup')).toBe('internal'); // community wins over frameworkRoot/skills
  });

  it('detects pre-installed skills in both runtimes via the dir each actually loads', async () => {
    const skills = await fetchSkills();
    expect(skills.find(s => s.slug === 'alpha')!.installedFor).toContain(`${ORG}/${CLAUDE_AGENT}`);
    expect(skills.find(s => s.slug === 'beta')!.installedFor).toContain(`${ORG}/${CODEX_AGENT}`);
  });

  it('installs an external (Power) skill sourced from frameworkRoot/skills', async () => {
    const res = await installSkill('power', ORG, CLAUDE_AGENT);
    expect(res.success).toBe(true);
    const link = path.join(agentDir(CLAUDE_AGENT), '.claude', 'skills', 'power');
    // The symlink target must be the EXTERNAL catalog, not community/skills.
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(EXTERNAL, 'power')));
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
