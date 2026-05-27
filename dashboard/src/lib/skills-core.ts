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

// The real catalog. The old top-level skills/ dir holds a stale 9-skill subset
// that nothing installs from; community/skills is the full set.
export function getCatalogDir(frameworkRoot: string): string {
  return path.join(frameworkRoot, 'community', 'skills');
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
  const catalogDir = path.join(getCatalogDir(frameworkRoot), slug);
  if (!fs.existsSync(catalogDir)) throw new Error(`Skill not found: ${slug}`);

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
