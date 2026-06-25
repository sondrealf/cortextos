/**
 * Provider auto-failover circuit-breaker — shared detection + override-marker helpers.
 *
 * Problem (the "cap-wedge" class): when an agent's upstream LLM provider returns
 * an HTTP 402 (credit exhaustion / context-ceiling) or 5xx, the Claude Code CLI
 * does NOT crash — it sits with a live PID printing the error and produces zero
 * events. The daemon's crash/restart machinery never fires (handleExit only runs
 * on process exit) so the agent silently wedges until a human notices. Restarting
 * is futile because the same oversized boot context hits the same provider cap.
 *
 * This module provides:
 *   1. detectProviderError() — recognises the provider-error signature in PTY output.
 *   2. The `.provider-override.json` marker shape + read/write/clear helpers, which
 *      let the daemon hand a fallback endpoint to the spawn path (agent-pty) across
 *      a force-restart.
 *
 * The circuit-breaker STATE MACHINE (reroute counting, trip/pause) lives in
 * fast-checker.ts next to the proven context-circuit breaker; this module is the
 * pure, side-effect-light core so it can be unit-tested without a daemon.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

/** Filename of the per-agent override marker, written into the agent's state dir. */
export const PROVIDER_OVERRIDE_FILE = '.provider-override.json';
/** Filename of the per-agent circuit-breaker state, written into the agent's state dir. */
export const PROVIDER_CIRCUIT_FILE = '.provider-circuit.json';

export type ProviderErrorKind = '402' | '5xx';

export interface ProviderErrorMatch {
  /** The error class detected. */
  kind: ProviderErrorKind;
  /** The matched substring (for logging / alerting context). */
  signature: string;
}

/**
 * Marker written by the daemon on reroute and read by AgentPty at spawn time.
 * Presence of this file = "this agent is currently rerouted to a fallback provider".
 */
export interface ProviderOverride {
  /** Fallback ANTHROPIC_BASE_URL to overlay. */
  endpoint: string;
  /** Fallback ANTHROPIC_AUTH_TOKEN to overlay. Omit to keep the agent's existing token. */
  token?: string;
  /** Model id to use while rerouted (overrides config.model). Omit to keep config.model. */
  model?: string;
  /** ISO timestamp the reroute was engaged. */
  engagedAt: string;
  /** The provider-error class that triggered the reroute. */
  reason: string;
}

/**
 * Detect an upstream provider error in recent PTY output.
 *
 * Matches ONLY structured, CLI/API-emitted markers to keep false positives low
 * (an agent merely *discussing* errors in prose should not trip this):
 *   - `API Error: 402`   → 402 credit/context-ceiling (this is how the Claude Code
 *                          CLI surfaces upstream HTTP errors; mirrors the existing
 *                          "API Error: 400" image-poison detector)
 *   - `API Error: 5xx`   → upstream 5xx
 *   - `"type":"overloaded_error"` → Anthropic 529 overloaded (treated as 5xx)
 *
 * Returns the first match found, or null.
 */
export function detectProviderError(output: string): ProviderErrorMatch | null {
  if (!output) return null;

  const m402 = output.match(/API Error:\s*402\b/i);
  if (m402) return { kind: '402', signature: m402[0] };

  const m5xx = output.match(/API Error:\s*5\d{2}\b/i);
  if (m5xx) return { kind: '5xx', signature: m5xx[0] };

  const mOverloaded = output.match(/"type":\s*"overloaded_error"/i);
  if (mOverloaded) return { kind: '5xx', signature: mOverloaded[0] };

  return null;
}

/** Path to the override marker for an agent's state dir. */
export function providerOverridePath(stateDir: string): string {
  return join(stateDir, PROVIDER_OVERRIDE_FILE);
}

/** Read the override marker, or null if absent/unparseable. */
export function readProviderOverride(stateDir: string): ProviderOverride | null {
  const p = providerOverridePath(stateDir);
  try {
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    if (data && typeof data.endpoint === 'string' && data.endpoint.length > 0) {
      return data as ProviderOverride;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write (engage) the override marker. */
export function writeProviderOverride(stateDir: string, override: ProviderOverride): void {
  writeFileSync(providerOverridePath(stateDir), JSON.stringify(override, null, 2), 'utf-8');
}

/** Clear (disengage) the override marker. No-op if absent. */
export function clearProviderOverride(stateDir: string): void {
  const p = providerOverridePath(stateDir);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* non-fatal */
  }
}
