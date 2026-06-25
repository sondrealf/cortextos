import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectProviderError,
  readProviderOverride,
  writeProviderOverride,
  clearProviderOverride,
  providerOverridePath,
  PROVIDER_OVERRIDE_FILE,
  PROVIDER_CIRCUIT_FILE,
} from '../../../src/utils/provider-failover';

describe('provider-failover: detectProviderError', () => {
  it('detects an upstream 402 from the CLI error format', () => {
    const out = 'some scrollback\n⎿  API Error: 402 {"error":{"message":"insufficient credits"}}\n';
    const m = detectProviderError(out);
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('402');
    expect(m!.signature).toMatch(/402/);
  });

  it('detects upstream 5xx errors', () => {
    expect(detectProviderError('API Error: 503 upstream down')!.kind).toBe('5xx');
    expect(detectProviderError('API Error: 500')!.kind).toBe('5xx');
    expect(detectProviderError('API Error: 529 overloaded')!.kind).toBe('5xx');
  });

  it('treats Anthropic overloaded_error as 5xx', () => {
    const m = detectProviderError('{"type":"overloaded_error","message":"Overloaded"}');
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('5xx');
  });

  it('returns null for healthy / unrelated output', () => {
    expect(detectProviderError('')).toBeNull();
    expect(detectProviderError('Heartbeat 00:00 UTC — healthy, fleet 7/7')).toBeNull();
    // A 200/normal response must not match
    expect(detectProviderError('HTTP 200 OK, request id abc402def')).toBeNull();
  });

  it('does not match prose mentioning a 402 without the API Error prefix', () => {
    // Anti-false-positive: an agent discussing "error 402" in chat should not trip.
    expect(detectProviderError('I once saw an error 402 while testing the API')).toBeNull();
    expect(detectProviderError('the status code 402 means payment required')).toBeNull();
  });

  it('does not match 4xx codes that are not 402 (e.g. 400 image poison handled elsewhere)', () => {
    expect(detectProviderError('API Error: 400 image.source.base64')).toBeNull();
    expect(detectProviderError('API Error: 404 not found')).toBeNull();
    expect(detectProviderError('API Error: 429 rate limit')).toBeNull();
  });
});

describe('provider-failover: override marker lifecycle', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'provider-failover-test-'));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('round-trips an override marker', () => {
    expect(readProviderOverride(stateDir)).toBeNull();
    writeProviderOverride(stateDir, {
      endpoint: 'https://fallback.example/v1',
      token: 'sk-fallback',
      model: 'claude-opus-4-8',
      engagedAt: '2026-06-25T04:00:00Z',
      reason: '402 API Error: 402',
    });
    expect(existsSync(providerOverridePath(stateDir))).toBe(true);
    const ov = readProviderOverride(stateDir);
    expect(ov).not.toBeNull();
    expect(ov!.endpoint).toBe('https://fallback.example/v1');
    expect(ov!.token).toBe('sk-fallback');
    expect(ov!.model).toBe('claude-opus-4-8');
  });

  it('clearProviderOverride removes the marker and is a no-op when absent', () => {
    writeProviderOverride(stateDir, {
      endpoint: 'https://fallback.example/v1',
      engagedAt: '2026-06-25T04:00:00Z',
      reason: '5xx',
    });
    clearProviderOverride(stateDir);
    expect(existsSync(providerOverridePath(stateDir))).toBe(false);
    // idempotent
    expect(() => clearProviderOverride(stateDir)).not.toThrow();
    expect(readProviderOverride(stateDir)).toBeNull();
  });

  it('reads endpoint without a token (reuse-existing-token mode)', () => {
    writeProviderOverride(stateDir, {
      endpoint: 'https://fallback.example/v1',
      engagedAt: '2026-06-25T04:00:00Z',
      reason: '402',
    });
    const ov = readProviderOverride(stateDir)!;
    expect(ov.token).toBeUndefined();
    expect(ov.model).toBeUndefined();
  });

  it('returns null for a malformed / empty-endpoint marker rather than throwing', () => {
    writeFileSync(providerOverridePath(stateDir), '{ not valid json', 'utf-8');
    expect(readProviderOverride(stateDir)).toBeNull();
    writeFileSync(providerOverridePath(stateDir), JSON.stringify({ endpoint: '' }), 'utf-8');
    expect(readProviderOverride(stateDir)).toBeNull();
  });

  it('exposes stable filenames for daemon/spawn coordination', () => {
    expect(PROVIDER_OVERRIDE_FILE).toBe('.provider-override.json');
    expect(PROVIDER_CIRCUIT_FILE).toBe('.provider-circuit.json');
  });
});
