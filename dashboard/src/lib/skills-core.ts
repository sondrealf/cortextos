// Shared skill install/detection logic — the single source of truth for BOTH
// the server actions (actions/skills.ts) and the REST route (api/skills/route.ts).
// These used to be two parallel implementations that drifted (the route kept
// reading a stale catalog + a dir no runtime loads); keep all path/runtime
// logic here so that can't happen again.
//
// NOTE: this is a plain module, NOT a 'use server' file, so it can export the
// sync helpers that a 'use server' module is forbidden from exporting.
import fs from 'fs';
import os from 'os';
import path from 'path';

// An agent's runtime, read from its config.json (defaults to claude-code).
export function getAgentRuntime(agentDir: string): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, 'config.json'), 'utf-8'));
    return typeof cfg.runtime === 'string' && cfg.runtime ? cfg.runtime : 'claude-code';
  } catch {
    return 'claude-code';
  }
}

// The directory the agent's runtime actually scans for skills at boot.
//   - claude-code:      .claude/skills/<slug>
//   - codex-app-server: plugins/cortextos-agent-skills/skills/<slug>
//                       (plus a ~/.codex/skills/<agent>__<slug> host symlink)
export function getAgentSkillsDir(agentDir: string): string {
  if (getAgentRuntime(agentDir) === 'codex-app-server') {
    return path.join(agentDir, 'plugins', 'cortextos-agent-skills', 'skills');
  }
  return path.join(agentDir, '.claude', 'skills');
}

// Codex agents are discovered host-wide via ~/.codex/skills/<agent>__<slug>
// symlinks (see add-agent.ts installCodexSkillSymlinks).
export function codexHostSkillLink(agent: string, slug: string): string {
  return path.join(os.homedir(), '.codex', 'skills', `${agent}__${slug}`);
}

// Skills come from two catalogs, surfaced as two categories:
//   - internal ("Agent skills"):  community/skills — agent-ops skills
//     (heartbeat, onboarding, tasks, …). The full default set.
//   - external ("Power skills"):  <frameworkRoot>/skills — power skills
//     (ui-ux-pro-max, web-research, mcp-integration, …).
// A few slugs (comms, cron-management, tasks) live in both; they resolve to
// internal (community is canonical). Listed internal-first so that wins.
export type SkillCategory = 'internal' | 'external';

export interface CatalogEntry {
  slug: string;
  category: SkillCategory;
  dir: string; // absolute path to the skill's source dir
}

function catalogSources(frameworkRoot: string): Array<{ category: SkillCategory; dir: string }> {
  return [
    { category: 'internal', dir: path.join(frameworkRoot, 'community', 'skills') },
    { category: 'external', dir: path.join(frameworkRoot, 'skills') },
  ];
}

// Union of both catalogs, deduped by slug (internal wins on overlap).
export function listCatalog(frameworkRoot: string): CatalogEntry[] {
  const bySlug = new Map<string, CatalogEntry>();
  for (const src of catalogSources(frameworkRoot)) {
    if (!fs.existsSync(src.dir)) continue;
    for (const e of fs.readdirSync(src.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (!bySlug.has(e.name)) {
        bySlug.set(e.name, { slug: e.name, category: src.category, dir: path.join(src.dir, e.name) });
      }
    }
  }
  return Array.from(bySlug.values());
}

// Resolve a single slug to its canonical source dir + category (internal-first),
// so install reads from the right catalog. Returns null if absent from both.
export function resolveCatalogSkill(frameworkRoot: string, slug: string): CatalogEntry | null {
  for (const src of catalogSources(frameworkRoot)) {
    const dir = path.join(src.dir, slug);
    if (fs.existsSync(dir)) return { slug, category: src.category, dir };
  }
  return null;
}

// "org/agent" entries where <slug> is installed, checked against the dir each
// agent's runtime actually loads from.
export function getInstalledAgents(frameworkRoot: string, slug: string): string[] {
  const installed: string[] = [];
  const orgsDir = path.join(frameworkRoot, 'orgs');
  if (!fs.existsSync(orgsDir)) return installed;

  for (const orgEntry of fs.readdirSync(orgsDir, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    const agentsDir = path.join(orgsDir, orgEntry.name, 'agents');
    if (!fs.existsSync(agentsDir)) continue;

    for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const agentDir = path.join(agentsDir, agentEntry.name);
      if (fs.existsSync(path.join(getAgentSkillsDir(agentDir), slug))) {
        installed.push(`${orgEntry.name}/${agentEntry.name}`);
      }
    }
  }
  return installed;
}

// Install <slug> into the dir the agent's runtime loads, plus the codex host
// symlink when applicable. Throws if the catalog skill does not exist.
export function installSkillFiles(
  frameworkRoot: string, slug: string, org: string, agent: string,
): void {
  // Source from the slug's own catalog (external skills come from skills/,
  // internal from community/skills), not a single hardcoded dir.
  const entry = resolveCatalogSkill(frameworkRoot, slug);
  if (!entry) throw new Error(`Skill not found: ${slug}`);
  const catalogDir = entry.dir;

  const agentDir = path.join(frameworkRoot, 'orgs', org, 'agents', agent);
  const skillsDir = getAgentSkillsDir(agentDir);
  fs.mkdirSync(skillsDir, { recursive: true });

  const linkPath = path.join(skillsDir, slug);
  try {
    if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath);
  } catch {
    // Doesn't exist, fine
  }
  fs.symlinkSync(catalogDir, linkPath, 'dir');

  if (getAgentRuntime(agentDir) === 'codex-app-server') {
    const hostLink = codexHostSkillLink(agent, slug);
    fs.mkdirSync(path.dirname(hostLink), { recursive: true });
    try {
      if (fs.lstatSync(hostLink).isSymbolicLink()) fs.unlinkSync(hostLink);
    } catch {
      // Doesn't exist, fine
    }
    fs.symlinkSync(linkPath, hostLink, 'dir');
  }
}

// Remove <slug> from the agent's runtime skills dir, plus the codex host
// symlink. Throws if it was not installed (caller maps to a 404 / error).
export function uninstallSkillFiles(
  frameworkRoot: string, slug: string, org: string, agent: string,
): void {
  const agentDir = path.join(frameworkRoot, 'orgs', org, 'agents', agent);
  const linkPath = path.join(getAgentSkillsDir(agentDir), slug);

  const stat = fs.lstatSync(linkPath); // throws if not present
  if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
  else if (stat.isDirectory()) fs.rmSync(linkPath, { recursive: true });

  if (getAgentRuntime(agentDir) === 'codex-app-server') {
    const hostLink = codexHostSkillLink(agent, slug);
    try {
      if (fs.lstatSync(hostLink).isSymbolicLink()) fs.unlinkSync(hostLink);
    } catch {
      // Already gone, fine
    }
  }
}
