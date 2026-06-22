/**
 * REGRESSION TESTS for the vault-fetch.mjs CLI arg footgun (P2, 2026-06-03).
 *
 * THE DEFECT: the CLI recognised only `--paths` and silently IGNORED any other
 * arg, so `$(node vault-fetch.mjs GEMINI_API_KEY)` proceeded in dump-everything
 * eval mode and put the full multi-secret export blob into a single env var
 * (a client library then echoed it into logs — local secret exposure).
 *
 * These tests spawn the real CLI with INFISICAL_* unset, so no live vault is
 * needed: every case asserts the SAFETY property that matters — stdout stays
 * EMPTY on every failure path, and exit codes are loud where they must be.
 * (Live single-secret success is environment-dependent and verified manually;
 * see the P2 task record.)
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const CLI = resolve(__dirname, '..', '..', 'dashboard', 'vault-fetch.mjs');
const TEMPLATE_CLI = resolve(__dirname, '..', '..', 'templates', 'convex-provisioning', 'vault-fetch.mjs');

// INFISICAL_* removed → fetch soft-fails with 'INFISICAL_* not set', letting us
// exercise the arg-handling layer deterministically without a vault.
function runCli(file: string, args: string[]) {
  const env = { ...process.env };
  delete env.INFISICAL_HOST; delete env.INFISICAL_CLIENT_ID; delete env.INFISICAL_CLIENT_SECRET;
  return spawnSync('node', [file, ...args], { encoding: 'utf-8', env });
}

describe('vault-fetch.mjs CLI arg handling (P2 footgun regression)', () => {
  it('REGRESSION: a bare KEY arg selects single-secret mode — vault failure is a HARD fail with EMPTY stdout (never the dump)', () => {
    const r = runCli(CLI, ['GEMINI_API_KEY']);
    expect(r.status).toBe(1);            // pre-fix: exit 0 in dump-everything mode
    expect(r.stdout).toBe('');           // the property that prevents the blob
    expect(r.stderr).toContain('FAIL');
  });

  it('unknown flags fail loud: exit 2, usage on stderr, stdout empty', () => {
    const r = runCli(CLI, ['--secret', 'GEMINI_API_KEY']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown option');
    expect(r.stderr).toContain('usage:');
  });

  it('more than one positional key is rejected (exit 2, stdout empty)', () => {
    const r = runCli(CLI, ['GEMINI_API_KEY', 'GITHUB_TOKEN']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('CONTRACT PRESERVED: eval mode (no key) keeps soft-fail exit 0 for boot wrappers', () => {
    const r = runCli(CLI, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('soft-fail');
  });

  it('CONTRACT PRESERVED: --paths eval mode also soft-fails exit 0', () => {
    const r = runCli(CLI, ['--paths', '/shared,/dashboard']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('template copy carries the identical fix (single-key hard fail)', () => {
    const r = runCli(TEMPLATE_CLI, ['GEMINI_API_KEY']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
});
