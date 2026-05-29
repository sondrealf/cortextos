/**
 * cherry-pick-ecc — selective ECC capability-payload installer for /new-project.
 *
 * The project-bootstrap agent calls this BEFORE launching a worker-session build,
 * to equip the scaffolded project's .claude/ with ONLY the ECC skills/agents/rules
 * relevant to its detected language/framework (per ./mapping.json). It does NOT
 * dump the full ECC toolkit — that would bloat the repo and blow the token budget.
 *
 * Design contract:
 *   - Idempotent: copying an already-present item is a no-op (overwrite, logged once).
 *   - Selective: language (+ optional framework) -> mapping.json -> exact item list.
 *   - Precedence guard: a vendored item whose name collides with a cortextOS-native
 *     skill/command (mapping.json `nativePrecedence`) is SKIPPED, never silently
 *     shadowed. (None collide in the current subset; the guard is enforced anyway so
 *     future payload additions can't shadow a native skill.)
 *   - Logs exactly what it copied / skipped.
 *
 * Usage (CLI):
 *   node cherry-pick-ecc.mjs --language typescript --project-dir /path/to/project
 *   node cherry-pick-ecc.mjs --language python --framework django --project-dir <dir>
 *   [--ecc-root <dir>]   # defaults to this file's .claude/ (the vendored subset)
 *   [--dry-run]          # print the plan, copy nothing
 *
 * Programmatic:
 *   import { cherryPickEcc, resolvePlan } from './cherry-pick-ecc.mjs';
 *   const result = cherryPickEcc({ language, framework, projectDir });
 */

import { cpSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ECC_ROOT = join(HERE, '.claude');

function loadMapping() {
  return JSON.parse(readFileSync(join(HERE, 'mapping.json'), 'utf8'));
}

/** Resolve a language token (canonical name or alias) to its canonical key. */
export function canonicalLanguage(mapping, token) {
  const t = String(token || '').toLowerCase();
  if (mapping.languages[t]) return t;
  for (const [key, def] of Object.entries(mapping.languages)) {
    if ((def.aliases || []).includes(t)) return key;
  }
  return null;
}

/** Build the {skills, agents, rules} install plan for a language (+ framework). */
export function resolvePlan({ mapping, language, framework }) {
  const lang = canonicalLanguage(mapping, language);
  if (!lang) {
    throw new Error(`unknown language '${language}'. Known: ${Object.keys(mapping.languages).join(', ')} (+ aliases)`);
  }
  const base = mapping.languages[lang];
  const plan = {
    language: lang,
    skills: [...base.skills],
    agents: [...base.agents],
    rules: [...base.rules],
  };
  if (framework) {
    const fw = mapping.frameworks?.[String(framework).toLowerCase()];
    if (!fw) throw new Error(`unknown framework '${framework}'. Known: ${Object.keys(mapping.frameworks || {}).join(', ') || '(none)'}`);
    if (fw.extends && fw.extends !== lang) {
      throw new Error(`framework '${framework}' extends '${fw.extends}', not the requested language '${lang}'`);
    }
    plan.framework = String(framework).toLowerCase();
    plan.skills.push(...(fw.skills || []));
    plan.agents.push(...(fw.agents || []));
    plan.rules.push(...(fw.rules || []));
  }
  // de-dupe (coding-standards / common appear in multiple lists)
  plan.skills = [...new Set(plan.skills)];
  plan.agents = [...new Set(plan.agents)];
  plan.rules = [...new Set(plan.rules)];
  return plan;
}

export function cherryPickEcc({ language, framework, projectDir, eccRoot = DEFAULT_ECC_ROOT, dryRun = false, log = console.log }) {
  if (!projectDir) throw new Error('projectDir is required');
  const mapping = loadMapping();
  const native = new Set(mapping.nativePrecedence || []);
  const plan = resolvePlan({ mapping, language, framework });

  const destBase = join(projectDir, '.claude');
  const copied = { skills: [], agents: [], rules: [] };
  const skipped = [];

  const doCopy = (kind, name, srcRel, isFile) => {
    if (native.has(name)) {                       // precedence guard
      skipped.push(`${kind}/${name} (cortextOS-native skill wins)`);
      return;
    }
    const src = join(eccRoot, srcRel);
    if (!existsSync(src)) { skipped.push(`${kind}/${name} (not in vendored subset)`); return; }
    const dest = join(destBase, kind, isFile ? `${name}.md` : name);
    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: !isFile });
    }
    copied[kind].push(name);
  };

  for (const s of plan.skills) doCopy('skills', s, join('skills', s), false);
  for (const a of plan.agents) doCopy('agents', a, join('agents', `${a}.md`), true);
  for (const r of plan.rules)  doCopy('rules',  r, join('rules', r), false);

  const tag = dryRun ? '[cherry-pick-ecc DRY-RUN]' : '[cherry-pick-ecc]';
  log(`${tag} ${plan.language}${plan.framework ? '+' + plan.framework : ''} -> ${projectDir}/.claude`);
  log(`${tag}   skills: ${copied.skills.join(', ') || '(none)'}`);
  log(`${tag}   agents: ${copied.agents.join(', ') || '(none)'}`);
  log(`${tag}   rules:  ${copied.rules.join(', ') || '(none)'}`);
  if (skipped.length) log(`${tag}   skipped: ${skipped.join('; ')}`);

  return { plan, copied, skipped, dryRun };
}

// --- CLI entry point (basename compare; bind-mount safe) ---
const argvFile = process.argv[1] ? process.argv[1].split('/').pop() : '';
const isMain = !!argvFile && import.meta.url.endsWith('/' + argvFile);

if (isMain) {
  const argv = process.argv.slice(2);
  const opts = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--language') opts.language = argv[++i];
    else if (a === '--framework') opts.framework = argv[++i];
    else if (a === '--project-dir') opts.projectDir = argv[++i];
    else if (a === '--ecc-root') opts.eccRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
  }
  if (!opts.language || !opts.projectDir) {
    console.error('usage: node cherry-pick-ecc.mjs --language <lang> --project-dir <dir> [--framework <fw>] [--ecc-root <dir>] [--dry-run]');
    process.exit(2);
  }
  try {
    cherryPickEcc(opts);
    process.exit(0);
  } catch (err) {
    console.error(`[cherry-pick-ecc] failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
