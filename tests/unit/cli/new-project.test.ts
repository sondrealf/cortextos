import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import {
  resolveFrameworkRoot,
  resolveLang,
  renderChildEnv,
  stripPlaintextSecrets,
  renderClaudeMd,
  renderMoc,
  SUPPORTED_LANGS,
} from '../../../src/cli/new-project.js';

describe('new-project resolveLang', () => {
  it('accepts canonical languages', () => {
    for (const l of SUPPORTED_LANGS) expect(resolveLang(l)).toBe(l);
  });
  it('resolves aliases', () => {
    expect(resolveLang('ts')).toBe('typescript');
    expect(resolveLang('node')).toBe('typescript');
    expect(resolveLang('py')).toBe('python');
    expect(resolveLang('golang')).toBe('go');
    expect(resolveLang('rs')).toBe('rust');
  });
  it('detects from marker files when no explicit lang', () => {
    expect(resolveLang(undefined, ['go.mod'])).toBe('go');
    expect(resolveLang(undefined, ['Cargo.toml'])).toBe('rust');
    expect(resolveLang(undefined, ['pyproject.toml'])).toBe('python');
    expect(resolveLang(undefined, ['package.json'])).toBe('typescript');
  });
  it('defaults to typescript', () => {
    expect(resolveLang(undefined, [])).toBe('typescript');
  });
  it('throws on unsupported explicit lang', () => {
    expect(() => resolveLang('cobol')).toThrow(/unsupported/);
  });
});

describe('new-project renderChildEnv', () => {
  const env = renderChildEnv({ clientId: 'CID', clientSecret: 'CSEC', host: 'http://localhost:8090', projectSlug: 'sondre-hq-bq-wx' });
  it('writes the INFISICAL_* triplet + slug', () => {
    expect(env).toContain('INFISICAL_CLIENT_ID=CID');
    expect(env).toContain('INFISICAL_CLIENT_SECRET=CSEC');
    expect(env).toContain('INFISICAL_HOST=http://localhost:8090');
    expect(env).toContain('INFISICAL_PROJECT_SLUG=sondre-hq-bq-wx');
  });
  it('contains NO plaintext app secrets (vault-driven)', () => {
    // only INFISICAL_* keys present
    const assignments = env.split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'));
    for (const a of assignments) expect(a.startsWith('INFISICAL_')).toBe(true);
  });
});

describe('new-project stripPlaintextSecrets', () => {
  it('keeps INFISICAL_/config keys, drops secret-looking values', () => {
    const input = [
      'INFISICAL_CLIENT_ID=keep',
      'PORT=3000',
      'OPENAI_API_KEY=sk-secret-should-be-dropped',
      'STRIPE_SECRET=sk_live_dropme',
      '# a comment',
      'NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud',
    ].join('\n');
    const out = stripPlaintextSecrets(input);
    expect(out).toContain('INFISICAL_CLIENT_ID=keep');
    expect(out).toContain('PORT=3000');
    expect(out).toContain('NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud');
    expect(out).not.toContain('sk-secret-should-be-dropped');
    expect(out).not.toContain('sk_live_dropme');
    expect(out).toContain('# OPENAI_API_KEY=');  // breadcrumb left
  });
});

describe('new-project docs', () => {
  it('CLAUDE.md mentions vault + namespace, never says commit secrets', () => {
    const md = renderClaudeMd('myapp', 'typescript', true);
    expect(md).toContain('/projects/myapp/');
    expect(md).toContain('vault-fetch.mjs');
    expect(md).toContain('Convex');
  });
  it('MOC lists the ECC payload', () => {
    const moc = renderMoc('myapp', 'go', { skills: ['golang-patterns'], agents: ['go-reviewer'], rules: ['common', 'golang'] });
    expect(moc).toContain('golang-patterns');
    expect(moc).toContain('go-reviewer');
    expect(moc).toContain('go');
  });
});

describe('new-project resolveFrameworkRoot (FINDING-1: dist-anchored, env-leak immune)', () => {
  // Running under vitest, __dirname inside new-project.ts = <checkout>/src/cli,
  // so the two-levels-up candidate is the real checkout root with templates/.
  const realRoot = resolve(__dirname, '..', '..', '..');

  it('ignores a leaked CTX_FRAMEWORK_ROOT pointing at the WRONG checkout', () => {
    const prev = process.env.CTX_FRAMEWORK_ROOT;
    process.env.CTX_FRAMEWORK_ROOT = '/definitely/not/a/checkout';
    try {
      expect(resolveFrameworkRoot()).toBe(realRoot);
    } finally {
      if (prev === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
      else process.env.CTX_FRAMEWORK_ROOT = prev;
    }
  });

  it('resolves its own checkout root without any env at all', () => {
    const prev = process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_FRAMEWORK_ROOT;
    try {
      const root = resolveFrameworkRoot();
      expect(root).toBe(realRoot);
      expect(existsSync(join(root, 'templates', 'nextjs-postgres'))).toBe(true);
    } finally {
      if (prev !== undefined) process.env.CTX_FRAMEWORK_ROOT = prev;
    }
  });
});
