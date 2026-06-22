// Boot wrapper: load the per-project vault identity from .env, fetch app
// secrets (DATABASE_URL, AUTH_SECRET) from Infisical INTO process.env, then
// start Next.js. No plaintext app secrets ever touch disk.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadInfisical } from "./vault-fetch.mjs";

// Force the per-project .env identity to WIN over any inherited INFISICAL_*
// (PM2/daemon may inject the agent's own identity, which can't read this
// project's vault path). process.loadEnvFile does NOT override set vars, so
// parse + assign explicitly.
try {
  const body = readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch { /* .env optional */ }

// vault-fetch silently drops a path on a transient non-200 (rate-limit etc.),
// so a single fetch can return /shared but miss /projects. Retry with backoff
// until the REQUIRED keys resolve — never crash-loop on a transient hiccup.
const REQUIRED = ["DATABASE_URL", "AUTH_SECRET"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let loaded = false;
for (let attempt = 1; attempt <= 8; attempt++) {
  await loadInfisical({ paths: ["/shared", "/projects/__CTX_PROJECT_NAME__"] });
  if (REQUIRED.every((k) => process.env[k])) { loaded = true; break; }
  const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
  console.error(`[boot] attempt ${attempt}: required secrets not all present yet; retrying in ${wait}ms`);
  await sleep(wait);
}
if (!loaded) {
  console.error(`[boot] FATAL: ${REQUIRED.join("/")} not resolved from vault after retries — aborting`);
  process.exit(1);
}
console.log("[boot] vault secrets loaded; starting Next.js");

const port = process.env.PORT || "__CTX_DEV_PORT__";
const child = spawn("npx", ["next", "start", "-p", port, "-H", "0.0.0.0"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
