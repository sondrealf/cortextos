/**
 * REGRESSION TESTS: kb-query/kb-ingest loud-fail on missing GEMINI_API_KEY
 * (P2 follow-up, 2026-06-03 — the quiet-failure family).
 *
 * THE DEFECT: mmrag.py needs GEMINI_API_KEY for embeddings; without it the
 * python call failed inside runQuery's bare catch and kb-query printed
 * "No results found" — indistinguishable from a legitimately-empty KB.
 * kb-ingest similarly proceeded into a doomed python call.
 *
 * The preflight runs BEFORE the kbConfigured check precisely so these tests
 * (and CI boxes with no ~/.cortextos state) exercise it deterministically:
 * a missing key fails identically regardless of KB config state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { queryKnowledgeBase, ingestKnowledgeBase } from '../../src/bus/knowledge-base';
import { resolvePaths } from '../../src/utils/paths';

// frameworkRoot = empty tmp dir → no .env / orgs/<org>/secrets.env can leak a
// key into buildKBEnv; the only remaining source is process.env, stripped below.
let tmpRoot: string;
let savedKey: string | undefined;
let savedExit: number | string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-loud-'));
  savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  savedExit = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  process.exitCode = savedExit;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const OPTS = { org: 'no-such-org', frameworkRoot: '', instanceId: 'kb-loud-test' };

describe('kb missing GEMINI_API_KEY → loud fail (quiet-failure family regression)', () => {
  it('query: returns empty AND sets exitCode=1 AND names the key on stderr (not a silent "no results")', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = queryKnowledgeBase(
      resolvePaths('test-agent', 'kb-loud-test', 'no-such-org'),
      'anything',
      { ...OPTS, frameworkRoot: tmpRoot },
    );
    expect(res.results).toHaveLength(0);
    expect(process.exitCode).toBe(1);                       // loud for the CLI
    const msg = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(msg).toContain('GEMINI_API_KEY');
    expect(msg).toContain('FAILURE');                       // explicitly not-an-empty-result
    expect(msg).toContain('vault-fetch.mjs GEMINI_API_KEY'); // the recovery incantation
  });

  it('ingest: returns early with exitCode=1 + stderr, never reaching the python call', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => ingestKnowledgeBase(['/tmp/nope.md'], { ...OPTS, frameworkRoot: tmpRoot })).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('GEMINI_API_KEY');
  });

  it('key present → preflight passes through to the next check (no key error, no exitCode)', () => {
    process.env.GEMINI_API_KEY = 'AIzaSyTEST-not-a-real-key';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = queryKnowledgeBase(
      resolvePaths('test-agent', 'kb-loud-test', 'no-such-org'),
      'anything',
      { ...OPTS, frameworkRoot: tmpRoot },
    );
    // Falls through to the unconfigured-KB warn-and-empty path — NOT the key error.
    expect(res.results).toHaveLength(0);
    expect(process.exitCode).not.toBe(1);
    expect(errSpy.mock.calls.map(c => c.join(' ')).join('\n')).not.toContain('GEMINI_API_KEY');
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('not configured');
  });
});
