import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';
import {
  getCatalogDir,
  getInstalledAgents,
  installSkillFiles,
  uninstallSkillFiles,
} from '@/lib/skills-core';

export const dynamic = 'force-dynamic';

function parseSkillMd(content: string): {
  name: string;
  description: string;
  version: string | null;
  source: string | null;
  lastUpdated: string | null;
} {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = '';
  let description = '';
  let version: string | null = null;
  let source: string | null = null;
  let lastUpdated: string | null = null;
  const strip = (s: string) => s.trim().replace(/^["']|["']$/g, '');
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const nm = fm.match(/^name:\s*(.+)$/m);
    const dm = fm.match(/^description:\s*(.+)$/m);
    const vm = fm.match(/^version:\s*(.+)$/m);
    const sm = fm.match(/^source:\s*(.+)$/m);
    const lm = fm.match(/^last_updated:\s*(.+)$/m);
    if (nm) name = strip(nm[1]);
    if (dm) description = strip(dm[1]);
    if (vm) version = strip(vm[1]);
    if (sm) source = strip(sm[1]);
    if (lm) lastUpdated = strip(lm[1]);
  }
  if (!name) {
    const h = content.match(/^#\s+(.+)$/m);
    if (h) name = h[1].trim();
  }
  return {
    name: name || 'Unnamed Skill',
    description: description || '',
    version,
    source,
    lastUpdated,
  };
}

export async function GET() {
  try {
    const frameworkRoot = getFrameworkRoot();
    const catalogDir = getCatalogDir(frameworkRoot);

    if (!fs.existsSync(catalogDir)) {
      return Response.json([]);
    }

    const entries = fs.readdirSync(catalogDir, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const slug = entry.name;
      const skillMd = path.join(catalogDir, slug, 'SKILL.md');
      const readme = path.join(catalogDir, slug, 'README.md');

      let content = '';
      if (fs.existsSync(skillMd)) content = fs.readFileSync(skillMd, 'utf-8');
      else if (fs.existsSync(readme)) content = fs.readFileSync(readme, 'utf-8');

      const { name, description, version, source, lastUpdated } = parseSkillMd(content);
      const installedFor = getInstalledAgents(frameworkRoot, slug);

      skills.push({
        slug,
        name: name || slug,
        description,
        version,
        source,
        lastUpdated,
        installed: installedFor.length > 0,
        installedFor,
      });
    }

    return Response.json(skills.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    console.error('[api/skills] error:', err);
    return Response.json([]);
  }
}

// POST /api/skills - Install a skill to an agent
export async function POST(request: Request) {
  try {
    const { slug, org, agent } = await request.json();
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }

    installSkillFiles(getFrameworkRoot(), slug, org, agent);
    return Response.json({ success: true });
  } catch (err) {
    const msg = String(err).replace(/^Error:\s*/, '');
    const status = msg.includes('Skill not found') ? 404 : 500;
    return Response.json({ error: msg }, { status });
  }
}

// DELETE /api/skills - Uninstall a skill from an agent
export async function DELETE(request: Request) {
  try {
    const { slug, org, agent } = await request.json();
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }

    try {
      uninstallSkillFiles(getFrameworkRoot(), slug, org, agent);
    } catch {
      return Response.json({ error: `Skill not installed: ${slug}` }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
