/**
 * Keys that the daemon's Infisical vault overlay MUST NEVER apply onto
 * a spawned agent's env, even if they happen to exist in the vault.
 *
 * Why: some env vars look like secrets but are actually local-only
 * runtime config (e.g. `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`
 * for agents that route through claude-code-router on 127.0.0.1:3456).
 * Setting those globally via `/shared` poisons every agent that does
 * NOT route through CCR — claude-code then sends the literal string
 * "cortextos" as a Bearer token to api.anthropic.com and gets 401d.
 *
 * The architectural intent is:
 *   - `/shared` holds keys every agent benefits from (GEMINI_API_KEY,
 *     OPENAI_API_KEY, etc. — actual upstream credentials).
 *   - LOCAL-ROUTING env vars belong in each agent's `.env` directly,
 *     never in vault, because they're scoped to whether that specific
 *     agent runs through CCR. Adding them to vault breaks the agents
 *     that don't.
 *
 * If you find yourself wanting to vault one of these, the right fix
 * is to put it under `/agents/<name>/` only (so only that agent gets
 * it), NOT here. If that path is also too wide, the var doesn't belong
 * in vault at all.
 */
export const VAULT_OVERLAY_BLOCKLIST = new Set<string>([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
]);
