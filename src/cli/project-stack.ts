/**
 * Default-stack scaffolding for `cortextos new-project` (decision A:
 * project-local Dockerized Postgres + Drizzle + Auth.js, per project).
 *
 * The CLI emits the proven Next.js-fullstack stack (extracted from the M1
 * reference into templates/nextjs-postgres/) with per-project substitutions.
 * The one thing M1 did NOT solve — several scaffolded projects coexisting on
 * one host — is handled here by allocating a collision-free Postgres host port
 * and Next dev port per project.
 *
 * Everything except the FS walk is pure + unit-tested.
 */

import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { createServer } from 'net';
import { randomBytes } from 'crypto';

/** Inclusive host-port ranges, per resource. Widen here if exhausted. */
export const DB_PORT_RANGE = { min: 5433, max: 5933 } as const;
export const DEV_PORT_RANGE = { min: 4100, max: 4600 } as const;

export interface PortRange { readonly min: number; readonly max: number; }
export interface StackTokens { PROJECT_NAME: string; DB_PORT: string; DEV_PORT: string; }

/**
 * Deterministic seed → a starting port inside [min, max]. Same name always maps
 * to the same candidate, so re-scaffolding is stable; the probe below skips it
 * if taken. Pure (FNV-1a, no randomness).
 */
export function hashToPort(seed: string, range: PortRange): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const span = range.max - range.min + 1;
  return range.min + (h % span);
}

/**
 * Allocate a free port for `seed`: start at the deterministic candidate and
 * walk the range until `isTaken` returns false. Throws an ACTIONABLE error
 * naming the full range + how to widen if every port is in use. Pure given
 * `isTaken`.
 */
export function allocatePort(seed: string, range: PortRange, isTaken: (port: number) => boolean): number {
  const span = range.max - range.min + 1;
  const start = hashToPort(seed, range);
  for (let i = 0; i < span; i++) {
    const port = range.min + (((start - range.min) + i) % span);
    if (!isTaken(port)) return port;
  }
  throw new Error(
    `port-exhaustion: all ${span} ports in range ${range.min}-${range.max} are in use ` +
    `(allocating for '${seed}'). Free a port, or widen the range in ` +
    `src/cli/project-stack.ts (DB_PORT_RANGE / DEV_PORT_RANGE) and re-run.`,
  );
}

/** Allocate both per-project ports. `isTaken` is injected for testability. */
export function allocatePorts(name: string, isTaken: (port: number) => boolean): { dbPort: number; devPort: number } {
  const taken = new Set<number>();
  const guard = (p: number) => taken.has(p) || isTaken(p);
  const dbPort = allocatePort(`${name}:db`, DB_PORT_RANGE, guard);
  taken.add(dbPort);
  const devPort = allocatePort(`${name}:dev`, DEV_PORT_RANGE, guard);
  return { dbPort, devPort };
}

/** Replace __CTX_PROJECT_NAME__ / __CTX_DB_PORT__ / __CTX_DEV_PORT__. Pure. */
export function substituteTokens(content: string, tokens: StackTokens): string {
  return content.replace(/__CTX_(PROJECT_NAME|DB_PORT|DEV_PORT)__/g, (_m, key: keyof StackTokens) => tokens[key]);
}

/** Probe whether a TCP port on 0.0.0.0 is already bound. Best-effort (a short listen). */
export function isPortTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '0.0.0.0');
  });
}

/**
 * Async port allocation: same deterministic walk as allocatePort, but awaits an
 * async probe (real TCP listen) per candidate. Throws the same actionable error.
 */
export async function allocatePortAsync(
  seed: string,
  range: PortRange,
  taken: (port: number) => Promise<boolean>,
): Promise<number> {
  const span = range.max - range.min + 1;
  const start = hashToPort(seed, range);
  for (let i = 0; i < span; i++) {
    const port = range.min + (((start - range.min) + i) % span);
    if (!(await taken(port))) return port;
  }
  throw new Error(
    `port-exhaustion: all ${span} ports in range ${range.min}-${range.max} are in use ` +
    `(allocating for '${seed}'). Free a port, or widen the range in ` +
    `src/cli/project-stack.ts (DB_PORT_RANGE / DEV_PORT_RANGE) and re-run.`,
  );
}

/** Allocate both per-project ports against the live host (real TCP probe). */
export async function allocatePortsAsync(name: string): Promise<{ dbPort: number; devPort: number }> {
  const reserved = new Set<number>();
  const probe = async (p: number) => reserved.has(p) || (await isPortTaken(p));
  const dbPort = await allocatePortAsync(`${name}:db`, DB_PORT_RANGE, probe);
  reserved.add(dbPort);
  const devPort = await allocatePortAsync(`${name}:dev`, DEV_PORT_RANGE, probe);
  return { dbPort, devPort };
}

/** Generate a URL-safe random secret (hex). */
export function genSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Recursively copy the template tree into projectDir, substituting tokens in
 * every file. The template file named `gitignore` is written as `.gitignore`.
 * Returns the project-relative paths written.
 */
export function renderStack(templateDir: string, projectDir: string, tokens: StackTokens): string[] {
  const written: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      const rel = relative(templateDir, abs);
      const destRel = rel === 'gitignore' ? '.gitignore' : rel;
      const dest = join(projectDir, destRel);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, substituteTokens(readFileSync(abs, 'utf-8'), tokens));
      written.push(destRel);
    }
  };
  walk(templateDir);
  return written;
}
