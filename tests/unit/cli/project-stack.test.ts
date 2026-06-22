import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import {
  hashToPort,
  allocatePort,
  allocatePorts,
  substituteTokens,
  renderStack,
  genSecret,
  DB_PORT_RANGE,
  DEV_PORT_RANGE,
} from '../../../src/cli/project-stack.js';

const TEMPLATE_DIR = join(__dirname, '../../../templates/nextjs-postgres');

describe('hashToPort', () => {
  it('is deterministic and in-range', () => {
    for (const seed of ['a', 'my-app:db', 'zzz', 'project-bootstrap:dev']) {
      const p1 = hashToPort(seed, DB_PORT_RANGE);
      const p2 = hashToPort(seed, DB_PORT_RANGE);
      expect(p1).toBe(p2);
      expect(p1).toBeGreaterThanOrEqual(DB_PORT_RANGE.min);
      expect(p1).toBeLessThanOrEqual(DB_PORT_RANGE.max);
    }
  });
  it('different seeds usually map to different ports', () => {
    const ports = new Set(['a', 'b', 'c', 'd', 'e'].map(s => hashToPort(s, DEV_PORT_RANGE)));
    expect(ports.size).toBeGreaterThan(1);
  });
});

describe('allocatePort', () => {
  it('returns the deterministic candidate when free', () => {
    const cand = hashToPort('foo:db', DB_PORT_RANGE);
    expect(allocatePort('foo:db', DB_PORT_RANGE, () => false)).toBe(cand);
  });
  it('skips taken ports and walks the range', () => {
    const cand = hashToPort('foo:db', DB_PORT_RANGE);
    const got = allocatePort('foo:db', DB_PORT_RANGE, (p) => p === cand);
    expect(got).not.toBe(cand);
    expect(got).toBeGreaterThanOrEqual(DB_PORT_RANGE.min);
    expect(got).toBeLessThanOrEqual(DB_PORT_RANGE.max);
  });
  it('throws an ACTIONABLE error on full range', () => {
    expect(() => allocatePort('foo:db', DB_PORT_RANGE, () => true))
      .toThrow(/port-exhaustion.*5433-5933.*widen/is);
  });
});

describe('allocatePorts', () => {
  it('allocates a db and dev port that never collide with each other', () => {
    const { dbPort, devPort } = allocatePorts('my-app', () => false);
    expect(dbPort).toBeGreaterThanOrEqual(DB_PORT_RANGE.min);
    expect(dbPort).toBeLessThanOrEqual(DB_PORT_RANGE.max);
    expect(devPort).toBeGreaterThanOrEqual(DEV_PORT_RANGE.min);
    expect(devPort).toBeLessThanOrEqual(DEV_PORT_RANGE.max);
    expect(dbPort).not.toBe(devPort); // ranges disjoint anyway, but assert
  });
  it('avoids externally-taken ports', () => {
    const taken = new Set([hashToPort('x:db', DB_PORT_RANGE)]);
    const { dbPort } = allocatePorts('x', (p) => taken.has(p));
    expect(taken.has(dbPort)).toBe(false);
  });
});

describe('substituteTokens', () => {
  it('replaces every token', () => {
    const out = substituteTokens(
      'name=__CTX_PROJECT_NAME__ db=__CTX_DB_PORT__ dev=__CTX_DEV_PORT__ again=__CTX_PROJECT_NAME__',
      { PROJECT_NAME: 'my-app', DB_PORT: '5500', DEV_PORT: '4200' },
    );
    expect(out).toBe('name=my-app db=5500 dev=4200 again=my-app');
    expect(out).not.toContain('__CTX_');
  });
});

describe('genSecret', () => {
  it('produces distinct hex secrets', () => {
    const a = genSecret();
    const b = genSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('renderStack (real template tree)', () => {
  it('renders the nextjs-postgres template with no leftover tokens or M1 residue', () => {
    expect(existsSync(TEMPLATE_DIR)).toBe(true);
    const projectDir = mkdtempSync(join(tmpdir(), 'm2-stack-'));
    const written = renderStack(TEMPLATE_DIR, projectDir, { PROJECT_NAME: 'my-app', DB_PORT: '5500', DEV_PORT: '4200' });

    // gitignore -> .gitignore rename
    expect(written).toContain('.gitignore');
    expect(written).not.toContain('gitignore');
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(true);

    // key files present
    for (const f of ['package.json', 'docker-compose.yml', 'boot.mjs', 'migrate.mjs', 'db-up.mjs',
                     'drizzle.config.ts', 'src/auth.ts', 'src/db/schema.ts', 'src/app/page.tsx',
                     'src/app/api/auth/[...nextauth]/route.ts', 'drizzle/0000_init.sql']) {
      expect(existsSync(join(projectDir, f)), `missing ${f}`).toBe(true);
    }

    // substitution applied
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('my-app');
    expect(pkg.scripts.dev).toContain('4200');
    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('container_name: my-app-db');
    expect(compose).toContain('"5500:5432"');

    // NO leftover tokens, NO M1 residue anywhere in the rendered tree
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
      const abs = join(dir, e);
      return statSync(abs).isDirectory() ? walk(abs) : [abs];
    });
    for (const file of walk(projectDir)) {
      const body = readFileSync(file, 'utf-8');
      expect(body, `__CTX_ token leftover in ${relative(projectDir, file)}`).not.toContain('__CTX_');
      expect(body, `M1 residue in ${relative(projectDir, file)}`).not.toContain('nextjs-test-0530');
    }

    // journal tag matches the renamed migration file
    const journal = JSON.parse(readFileSync(join(projectDir, 'drizzle/meta/_journal.json'), 'utf-8'));
    expect(journal.entries[0].tag).toBe('0000_init');
  });
});
