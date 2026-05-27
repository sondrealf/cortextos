/**
 * Next.js instrumentation hook — runs once per server worker BEFORE any
 * request handlers fire. Phase 6.2 vault overlay: fetches /dashboard +
 * /shared from Infisical and overlays them into process.env so NextAuth's
 * AUTH_SECRET, the bootstrap ADMIN_PASSWORD, and any shared keys are
 * available when the auth module loads on first request.
 *
 * Soft-fall: if INFISICAL_* are not set or the vault is unreachable, the
 * loadInfisical helper logs a warning and returns false — request
 * handlers then see whatever the .env.local already provided. This
 * matches the contract used by the cortextos daemon
 * (src/utils/infisical-fetch.ts).
 *
 * Runs only in the Node.js server runtime. The edge runtime (middleware)
 * has no instrumentation hook and never sees the vault values — that's
 * fine because middleware.ts only reads JWT cookies, not secrets.
 *
 * NOTE: Turbopack rejects `await import()` from instrumentation with
 * `MODULE_NOT_FOUND: too dynamic` even when the path is a literal string.
 * Using a top-level static `import` instead works because Turbopack can
 * resolve it during bundling.
 */
import { loadInfisical } from './lib/vault-fetch.mjs';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  await loadInfisical({
    paths: ['/shared', '/dashboard'],
    log: (msg: string) => console.log(msg),
  });
}
