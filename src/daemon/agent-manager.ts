import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { spawn as spawnChild } from 'child_process';
import type { AgentConfig, AgentStatus, CtxEnv, BusPaths, WorkerStatus, TelegramMessage } from '../types/index.js';
import { AgentProcess } from './agent-process.js';
import { WorkerProcess } from './worker-process.js';
import { FastChecker } from './fast-checker.js';
import { CronScheduler } from './cron-scheduler.js';
import { migrateCronsForAgent } from './cron-migration.js';
import { appendExecutionLog } from './cron-execution-log.js';
import type { CronDefinition } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';
import { TelegramPoller } from '../telegram/poller.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { fetchInfisicalSecrets } from '../utils/infisical-fetch.js';
import { VAULT_OVERLAY_BLOCKLIST } from '../utils/vault-overlay-blocklist.js';
import { recordInboundTelegram, cacheLastSent, logOutboundMessage, buildRecentHistory } from '../telegram/logging.js';
import { collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { stripControlChars } from '../utils/validate.js';
import { processMediaMessage } from '../telegram/media.js';
import { logEvent } from '../bus/event.js';
import { VaultBootObserver, type VaultBootAlert } from './vault-boot-observer.js';
import {
  persistOutboundTokenCache,
  readOutboundTokenCache,
  invalidateOutboundTokenCache,
} from '../utils/outbound-token-cache.js';

type LogFn = (msg: string) => void;

/**
 * Manages all agents in a cortextOS instance.
 */
export class AgentManager {
  private agents: Map<string, { process: AgentProcess; checker: FastChecker; poller?: TelegramPoller; activityPoller?: TelegramPoller }> = new Map();
  private workers: Map<string, WorkerProcess> = new Map();
  /** Daemon-level cron scheduler registry: one CronScheduler per enabled agent. */
  private cronSchedulers: Map<string, CronScheduler> = new Map();
  /** Daily restart timer handles, keyed by agent name. */
  private dailyRestartTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // BUG-011 follow-up: per-agent op chain. Every public start/stop/restart
  // enqueues onto this Promise so concurrent IPC dispatches for the same
  // agent run strictly in order. Closes the window where a fire-and-forget
  // start could arrive during another op's PTY-exit await and see the agent
  // still in the registry. The legacy `pendingRestarts` Set + BUG-011
  // REGRESSION CHECK warn lines are removed: with serialization the race
  // cannot happen.
  private opQueues: Map<string, Promise<unknown>> = new Map();
  // Kind of the most recently ENQUEUED (not necessarily running) op per
  // agent, cleared when the chain drains. Lets inspectAgentOp() classify a
  // request against the registry state the chain will LEAVE BEHIND rather
  // than the live registry — a start arriving during an in-flight stop is a
  // legitimate chained respawn, not a duplicate (2026-06-03 free-mode
  // incident: `cortextos stop && cortextos start` returned DEDUPED for the
  // start while the daemon went on to run it anyway).
  private pendingOps: Map<string, 'start' | 'stop' | 'restart'> = new Map();
  private instanceId: string;
  private ctxRoot: string;
  private frameworkRoot: string;
  private org: string;
  /** Vault degraded-boot detectors (A persistent-tokenless + B spawn watchdog). */
  private vaultBootObserver: VaultBootObserver;
  /** Commander's resolved Telegram creds, captured when its poller starts — alerts route here. */
  private commanderTgCreds?: { botToken: string; chatId: string };
  private vaultTickHandle?: ReturnType<typeof setInterval>;
  /** Period of the detector evaluation tick. Injectable for tests. */
  private vaultTickIntervalMs: number;
  /** Count of times the tick was ACTUALLY created (not no-op'd by the idempotency guard). */
  private vaultTickArmCount = 0;
  /**
   * Agents whose poller is currently running on a CACHED BOT_TOKEN
   * (vault-dark boot, last-known-good overlay engaged). Used to annotate
   * detector alerts — the cache restores outbound capability, it must never
   * make a degraded boot look healthy. Cleared on a healthy fetch.
   */
  private outboundCacheEngaged: Set<string> = new Set();

  constructor(
    instanceId: string,
    ctxRoot: string,
    frameworkRoot: string,
    org: string,
    // Test seams for the vault degraded-boot detectors. Production passes none →
    // 30s tick, real Date.now clock, alerts route only to commander.
    opts?: {
      vaultTickIntervalMs?: number;
      vaultClock?: () => number;
      onVaultAlert?: (alert: VaultBootAlert) => void;
    },
  ) {
    this.instanceId = instanceId;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
    this.org = org;
    this.vaultTickIntervalMs = opts?.vaultTickIntervalMs ?? 30_000;
    const onVaultAlert = opts?.onVaultAlert;
    this.vaultBootObserver = new VaultBootObserver(
      (alert) => { this.emitVaultBootAlert(alert); onVaultAlert?.(alert); },
      opts?.vaultClock, // undefined → observer's own Date.now default
    );
    // FIX (obs-detector inert-tick defect, 2026-06-02): arm the evaluating tick
    // at CONSTRUCTION, not only in discoverAndStart(). The 16:47Z continue-mode
    // bounce brought agents up without discoverAndStart, so the tick was never
    // started and Detectors A+B were silently inert (degradedSince stamped but
    // never evaluated). Arming here makes it path-independent: every daemon
    // process that constructs an AgentManager has a live tick, regardless of
    // whether agents come up via discover, continue/re-attach, or daily-restart.
    this.startVaultBootTick();
  }

  /** True iff the detector evaluation tick is armed. Exposed for the wiring test. */
  isVaultTickArmed(): boolean {
    return !!this.vaultTickHandle;
  }

  /**
   * Feed Detector A with an agent's poller vault-fetch result AND ensure the
   * evaluating tick is armed. Arming here (idempotent) keeps the evaluator
   * INSEPARABLE from the feed: the inert-tick defect — where the feed ran on the
   * continue-mode path but the tick (armed only in discoverAndStart) did not —
   * cannot recur, because wherever a result is recorded the evaluator is live.
   */
  recordAgentVaultFetch(name: string, ok: boolean): void {
    this.startVaultBootTick();
    this.vaultBootObserver.recordPollerVaultFetch(name, ok);
  }

  /**
   * Feed Detector B's spawn-initiated mark — the production FastChecker
   * onSpawnInitiated callback routes through here, and the direct-B integration
   * test calls it as its seam. FEED-ONLY by design (no tick arming): B's live
   * evaluation must rely on the constructor-armed tick, which is exactly what
   * the direct-B test proves — a seam that armed the tick itself would let that
   * test stay green with the constructor arming neutralized.
   */
  noteAgentSpawnInitiated(name: string): void {
    this.vaultBootObserver.noteSpawnInitiated(name);
  }

  /** Detector B heal — spawn reached "Bootstrap complete" (mirrors onBootstrapComplete). */
  noteAgentBootstrapComplete(name: string): void {
    this.vaultBootObserver.noteBootstrapComplete(name);
  }

  /**
   * Poller-env vault overlay + last-known-good outbound cache-fallback.
   * Extracted from _startAgentImpl as a named method so the integration test
   * exercises the IDENTICAL path production uses (same philosophy as the
   * detector feed seams above — no seam drift). Mutates `envMap` in place.
   *
   * Healthy fetch: vault values overlay .env (minus blocklist), BOT_TOKEN is
   * persisted to the per-agent cache, any prior cache-engaged flag clears.
   * Failed fetch: .env values stand; if .env supplied no BOT_TOKEN, the
   * last-known-good cached token is overlaid for the OUTBOUND path so the
   * agent boots functional-degraded instead of dark.
   *
   * INVARIANT (cache-fallback spec): recordAgentVaultFetch fires with the
   * RAW fetch result either way — the cache restores outbound capability,
   * never the appearance of health. Detector A still stamps degradedSince.
   */
  async resolvePollerVaultOverlay(name: string, envMap: Record<string, string>, log: LogFn): Promise<void> {
    const result = await fetchInfisicalSecrets(envMap, name);
    if (result.ok) {
      let count = 0;
      for (const [k, v] of Object.entries(result.values)) {
        if (VAULT_OVERLAY_BLOCKLIST.has(k)) continue;
        envMap[k] = v;
        count++;
      }
      log(`[infisical] poller env: loaded ${count} secret(s) from vault`);
      // Fresh vault values always win — the cache is read ONLY on ok:false.
      persistOutboundTokenCache(this.ctxRoot, name, result.values, log);
      this.outboundCacheEngaged.delete(name);
    } else if (result.reason && result.reason !== 'INFISICAL_* not set') {
      log(`[infisical] poller env: vault fetch skipped (${result.reason}); falling back to .env`);
    }
    // Detector A: feed the poller-start vault-fetch result (healthy clears,
    // degraded stamps; the observer tick alerts on sustained degradation).
    // recordAgentVaultFetch also (idempotently) arms the tick, keeping the
    // evaluator inseparable from the feed.
    this.recordAgentVaultFetch(name, result.ok);

    // Cache-fallback: vault-dark boot (fetch failed) and .env supplied no
    // BOT_TOKEN → overlay the last-known-good token so the agent boots
    // functional-degraded instead of DARK and the detectors' own Telegram
    // alert leg keeps working during the exact outage class it detects.
    if (!result.ok && !envMap.BOT_TOKEN?.trim()) {
      const cached = readOutboundTokenCache(this.ctxRoot, name, process.env, log);
      if (cached) {
        envMap.BOT_TOKEN = cached.value;
        this.outboundCacheEngaged.add(name);
        const ageH = Math.round((cached.ageMs / 3_600_000) * 10) / 10;
        log(`[infisical] outbound cache-fallback engaged for ${name} (cached ${ageH}h ago)`);
      }
    }
  }

  /** Test seam: is the agent currently running on a cached outbound token? */
  isOutboundCacheEngagedForTest(name: string): boolean {
    return this.outboundCacheEngaged.has(name);
  }

  /**
   * Route a vault degraded-boot alert TO COMMANDER (not Sondre): a durable
   * error event (always) + a best-effort Telegram to commander (skipped if
   * commander's own creds aren't resolved — e.g. the same vault outage).
   */
  private emitVaultBootAlert(alert: VaultBootAlert): void {
    try {
      const paths = resolvePaths(alert.agent, this.instanceId, this.org);
      logEvent(paths, alert.agent, this.org, 'error', `vault_${alert.detector}`, 'error', alert.detail);
    } catch { /* logging must never throw into the detector */ }
    const creds = this.commanderTgCreds;
    if (creds?.botToken && creds?.chatId) {
      // Invariant (cache-fallback spec): when the agent's outbound survived a
      // vault-dark boot via the last-known-good cache, the alert must SAY so —
      // the cache restores capability, never the appearance of health.
      const cacheNote = this.outboundCacheEngaged.has(alert.agent)
        ? '\n(outbound running on cached BOT_TOKEN — cache-fallback engaged)'
        : '';
      const msg = `🔐 vault degraded-boot [${alert.detector}] — agent ${alert.agent}\n${alert.detail}${cacheNote}`;
      // Fire-and-forget (detached, non-blocking): emitVaultBootAlert runs inside
      // the tick, and a fleet-wide outage crosses T for all agents at once. A
      // blocking spawnSync would stall the daemon event loop ~N×timeout — the
      // detector's own alert path jamming during the exact outage it detects.
      // logEvent above is the guaranteed signal; the Telegram is best-effort.
      try {
        const child = spawnChild('curl', [
          '-s', '--max-time', '3', '-X', 'POST',
          `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
          '-d', `chat_id=${creds.chatId}`,
          '--data-urlencode', `text=${msg}`,
        ], { detached: true, stdio: 'ignore' });
        child.on('error', () => { /* best-effort — never surface into the tick */ });
        child.unref();
      } catch { /* best-effort */ }
    }
  }

  /** Start the periodic detector tick (idempotent). Unref'd so it never holds the process open. */
  private startVaultBootTick(): void {
    if (this.vaultTickHandle) return; // idempotent: exactly one tick, no matter how many starts call this
    this.vaultTickHandle = setInterval(() => {
      try { this.vaultBootObserver.tick(); } catch { /* never throw from the tick */ }
    }, this.vaultTickIntervalMs);
    this.vaultTickHandle.unref?.();
    this.vaultTickArmCount++;
  }

  /** Count of times the tick was ACTUALLY created (not no-op'd by the guard). Exposed for the idempotency test. */
  vaultTickArmCountForTest(): number {
    return this.vaultTickArmCount;
  }

  /** Stop the detector tick (test cleanup so the interval doesn't outlive the test). */
  clearVaultBootTickForTest(): void {
    if (this.vaultTickHandle) {
      clearInterval(this.vaultTickHandle);
      this.vaultTickHandle = undefined;
    }
  }

  /**
   * Discover and start all enabled agents.
   */
  async discoverAndStart(): Promise<void> {
    this.startVaultBootTick();
    const agentDirs = this.discoverAgents();

    // BUG-028: read instance-level enabled-agents.json so the daemon respects
    // the user's explicit enable/disable choices written by the CLI
    // (`cortextos enable`/`disable`) and the dashboard. Without this read, those
    // commands have no effect across daemon restarts — the daemon would
    // re-discover and re-start any agent dir on disk regardless of user intent.
    const instanceEnabled = this.readInstanceEnableList();

    for (const { name, dir, org, config } of agentDirs) {
      // Per-agent config.json `enabled: false` (existing behavior, unchanged)
      if (config.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (per-agent config.json)`);
        continue;
      }
      // Instance-level enabled-agents.json `enabled: false` (BUG-028 fix)
      const entry = instanceEnabled[name];
      if (entry && entry.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (enabled-agents.json)`);
        continue;
      }
      // BUG-043 fix: pass the per-agent org so startAgent can use it instead
      // of falling back to `this.org` (the daemon's startup org).
      await this.startAgent(name, dir, config, org);
    }
  }

  /**
   * Read the instance-level enabled-agents.json registry.
   * Returns an empty object if the file is missing or unreadable —
   * agents not present in the file default to enabled, matching the existing
   * default-on behavior of `discoverAndStart`.
   */
  private readInstanceEnableList(): Record<string, { enabled?: boolean; org?: string; status?: string }> {
    const enabledFile = join(this.ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) return {};
    try {
      return JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      return {}; // corrupt or unreadable — fall through to default-enabled
    }
  }

  /**
   * BUG-043 fix: resolve the canonical org for a given agent without
   * defaulting to the daemon's startup `this.org`.
   *
   * Resolution order:
   *   1. Explicit `org` argument (e.g. from `discoverAgents()` which knows
   *      which org a dir lives under)
   *   2. `enabled-agents.json[name].org` — set by `cortextos enable`/`add-agent`
   *   3. Filesystem scan: walk `frameworkRoot/orgs/*` looking for a dir
   *      named `name` — handles legacy enabled-agents.json entries that
   *      were written before the `org` field was added
   *   4. Legacy fallback: `this.org` (preserves single-org install behavior)
   *
   * Before this fix, all six `this.org` sites in `agent-manager.ts` would
   * short-circuit to the daemon's startup `CTX_ORG`, which silently broke
   * multi-org installs — agents in `lifeos` or `cointally` were invisible
   * to a daemon started with `CTX_ORG=testorg`.
   */
  private resolveAgentOrg(name: string, explicitOrg?: string): string {
    if (explicitOrg) return explicitOrg;

    const enabledAgents = this.readInstanceEnableList();
    const entry = enabledAgents[name];
    if (entry?.org) return entry.org;

    // Legacy fallback: scan all orgs on disk for a dir named `name`.
    // Handles enabled-agents.json entries missing the `org` field, or
    // agents that were created via raw filesystem operations.
    const orgsBase = join(this.frameworkRoot, 'orgs');
    if (existsSync(orgsBase)) {
      try {
        const orgs = readdirSync(orgsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const org of orgs) {
          if (existsSync(join(orgsBase, org, 'agents', name))) {
            return org;
          }
        }
      } catch { /* ignore read errors */ }
    }

    // Ultimate fallback: daemon's startup org (single-org install behavior)
    return this.org;
  }

  /**
   * Start a specific agent.
   *
   * BUG-043 fix: accepts an optional `org` parameter and uses
   * `resolveAgentOrg()` to find the correct org for path/env lookups
   * instead of falling back to `this.org`. This makes the daemon
   * multi-org aware — an install with lifeos + cointally + testorg will
   * spawn each agent in its correct org dir regardless of what
   * `CTX_ORG` the daemon was started with.
   */
  /**
   * Enqueue a lifecycle op onto the per-agent serialization chain.
   *
   * Guarantees that start/stop/restart for the same agent run strictly in
   * order, even when callers dispatch fire-and-forget (the IPC server does
   * this for every start/stop/restart request — see ipc-server.ts). Without
   * serialization, a concurrent start arriving during a stop's PTY-exit await
   * would see the agent still in the registry and either dedup-drop or hit
   * the legacy pendingRestarts queue. With serialization, the start simply
   * waits for the stop's full teardown, then runs against an empty registry.
   *
   * The chain is per-agent so unrelated agents don't block each other. We
   * .catch(() => undefined) on the prior link so a failed op doesn't poison
   * subsequent ops on the same chain. Cleanup: when the latest op settles AND
   * no newer op has been chained on top, we drop the Map entry so long-lived
   * daemons don't accumulate resolved-Promise entries for every agent ever
   * touched.
   */
  private serialize<T>(name: string, kind: 'start' | 'stop' | 'restart', op: () => Promise<T>): Promise<T> {
    const prev = this.opQueues.get(name) ?? Promise.resolve();
    const queuedAt = Date.now();
    this.pendingOps.set(name, kind);
    const next = prev.catch(() => undefined).then(() => {
      // Observability for stalled chains: if an op sat behind a slow sibling
      // (e.g. a stop awaiting a hung PTY exit), say so — "agent took N min to
      // respawn" reports are undiagnosable without this line.
      const waitMs = Date.now() - queuedAt;
      if (waitMs > 1_000) {
        console.log(`[agent-manager] ${kind} for "${name}" dequeued after ${Math.round(waitMs / 100) / 10}s queue wait`);
      }
      return op();
    });
    this.opQueues.set(name, next);
    next.catch(() => undefined).finally(() => {
      if (this.opQueues.get(name) === next) {
        this.opQueues.delete(name);
        this.pendingOps.delete(name);
      }
    });
    return next;
  }

  /**
   * Synchronously classify a start/stop/restart request before dispatch.
   *
   * Lets the IPC handler distinguish DEDUPED (the request collapses against
   * the predicted end-state of the op chain) from NOT_FOUND (agent never
   * existed in the registry). The dedup logic in startAgent / stopAgent /
   * restartAgent is unchanged — this read-only check exists purely to give
   * the IPC layer enough info to set IPCResponse.code. See issue #346.
   *
   * Classification is against the registry state the in-flight chain will
   * LEAVE BEHIND, not the live registry. A start arriving while a stop is
   * mid-teardown (registry entry not yet deleted) is a chained respawn the
   * daemon WILL run — classifying it DEDUPED told the operator the opposite
   * of what happened (2026-06-03 free-mode stop→start incident).
   */
  inspectAgentOp(op: 'start' | 'stop' | 'restart', name: string): { ok: true } | { ok: false; code: 'DEDUPED' | 'NOT_FOUND'; message: string } {
    const pending = this.pendingOps.get(name);
    // Predicted registry state once the chain drains: a pending op's
    // end-state supersedes the live registry read.
    const willBeRunning = pending ? pending !== 'stop' : this.agents.has(name);
    if (op === 'start') {
      if (willBeRunning) {
        return {
          ok: false,
          code: 'DEDUPED',
          message: pending
            ? `start request for "${name}" deduped — ${pending} already in flight leaves the agent running`
            : `start request for "${name}" deduped — agent already running`,
        };
      }
      return { ok: true }; // includes start-during-in-flight-stop: chains after teardown
    }
    // stop / restart need the agent to (still) be present once the chain drains
    if (!willBeRunning) {
      if (pending === 'stop') {
        return { ok: false, code: 'DEDUPED', message: `${op} request for "${name}" deduped — stop already in flight` };
      }
      return { ok: false, code: 'NOT_FOUND', message: `agent "${name}" not in registry — cannot ${op}` };
    }
    return { ok: true };
  }

  /**
   * Start an agent. Public entry point; serializes onto the per-agent op
   * chain so concurrent dispatches from IPC (which fires-and-forgets) cannot
   * race a sibling stop/restart for the same agent. See {@link serialize}.
   */
  async startAgent(name: string, agentDir: string, config?: AgentConfig, org?: string): Promise<void> {
    return this.serialize(name, 'start', () => this._startAgentImpl(name, agentDir, config, org));
  }

  private async _startAgentImpl(name: string, agentDir: string, config?: AgentConfig, org?: string): Promise<void> {
    // Arm the evaluating tick on EVERY agent-start path (idempotent). Co-located
    // with the feed so the inert-tick defect cannot recur: any path that starts
    // a poller (discover, IPC start, restart, auto-restart, continue/re-attach)
    // guarantees a live evaluator.
    this.startVaultBootTick();
    if (this.agents.has(name)) {
      // Already running. Under per-agent serialization any prior stop has
      // fully torn down (and deleted the registry entry) before we land here,
      // so this branch only fires for genuine duplicate-start requests
      // (e.g. `cortextos start foo` invoked twice in a row). No-op silently.
      console.log(`[agent-manager] ${name} already running — start request ignored`);
      return;
    }

    // BUG-043 fix: resolve the agent's true org instead of using `this.org`.
    const resolvedOrg = this.resolveAgentOrg(name, org);

    // Auto-discover agent directory if not provided (e.g. when started via IPC)
    if (!agentDir || !existsSync(agentDir)) {
      const discovered = join(this.frameworkRoot, 'orgs', resolvedOrg, 'agents', name);
      if (existsSync(discovered)) {
        agentDir = discovered;
      } else {
        console.error(`[agent-manager] Agent directory not found for ${name}: tried ${discovered}`);
        return;
      }
    }

    if (!config) {
      config = this.loadAgentConfig(agentDir);
    }

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir,
      org: resolvedOrg,
      projectRoot: this.frameworkRoot,
    };

    const paths = resolvePaths(name, this.instanceId, resolvedOrg);

    const log = (msg: string) => {
      console.log(`[${name}] ${msg}`);
    };

    // Read agent .env for Telegram credentials + Infisical creds.
    //
    // Phase 5: the daemon's Telegram poller starts BEFORE the agent PTY
    // process is spawned, which means it cannot rely on agent-pty.ts's
    // vault overlay — it must do its own vault fetch here. We parse all
    // INFISICAL_* keys from .env, call fetchInfisicalSecrets() with the
    // agent name to read /shared + /agents/<name>, then overlay vault
    // values (BOT_TOKEN, etc.) on top of whatever .env supplied. Soft
    // fallback: any fetch failure → keep .env values.
    const agentEnvFile = join(agentDir, '.env');
    let telegramApi: TelegramAPI | undefined;
    let chatId: string | undefined;
    let allowedUserId: string | undefined;
    let botToken: string | undefined;
    const envMap: Record<string, string> = {};

    if (existsSync(agentEnvFile)) {
      const envContent = readFileSync(agentEnvFile, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          envMap[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }

    // Vault overlay: vault values overwrite .env values for the same key,
    // matching the agent-pty.ts policy. Skip silently if INFISICAL_* are
    // not configured for this agent (legitimate pre-migration state).
    // VAULT_OVERLAY_BLOCKLIST keys are .env-only — never overlay them.
    if (envMap.INFISICAL_CLIENT_ID && envMap.INFISICAL_CLIENT_SECRET) {
      await this.resolvePollerVaultOverlay(name, envMap, log);
    }

    if (Object.keys(envMap).length > 0) {
      botToken = envMap.BOT_TOKEN?.trim() || undefined;
      chatId = envMap.CHAT_ID?.trim() || undefined;
      allowedUserId = envMap.ALLOWED_USER?.trim() || undefined;

      // Validate BOT_TOKEN format: must be numeric_id:alphanumeric_secret
      if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        log(`WARNING: BOT_TOKEN format invalid (expected: 123456:ABC...). Telegram will not start.`);
        botToken = undefined;
      }

      // ALLOWED_USER must be a numeric Telegram user ID, not a username
      if (allowedUserId && !/^\d+$/.test(allowedUserId)) {
        log(`SECURITY: ALLOWED_USER is not a numeric ID. Telegram user IDs are numbers (e.g. 123456789). Refusing to enable Telegram. Fix the .env file.`);
        allowedUserId = undefined;
      }

      // Security: ALLOWED_USER is REQUIRED when BOT_TOKEN is set. Without it,
      // ANY Telegram user who finds the bot @handle could control the agent.
      // Fail closed: refuse to start Telegram unless the operator explicitly
      // whitelists their numeric user ID.
      if (botToken && !allowedUserId) {
        log(`SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing. Refusing to enable Telegram. Set ALLOWED_USER to your numeric Telegram user ID in .env, or remove BOT_TOKEN to start the agent without Telegram.`);
        botToken = undefined;
      }

      if (botToken && chatId) {
        telegramApi = new TelegramAPI(botToken);
        // Don't log sensitive user IDs — just indicate the gate is enabled
        log(`Telegram configured (chat_id: ****${String(chatId).slice(-4)}, allowed_user: enabled)`);
        // Capture commander's resolved creds so vault degraded-boot alerts can
        // Telegram commander directly (best-effort; durable signal is logEvent).
        if (name === 'commander') this.commanderTgCreds = { botToken, chatId };

        // Defunct-cache invalidation: when the poller is running on a CACHED
        // token, probe it once (getMe via validateCredentials, bounded 10s).
        // A 401 means the token was rotated since it was cached — delete the
        // entry so it cannot retry forever. Fire-and-forget: network errors
        // and rate limits leave the cache alone (the token may still be good).
        if (this.outboundCacheEngaged.has(name)) {
          telegramApi.validateCredentials(chatId).then((v) => {
            if (!v.ok && v.reason === 'bad_token') {
              invalidateOutboundTokenCache(this.ctxRoot, name);
              this.outboundCacheEngaged.delete(name);
              log(`[infisical] cached BOT_TOKEN for ${name} rejected by Telegram (401) — cache invalidated`);
            }
          }).catch(() => { /* best-effort probe — never block agent start */ });
        }
      }
    }

    const agentProcess = new AgentProcess(name, env, config, log);
    // Issue #330: pass the Telegram handle into AgentProcess so CodexAppServerPTY
    // can emit sendChatAction directly from the JSONL stream. Has no effect for
    // claude-code / hermes runtimes — those still use fast-checker.
    if (telegramApi && chatId) {
      agentProcess.setTelegramHandle(telegramApi, chatId);
    }
    const checker = new FastChecker(agentProcess, paths, this.frameworkRoot, {
      log,
      telegramApi,
      chatId,
      allowedUserId: allowedUserId ? parseInt(allowedUserId, 10) : undefined,
      // Detector B: spawn-completion watchdog. The observer tick alerts if a
      // spawn doesn't reach "Bootstrap complete" within the watchdog window.
      // Routed through the named methods so the direct-B integration test
      // exercises the IDENTICAL feed path production uses (no seam drift).
      onSpawnInitiated: () => this.noteAgentSpawnInitiated(name),
      onBootstrapComplete: () => this.noteAgentBootstrapComplete(name),
    });

    // Send Telegram notification on crashes and session refreshes
    if (telegramApi && chatId) {
      const tgApi = telegramApi;
      const tgChatId = chatId;
      let prevStatus: string | null = null;
      agentProcess.onStatusChanged((status) => {
        if (status.status === 'crashed') {
          const crashNum = status.crashCount ?? '?';
          tgApi.sendMessage(tgChatId, `Agent ${name} crashed (crash #${crashNum}) — auto-restarting`).catch(() => {});
        } else if (status.status === 'halted') {
          tgApi.sendMessage(tgChatId, `Agent ${name} HALTED — exceeded crash limit. Restart manually with: cortextos start ${name}`).catch(() => {});
        } else if (status.status === 'running' && prevStatus === 'crashed') {
          tgApi.sendMessage(tgChatId, `Agent ${name} recovered and is back online`).catch(() => {});
        }
        prevStatus = status.status;
      });
    }

    this.agents.set(name, { process: agentProcess, checker });

    // Start agent
    await agentProcess.start();

    // Subtask 2.2: Auto-migrate crons from config.json → crons.json before
    // starting the scheduler, so the scheduler always has a populated crons.json
    // to read from.  The migration is idempotent (marker file prevents re-runs).
    const configJsonPath = join(agentDir, 'config.json');
    migrateCronsForAgent(name, configJsonPath, this.ctxRoot, {
      log: (msg) => log(`[migration] ${msg}`),
    });

    // Wire daemon-level CronScheduler for this agent.
    // The scheduler reads crons.json, fires crons, and injects prompts into
    // the agent PTY via injectAgent().  This is the Phase 2 daemon-managed
    // external cron system — agents no longer need to call CronCreate on boot.
    this.startAgentCronScheduler(name);

    // Wire daily session-rotation timer if configured.
    this.scheduleDailyRestart(name);

    // Start fast checker in background
    checker.start().catch(err => {
      console.error(`[${name}] Fast checker error:`, err);
    });

    // Register Telegram slash commands at startup (fix for issue #1)
    if (telegramApi && botToken) {
      const scanDirs = [agentDir, this.frameworkRoot].filter(Boolean);
      const commands = collectTelegramCommands(scanDirs);
      registerTelegramCommands(botToken, commands).then((result) => {
        if (result.status === 'ok') {
          log(`Telegram commands registered (${result.count} commands)`);
        }
      }).catch(() => { /* non-fatal */ });
    }

    // Start Telegram poller if credentials are available and not explicitly disabled.
    // Set telegram_polling: false in config.json to prevent a specialist agent from
    // running its own poller (only the designated orchestrator agent should poll).
    if (telegramApi && chatId && config.telegram_polling !== false) {
      const stateDir = join(this.ctxRoot, 'state', name);
      const poller = new TelegramPoller(telegramApi, stateDir);

      poller.onMessage((msg) => {
        // ALLOWED_USER gate: if configured, ignore messages from other users.
        // Use numeric comparison to avoid string coercion issues.
        if (allowedUserId) {
          const allowedId = parseInt(allowedUserId, 10);
          if (msg.from?.id !== allowedId) {
            log(`Ignoring message from unauthorized user (allowed_user gate)`);
            return;
          }
        }

        const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
        const msgChatId = msg.chat?.id;
        const effectiveChatId = msgChatId ?? chatId ?? '';
        const stateDir = join(this.ctxRoot, 'state', name);

        // Persist the inbound message to JSONL AND emit a
        // `message/telegram_received` bus event in one helper so
        // experiment cycles and dashboards can count inbound traffic.
        // Without the event, Rubi's v3 fleet measurement found 0
        // inbound messages on a window where Eros replied to multiple
        // agents — the JSONL had the data but it never reached the
        // event log.
        recordInboundTelegram(paths, this.ctxRoot, name, resolvedOrg, from, msg, log);

        // Check for media messages (photo, document, voice, audio, video, video_note)
        const isMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);

        if (isMedia && telegramApi) {
          const downloadDir = join(agentDir, 'telegram-images');
          processMediaMessage(msg, telegramApi, downloadDir).then((media) => {
            if (!media) {
              log('Media processing returned null - falling back to text format');
              const text = stripControlChars(msg.caption || '');
              const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot);
              if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
              return;
            }

            // BUG-046: Convert absolute paths to relative (from agent working dir).
            // Claude Code strips absolute paths from pasted user input, so the
            // agent never sees them. Relative paths survive injection.
            // BUG-049: Use the agent's actual launch cwd (config.working_directory
            // if set, else agentDir) so the path resolves when Read() is invoked.
            const launchDir = config?.working_directory || agentDir;
            const toRel = (p: string | undefined) => p ? relative(launchDir, p) : '';
            const relImagePath = toRel(media.image_path);
            const relFilePath = toRel(media.file_path);

            log(`[DEBUG] media.type=${media.type} image_path=${JSON.stringify(relImagePath)} file_path=${JSON.stringify(relFilePath)}`);
            let formatted: string;
            if (media.type === 'photo') {
              formatted = FastChecker.formatTelegramPhotoMessage(from, effectiveChatId, media.text, relImagePath);
            } else if (media.type === 'document') {
              formatted = FastChecker.formatTelegramDocumentMessage(from, effectiveChatId, media.text, relFilePath, media.file_name!);
            } else if (media.type === 'voice' || media.type === 'audio') {
              formatted = FastChecker.formatTelegramVoiceMessage(from, effectiveChatId, relFilePath, media.duration, media.transcript);
            } else {
              // video or video_note
              formatted = FastChecker.formatTelegramVideoMessage(from, effectiveChatId, media.text, relFilePath, media.file_name || '', media.duration);
            }

            if (checker.isDuplicate(formatted)) {
              log('Duplicate Telegram media message suppressed');
              return;
            }
            log(`Media message received: type=${media.type}, path=${media.image_path || media.file_path}`);
            checker.queueTelegramMessage(formatted);
          }).catch((err) => {
            log(`Media processing error: ${err} - falling back to text format`);
            const text = stripControlChars(msg.caption || '');
            const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot);
            if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
          });
          return;
        }

        // Text message (non-media)
        const text = stripControlChars(msg.text || '');
        const lastSent = FastChecker.readLastSent(stateDir, effectiveChatId);
        // Build reply context from the replied-to message.
        const replyToText = buildReplyContext(msg.reply_to_message);

        const recentHistory = buildRecentHistory(this.ctxRoot, name, effectiveChatId, 6) ?? undefined;
        const formatted = FastChecker.formatTelegramTextMessage(
          from,
          effectiveChatId,
          text,
          this.frameworkRoot,
          replyToText,
          lastSent ?? undefined,
          recentHistory,
        );

        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram message suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      });

      poller.onCallback((query) => {
        // Route to fast-checker for hook response handling (perm_allow/deny, askopt, etc.)
        // handleCallback writes hook-response files and edits Telegram messages
        checker.handleCallback(query).catch(err => {
          log(`Callback handling error: ${err}`);
        });
      });

      poller.onReaction((reaction) => {
        // ALLOWED_USER gate: same rule as message handler. If configured,
        // ignore reactions from other users.
        if (allowedUserId) {
          const allowedId = parseInt(allowedUserId, 10);
          if (reaction.user?.id !== allowedId) {
            log('Ignoring reaction from unauthorized user (allowed_user gate)');
            return;
          }
        }

        const from = stripControlChars(reaction.user?.first_name || reaction.user?.username || 'Unknown');
        const reactionChatId = reaction.chat?.id ?? chatId ?? '';
        const formatted = FastChecker.formatTelegramReaction(
          from,
          reactionChatId,
          reaction.message_id,
          reaction.old_reaction ?? [],
          reaction.new_reaction ?? [],
        );
        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram reaction suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      });

      poller.start().catch(err => {
        log(`Telegram poller error: ${err}`);
      });

      // Store poller reference so stopAgent() can clean it up
      const entry = this.agents.get(name);
      if (entry) entry.poller = poller;

      log('Telegram poller started');

      // Orchestrator-only: start a second poller for the org's activity
      // channel bot so Telegram inline-button callbacks (currently just
      // appr_allow_*/appr_deny_* from createApproval posts) route to
      // fast-checker's approval resolver. Polling coupled to orchestrator
      // lifecycle is a known trade-off accepted in task_1776053707166_292
      // — follow-up task_1776054009969_099 tracks migrating to a dedicated
      // singleton or Telegram webhook if the coupling ever causes real
      // operator pain. Non-orchestrator agents skip this entirely.
      await this.maybeStartActivityChannelPoller(name, org, agentDir, log);
    }
  }

  /**
   * If this agent is the org's orchestrator AND the org has an
   * activity-channel.env configured, start a second TelegramPoller bound
   * to ACTIVITY_BOT_TOKEN. Callbacks route to fast-checker's
   * handleActivityCallback. Safe no-op in every other case — if the
   * context.json is missing/corrupt, the orchestrator field is empty,
   * this agent is not the orchestrator, or the activity-channel.env
   * is absent/unreadable/missing credentials, this method returns
   * without starting anything.
   */
  private async maybeStartActivityChannelPoller(
    name: string,
    org: string | undefined,
    agentDir: string,
    log: LogFn,
  ): Promise<void> {
    if (!org) return;
    const orgDir = join(this.frameworkRoot, 'orgs', org);

    // Only the org's orchestrator runs the activity-channel poller.
    let orchestratorName: string | undefined;
    try {
      const contextJson = readFileSync(join(orgDir, 'context.json'), 'utf-8');
      orchestratorName = JSON.parse(contextJson).orchestrator;
    } catch {
      return; // No context.json or unreadable — skip
    }
    if (!orchestratorName || orchestratorName !== name) return;

    // Parse activity-channel.env for the separate bot token + chat id.
    const activityEnvPath = join(orgDir, 'activity-channel.env');
    let activityBotToken: string | undefined;
    let activityChatId: string | undefined;
    try {
      const content = readFileSync(activityEnvPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key === 'ACTIVITY_BOT_TOKEN') activityBotToken = value;
        if (key === 'ACTIVITY_CHAT_ID') activityChatId = value;
      }
    } catch {
      return; // activity-channel.env absent — silent no-op
    }

    if (!activityBotToken || !activityChatId) {
      log('Activity-channel env present but missing BOT_TOKEN or CHAT_ID — skipping poller');
      return;
    }

    const activityApi = new TelegramAPI(activityBotToken);
    const stateDir = join(this.ctxRoot, 'state', name);
    // offsetFileSuffix keeps the activity poller's offset file distinct
    // from the primary bot's .telegram-offset — without this they would
    // clobber each other in the same stateDir.
    const activityPoller = new TelegramPoller(activityApi, stateDir, 1000, 'activity');

    activityPoller.onCallback((query) => {
      const entry = this.agents.get(name);
      if (!entry) return;
      entry.checker.handleActivityCallback(query, activityApi).catch((err) => {
        log(`Activity-channel callback error: ${err}`);
      });
    });

    // Best-effort message logger — activity channel is primarily outbound
    // but any inbound chatter (broadcasts, user DMs, etc.) gets logged
    // so operators can see what is flowing. No PTY injection.
    activityPoller.onMessage((msg) => {
      const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
      const text = stripControlChars(msg.text || msg.caption || '');
      log(`[activity-channel inbound] from ${from}: ${text.slice(0, 120)}`);
    });

    activityPoller.start().catch((err) => {
      log(`Activity-channel poller error: ${err}`);
    });

    const entry = this.agents.get(name);
    if (entry) entry.activityPoller = activityPoller;

    log(`Activity-channel poller started (chat ${activityChatId})`);
  }

  /**
   * Stop an agent. Public entry point; serializes onto the per-agent op
   * chain. See {@link serialize}.
   */
  async stopAgent(name: string): Promise<void> {
    return this.serialize(name, 'stop', () => this._stopAgentImpl(name));
  }

  private async _stopAgentImpl(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) {
      console.log(`[agent-manager] Agent ${name} not found`);
      return;
    }

    if (entry.poller) entry.poller.stop();
    if (entry.activityPoller) entry.activityPoller.stop();
    entry.checker.stop();
    await entry.process.stop();
    this.agents.delete(name);

    // Stop and remove the agent's cron scheduler (if one was wired)
    const scheduler = this.cronSchedulers.get(name);
    if (scheduler) {
      scheduler.stop();
      this.cronSchedulers.delete(name);
    }

    // Clear any pending daily restart timer
    const restartTimer = this.dailyRestartTimers.get(name);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.dailyRestartTimers.delete(name);
    }
  }

  /**
   * Restart a specific agent.
   *
   * Delegates to the internal stop + start impls (inside a single
   * serialization slot, so we don't re-enter the queue and deadlock) to
   * guarantee a full teardown and rebuild of every per-agent resource:
   * AgentProcess, FastChecker, TelegramAPI, TelegramPoller, crash callback,
   * and slash-command registration. Fresh credentials are re-read from
   * {agentDir}/.env on each restart. agentDir is auto-discovered by
   * _startAgentImpl() from frameworkRoot/orgs/{org}/agents/{name}.
   *
   * Per-agent serialization (see {@link serialize}) replaces the legacy
   * pendingRestarts queue — concurrent start/stop/restart dispatches for
   * the same agent now wait their turn rather than racing the registry.
   */
  async restartAgent(name: string): Promise<void> {
    if (!this.agents.has(name)) {
      console.log(`[agent-manager] Agent ${name} not found — cannot restart`);
      return;
    }
    return this.serialize(name, 'restart', async () => {
      console.log(`[agent-manager] Restarting ${name}`);
      await this._stopAgentImpl(name);
      await this._startAgentImpl(name, '');
      console.log(`[agent-manager] Restart complete for ${name}`);
    });
  }

  /**
   * Stop all agents.
   *
   * BUG-034 partial fix: writes a `.daemon-stop` marker file in each agent's
   * state dir BEFORE stopping it. The SessionEnd crash-alert hook
   * (src/hooks/hook-crash-alert.ts) reads this marker and reports a clean
   * `🛑 daemon shutdown` notification instead of a false `🚨 CRASH` alarm.
   * Without this, every `pm2 restart cortextos-daemon` (or `pm2 stop`)
   * generates a false crash alarm per agent — trust-destroying.
   *
   * Pattern matches src/cli/bus.ts:1283-1289 and PR #12 (BUG-036). Markers
   * are written synchronously before the async stop loop starts, so by the
   * time `pty.kill()` runs, every agent already has its marker on disk.
   */
  async stopAll(): Promise<void> {
    const names = [...this.agents.keys()];

    for (const name of names) {
      try {
        const stateDir = join(this.ctxRoot, 'state', name);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, '.daemon-stop'), 'daemon shutdown (SIGTERM)');
      } catch (err) {
        // Don't block shutdown on marker-write failure — worst case the user
        // gets a false crash alarm (the bug we're fixing), best case they get
        // the correct daemon-stop notification.
        console.error(`[agent-manager] Failed to write .daemon-stop marker for ${name}: ${err}`);
      }
    }

    for (const name of names) {
      try {
        await this.stopAgent(name);
      } catch (err) {
        console.error(`[agent-manager] Error stopping ${name}:`, err);
      }
    }
  }

  /**
   * Get status of all agents.
   */
  getAllStatuses(): AgentStatus[] {
    const statuses: AgentStatus[] = [];
    for (const [, entry] of this.agents) {
      statuses.push(entry.process.getStatus());
    }
    return statuses;
  }

  /**
   * Get status of a specific agent.
   */
  getAgentStatus(name: string): AgentStatus | null {
    const entry = this.agents.get(name);
    return entry ? entry.process.getStatus() : null;
  }

  /**
   * Get the FastChecker for an agent (for Telegram message routing).
   */
  getFastChecker(name: string): FastChecker | null {
    return this.agents.get(name)?.checker || null;
  }

  /**
   * Get all agent names.
   */
  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Return the CronScheduler for a given agent (for testing / introspection).
   * Returns undefined if no scheduler is running for that agent.
   */
  getCronScheduler(agentName: string): CronScheduler | undefined {
    return this.cronSchedulers.get(agentName);
  }

  // --- Worker management ---

  /**
   * Spawn an ephemeral worker session for a parallelized task.
   */
  async spawnWorker(name: string, dir: string, prompt: string, parent?: string, model?: string): Promise<void> {
    if (this.workers.has(name)) {
      throw new Error(`Worker "${name}" is already running`);
    }
    if (this.agents.has(name)) {
      throw new Error(`"${name}" is already a registered agent name`);
    }

    const log = (msg: string) => console.log(`[worker:${name}] ${msg}`);
    const worker = new WorkerProcess(name, dir, parent, log);

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir: dir,
      org: this.org,
      projectRoot: this.frameworkRoot,
    };

    const config = model ? { model } : {};

    this.workers.set(name, worker);

    worker.onDone((workerName) => {
      // Auto-remove finished workers after a short delay so list-workers
      // can still show the final status briefly before cleanup
      setTimeout(() => {
        if (this.workers.get(workerName)?.isFinished()) {
          this.workers.delete(workerName);
        }
      }, 30_000); // keep for 30s after exit
    });

    await worker.spawn(env, prompt, config);
  }

  /**
   * Terminate a running worker session.
   */
  async terminateWorker(name: string): Promise<void> {
    const worker = this.workers.get(name);
    if (!worker) {
      throw new Error(`Worker "${name}" not found`);
    }
    await worker.terminate();
    this.workers.delete(name);
  }

  /**
   * Inject text into a running worker's PTY (nudge / stuck-state recovery).
   */
  injectWorker(name: string, text: string): boolean {
    const worker = this.workers.get(name);
    if (!worker) return false;
    return worker.inject(text);
  }

  /**
   * Inject text directly into a running agent's PTY.
   * Used by `cortextos bus test-cron-fire` to fire a cron immediately for testing.
   * Returns true if the agent is running and the inject succeeded; false otherwise.
   */
  injectAgent(agentName: string, text: string): boolean {
    return this.injectAgentDetailed(agentName, text).ok;
  }

  /**
   * Inject text into an agent's PTY with structured outcome — issue #346.
   *
   * Returns NOT_FOUND if the agent isn't in the registry, NOT_RUNNING if
   * registered but the PTY is gone, DEDUPED on a MessageDedup hash hit. The
   * boolean-returning `injectAgent()` is preserved for callers (cron
   * scheduler, fast-checker, fire-cron) that only need pass/fail.
   */
  injectAgentDetailed(agentName: string, text: string): { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' | 'DEDUPED'; message: string } {
    const entry = this.agents.get(agentName);
    if (!entry) {
      return { ok: false, code: 'NOT_FOUND', message: `agent "${agentName}" not in registry` };
    }
    return entry.process.injectMessageDetailed(text);
  }

  /**
   * Signal the CronScheduler for an agent to re-read crons.json.
   *
   * Called by the IPC server after a `bus add-cron` / `bus remove-cron` write so
   * the daemon-level scheduler picks up the new definition without waiting for
   * the next 30 s tick.  Returns true on a successful reload (or no-op for
   * Hermes agents, which manage their own crons natively); false if the agent
   * is not running at all.
   *
   * Iter 7 fix: previously this returned `true` for any registered agent even
   * when no scheduler existed in `cronSchedulers`, silently dropping reload
   * requests during the start-window gap between `this.agents.set(name, ...)`
   * and `startAgentCronScheduler(name)` (across the `await agentProcess.start()`
   * yield in `startAgent`). Now: for non-Hermes agents that lack a scheduler we
   * lazy-wire one so the just-written crons.json is read immediately.
   */
  reloadCrons(agentName: string): boolean {
    const scheduler = this.cronSchedulers.get(agentName);
    if (scheduler) {
      scheduler.reload();
      console.log(`[agent-manager] Cron scheduler reloaded for ${agentName}`);
      return true;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return false;

    // Hermes manages its own crons natively — no daemon scheduler exists by
    // design. The reload IS a no-op; report success so the caller does not
    // retry forever.
    if (entry.process['config']?.runtime === 'hermes') {
      return true;
    }

    // Non-Hermes agent registered but no scheduler: this is the start-window
    // gap. Lazy-wire the scheduler now; its start() reads crons.json which
    // already contains the new entry the caller just wrote.
    this.startAgentCronScheduler(agentName);
    console.log(`[agent-manager] Cron scheduler lazy-created for ${agentName} (start-window reload)`);
    return this.cronSchedulers.has(agentName);
  }

  /**
   * Wire a daemon-level CronScheduler for the named agent.
   *
   * The scheduler reads `crons.json` (via `readCrons()`), computes fire times,
   * and on each tick injects the cron's prompt text directly into the agent PTY
   * via `injectAgent()`.  The fire callback builds the same injected text that
   * a Claude-Code `CronCreate` callback would emit so the agent's session sees
   * a normal-looking cron-fire message and handles it with existing skill code.
   *
   * Hermes agents manage their own cron system natively — skip them here.
   * If crons.json is absent or empty the scheduler starts but has nothing to do;
   * it will pick up new entries on the next `reloadCrons()` call.
   */
  private startAgentCronScheduler(agentName: string): void {
    // Skip if already running (idempotent — e.g. called twice on fast restart)
    if (this.cronSchedulers.has(agentName)) {
      console.log(`[agent-manager] Cron scheduler already running for ${agentName} — skipped`);
      return;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return;

    // Hermes manages its own cron scheduling — don't double-schedule
    if (entry.process['config']?.runtime === 'hermes') {
      console.log(`[daemon] Skipping external cron scheduler for Hermes agent "${agentName}"`);
      return;
    }

    const onFire = async (cron: CronDefinition): Promise<void> => {
      const firedAt = new Date().toISOString();
      // Per-cron mode overrides agent-level mode, which overrides global default 'inject'.
      const cronMode = cron.cron_mode ?? entry.process.getConfig().cron_mode ?? 'inject';

      if (cronMode === 'print') {
        const runtime = entry.process.getConfig().runtime ?? 'claude-code';
        if (runtime === 'claude-code' || runtime === 'codex-app-server') {
          return this.fireCronPrint(agentName, cron, entry.process, firedAt);
        }
        console.warn(
          `[daemon] cron_mode=print is not supported for runtime="${runtime}" ` +
          `(agent "${agentName}") — falling back to inject`,
        );
      }

      const prompt = cron.prompt ?? `[cron] ${cron.name} fired`;
      // Salt with the fire timestamp so MessageDedup (which hashes the last 100
      // injects) does not reject identical cron prompts on subsequent fires.
      // Without the salt, every recurring cron after its first fire would be
      // dedup-rejected and treated as a dispatch failure.
      const injection = `[CRON FIRED ${firedAt}] ${cron.name}: ${prompt}`;
      const injected = this.injectAgent(agentName, injection);
      if (!injected) {
        throw new Error(`injectAgent returned false for agent "${agentName}" — agent may not be running`);
      }
    };

    const scheduler = new CronScheduler({
      agentName,
      onFire,
      logger: (msg) => console.log(`[daemon] ${msg}`),
    });

    scheduler.start();
    this.cronSchedulers.set(agentName, scheduler);

    const count = scheduler.getNextFireTimes().length;
    console.log(`[daemon] Loaded ${count} external cron(s) for agent "${agentName}" from crons.json`);
  }

  /**
   * Deliver a cron prompt via a one-shot subprocess.
   * claude-code → `claude --print --dangerously-skip-permissions ...`
   * codex-app-server → `codex exec --ephemeral --ask-for-approval never ...`
   * Both run with no session continuity so the agent's PTY context is unaffected.
   */
  private async fireCronPrint(
    agentName: string,
    cron: CronDefinition,
    agentProcess: AgentProcess,
    firedAt: string,
  ): Promise<void> {
    const config = agentProcess.getConfig();
    const env = await agentProcess.getPrintSubprocessEnv();
    const cwd = config.working_directory || agentProcess.getAgentDir();
    const runtime = config.runtime ?? 'claude-code';

    return new Promise((resolve, reject) => {

      const prompt = `[CRON FIRED ${firedAt}] ${cron.name}: ${cron.prompt ?? cron.name}`;

      let bin: string;
      let args: string[];
      if (runtime === 'codex-app-server') {
        bin = 'codex';
        args = [
          'exec',
          '--ephemeral',
          '--ask-for-approval', 'never',
          '--sandbox', 'danger-full-access',
          '--skip-git-repo-check',
          '-C', cwd,
        ];
        if (config.model) args.push('--model', config.model);
        args.push(prompt);
      } else {
        bin = 'claude';
        args = ['--print', '--dangerously-skip-permissions'];
        if (config.model) args.push('--model', config.model);
        args.push(prompt);
      }

      const start = Date.now();
      console.log(`[daemon] cron-print: spawning ${bin} for "${cron.name}" on agent "${agentName}" (runtime=${runtime})`);

      const child = spawnChild(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

      child.stderr.on('data', (d: Buffer) => {
        process.stderr.write(`[cron-print:${agentName}:${cron.name}] ${d}`);
      });

      child.on('close', (code: number | null) => {
        const duration_ms = Date.now() - start;
        appendExecutionLog(agentName, {
          ts: firedAt,
          cron: cron.name,
          status: code === 0 ? 'fired' : 'failed',
          attempt: 1,
          duration_ms,
          error: code !== 0 ? `${bin} exited ${code}` : null,
        });
        console.log(`[daemon] cron-print: "${cron.name}" on "${agentName}" finished (exit=${code}, ${duration_ms}ms)`);
        if (code === 0) resolve();
        else reject(new Error(`${bin} exited ${code} for cron "${cron.name}" on agent "${agentName}"`));
      });

      child.on('error', (err: Error) => {
        reject(new Error(`Failed to spawn ${bin} for cron "${cron.name}": ${err.message}`));
      });
    });
  }

  /**
   * Schedule (or reschedule) the daily session-rotation restart for an agent.
   *
   * Reads `config.daily_restart_time` (UTC HH:MM). If set, computes the next
   * wall-clock occurrence and sets a one-shot setTimeout. When it fires, injects
   * a SCHEDULED DAILY ROTATION handoff prompt, giving the agent 5 minutes to
   * write a handoff doc and call hard-restart. After firing, reschedules for
   * the following day.
   *
   * Clears any existing timer before scheduling a new one so this method is
   * safe to call on config reload.
   */
  private scheduleDailyRestart(agentName: string): void {
    // Clear any existing timer first
    const existing = this.dailyRestartTimers.get(agentName);
    if (existing) {
      clearTimeout(existing);
      this.dailyRestartTimers.delete(agentName);
    }

    const entry = this.agents.get(agentName);
    if (!entry) return;

    const restartTime = entry.process.getConfig().daily_restart_time;
    if (!restartTime) return;

    const match = restartTime.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      console.warn(`[daemon] daily_restart_time "${restartTime}" for "${agentName}" is not HH:MM — skipping`);
      return;
    }

    const targetHour = parseInt(match[1], 10);
    const targetMin  = parseInt(match[2], 10);

    const msUntilNext = (): number => {
      const now = new Date();
      const next = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        targetHour, targetMin, 0, 0,
      ));
      if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      return next.getTime() - now.getTime();
    };

    const scheduleNext = () => {
      const delay = msUntilNext();
      console.log(
        `[daemon] Daily restart for "${agentName}" scheduled in ${Math.round(delay / 60_000)}min ` +
        `(next ${restartTime} UTC)`,
      );
      const timer = setTimeout(() => {
        this.dailyRestartTimers.delete(agentName);
        this.fireDailyRestart(agentName);
        // Reschedule for next day regardless of outcome
        scheduleNext();
      }, delay);
      this.dailyRestartTimers.set(agentName, timer);
    };

    scheduleNext();
  }

  /**
   * Inject the daily rotation handoff prompt into the agent's PTY.
   * Mirrors the ctx_handoff_threshold mechanic: agent writes a handoff doc,
   * then calls hard-restart. Daemon force-restarts if agent does not comply
   * within 5 minutes.
   */
  private fireDailyRestart(agentName: string): void {
    const entry = this.agents.get(agentName);
    if (!entry) {
      console.log(`[daemon] Daily restart: agent "${agentName}" not running — skipping`);
      return;
    }

    console.log(`[daemon] Daily restart: firing handoff prompt for "${agentName}"`);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
    const handoffPrompt =
      `[SCHEDULED DAILY ROTATION] Daily session rotation triggered. ` +
      `Write a handoff document to memory/handoffs/daily-${ts}.md with these sections: ` +
      `## Current Tasks, ## Next Actions, ## Active Crons, ## Key Context, ## Files Modified This Session. ` +
      `Then run: cortextos bus hard-restart --reason "daily session rotation" ` +
      `--handoff-doc <absolute path to handoff doc you just wrote>. ` +
      `Do this NOW — you have 5 minutes before the daemon force-restarts.`;

    const injected = this.injectAgent(agentName, handoffPrompt);
    if (!injected) {
      // Agent not running or not bootstrapped — just hard-restart directly
      console.log(`[daemon] Daily restart: inject failed for "${agentName}" — force-restarting`);
      this.restartAgent(agentName).catch(err => {
        console.error(`[daemon] Daily restart: restart error for "${agentName}": ${err}`);
      });
      return;
    }

    // 5-minute grace period, then force-restart if agent hasn't self-restarted
    setTimeout(() => {
      const currentEntry = this.agents.get(agentName);
      if (currentEntry) {
        console.log(`[daemon] Daily restart: 5min grace expired for "${agentName}" — force-restarting`);
        this.restartAgent(agentName).catch(err => {
          console.error(`[daemon] Daily restart: force-restart error for "${agentName}": ${err}`);
        });
      }
    }, 5 * 60_000);
  }

  /**
   * Get status of all workers (running + recently completed).
   */
  listWorkers(): WorkerStatus[] {
    return [...this.workers.values()].map(w => w.getStatus());
  }

  /**
   * Get status of a specific worker.
   */
  getWorkerStatus(name: string): WorkerStatus | null {
    return this.workers.get(name)?.getStatus() ?? null;
  }

  /**
   * Discover agents from the organization directory structure.
   *
   * BUG-043 fix: iterate over EVERY org under `frameworkRoot/orgs/*`,
   * not just `this.org`. Before this fix, a daemon started with
   * `CTX_ORG=testorg` would only discover agents in `orgs/testorg/agents/`
   * — agents in `orgs/lifeos/agents/` and `orgs/cointally/agents/` were
   * effectively invisible to the daemon and could never be auto-spawned
   * from a cold start. Multi-org installs silently half-worked.
   *
   * The returned tuple now includes an `org` field so `discoverAndStart()`
   * can pass the correct org to `startAgent()` and downstream path
   * lookups via `resolveAgentOrg()`.
   */
  private discoverAgents(): Array<{ name: string; dir: string; org: string; config: AgentConfig }> {
    const agents: Array<{ name: string; dir: string; org: string; config: AgentConfig }> = [];

    const orgsBase = join(this.frameworkRoot, 'orgs');
    if (!existsSync(orgsBase)) return agents;

    let orgNames: string[] = [];
    try {
      orgNames = readdirSync(orgsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return agents; // unreadable orgs dir — treat as empty
    }

    for (const org of orgNames) {
      const agentsBase = join(orgsBase, org, 'agents');
      if (!existsSync(agentsBase)) continue;

      try {
        const dirs = readdirSync(agentsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const name of dirs) {
          const dir = join(agentsBase, name);
          const config = this.loadAgentConfig(dir);
          agents.push({ name, dir, org, config });
        }
      } catch {
        // Ignore read errors for this org — continue scanning others
      }
    }

    return agents;
  }

  /**
   * Load agent config from config.json.
   *
   * On parse error: log a clear, operator-actionable error to stderr (file path,
   * SyntaxError message, and a 1-line offending-snippet hint when locatable) and
   * fall back to default config so the daemon does not hard-crash. Without this
   * surfacing, a trailing comma in config.json silently degrades the agent into
   * a "model not available" state because the model field is missing — see #345.
   */
  private loadAgentConfig(agentDir: string): AgentConfig {
    const configPath = join(agentDir, 'config.json');
    if (!existsSync(configPath)) return {};
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
      console.error(`[agent-manager] config read failed: ${configPath}: ${(err as Error).message}`);
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      const msg = (err as SyntaxError).message;
      // Best-effort line/column extraction from V8 SyntaxError messages.
      // V8 emits "Unexpected token ... in JSON at position N" — we resolve
      // N back to a 1-indexed line/column so operators can jump to the offender.
      const posMatch = /position (\d+)/.exec(msg);
      let locHint = '';
      if (posMatch) {
        const pos = Math.min(Number(posMatch[1]), raw.length);
        const before = raw.slice(0, pos);
        const line = before.split('\n').length;
        const col = pos - (before.lastIndexOf('\n') + 1) + 1;
        const offendingLine = raw.split('\n')[line - 1] || '';
        locHint = ` (line ${line}, col ${col}: \`${offendingLine.trim().slice(0, 80)}\`)`;
      }
      console.error(`[agent-manager] config.json invalid JSON: ${configPath}${locHint}: ${msg}`);
      console.error(`[agent-manager] hint: trailing commas, unquoted keys, and single quotes are common causes`);
      return {};
    }
  }
}

/**
 * Derive a human-readable reply context string from a Telegram replied-to message.
 *
 * Priority: text > caption > media type label.
 * This is exported for unit testing; call sites use it via the message handler.
 *
 * Before this fix (BUG: reply context lost for media messages): only `.text` was
 * checked, so replies to videos/photos/voice arrived as bare text with no
 * indication of what was being replied to (e.g. "This one" with zero context).
 */
export function buildReplyContext(
  replyMsg: TelegramMessage | undefined,
): string | undefined {
  if (!replyMsg) return undefined;
  if (replyMsg.text) return stripControlChars(replyMsg.text);
  if (replyMsg.caption) return stripControlChars(replyMsg.caption);
  if (replyMsg.video) return '[video]';
  if (replyMsg.video_note) return '[video note]';
  if (replyMsg.photo) return '[photo]';
  if (replyMsg.voice) return '[voice message]';
  if (replyMsg.audio) return '[audio]';
  if (replyMsg.document) return `[document: ${replyMsg.document.file_name ?? 'file'}]`;
  return undefined;
}
