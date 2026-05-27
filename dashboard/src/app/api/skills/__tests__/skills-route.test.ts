import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Temp framework root + isolated HOME BEFORE config.ts evaluates.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-route-fw-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-route-home-'));
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
    `---\nname: ${name}\ndescription: "Does ${name}."\n---\n\n# ${name}\n`,
  );
}

function agentDir(agent: string) {
  return path.join(tmpRoot, 'orgs', ORG, 'agents', agent);
}

function req(body: unknown) {
  return new Request('http://localhost/api/skills', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

let GET: typeof import('../route')['GET'];
let POST: typeof import('../route')['POST'];
let DELETE: typeof import('../route')['DELETE'];

beforeAll(async () => {
  writeSkill(CATALOG, 'alpha', 'Alpha');
  writeSkill(CATALOG, 'beta', 'Beta');
  // Stale top-level skills/ dir that the route must NOT read.
  writeSkill(path.join(tmpRoot, 'skills'), 'stale-only', 'StaleOnly');

  fs.mkdirSync(path.join(agentDir(CLAUDE_AGENT), '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir(CLAUDE_AGENT), 'config.json'),
    JSON.stringify({ agent_name: CLAUDE_AGENT, runtime: 'claude-code' }),
  );
  fs.symlinkSync(
    path.join(CATALOG, 'alpha'),
    path.join(agentDir(CLAUDE_AGENT), '.claude', 'skills', 'alpha'),
    'dir',
  );

  fs.mkdirSync(
    path.join(agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(agentDir(CODEX_AGENT), 'config.json'),
    JSON.stringify({ agent_name: CODEX_AGENT, runtime: 'codex-app-server' }),
  );

  const mod = await import('../route');
  GET = mod.GET;
  POST = mod.POST;
  DELETE = mod.DELETE;
});

describe('GET/POST/DELETE /api/skills — the path the page actually uses', () => {
  it('GET reads community/skills (not stale skills/) with per-runtime detection', async () => {
    const res = await GET();
    const skills = await res.json();
    const slugs = skills.map((s: { slug: string }) => s.slug);
    expect(slugs).toEqual(['alpha', 'beta']);
    expect(slugs).not.toContain('stale-only');
    const alpha = skills.find((s: { slug: string }) => s.slug === 'alpha');
    expect(alpha.installedFor).toContain(`${ORG}/${CLAUDE_AGENT}`);
  });

  it('POST installs into plugins/ + ~/.codex/skills host link for a codex agent', async () => {
    const res = await POST(req({ slug: 'beta', org: ORG, agent: CODEX_AGENT }));
    expect((await res.json()).success).toBe(true);
    const local = path.join(
      agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills', 'beta',
    );
    const hostLink = path.join(tmpHome, '.codex', 'skills', `${CODEX_AGENT}__beta`);
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(hostLink).isSymbolicLink()).toBe(true);
  });

  it('POST 404s for an unknown skill', async () => {
    const res = await POST(req({ slug: 'nope', org: ORG, agent: CLAUDE_AGENT }));
    expect(res.status).toBe(404);
  });

  it('DELETE removes the codex local + host link', async () => {
    const res = await DELETE(req({ slug: 'beta', org: ORG, agent: CODEX_AGENT }));
    expect((await res.json()).success).toBe(true);
    const local = path.join(
      agentDir(CODEX_AGENT), 'plugins', 'cortextos-agent-skills', 'skills', 'beta',
    );
    const hostLink = path.join(tmpHome, '.codex', 'skills', `${CODEX_AGENT}__beta`);
    expect(fs.existsSync(local)).toBe(false);
    expect(fs.existsSync(hostLink)).toBe(false);
  });
});
