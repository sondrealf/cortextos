// Apply Drizzle migrations against the vaulted DATABASE_URL.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { loadInfisical } from "./vault-fetch.mjs";

// Force the per-project .env identity to WIN over any inherited INFISICAL_*
// (a parent process / PM2 may inject the agent's own identity, which can't
// read this project's vault path). process.loadEnvFile does NOT override set
// vars, so parse + assign explicitly — same hardening as boot.mjs.
try {
  const body = readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch { /* .env optional */ }

// vault-fetch can silently drop a path on a transient non-200 (429 etc.).
// Retry with backoff until DATABASE_URL resolves — never single-shot.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let attempt = 1; attempt <= 8; attempt++) {
  await loadInfisical({ paths: ["/shared", "/projects/__CTX_PROJECT_NAME__"] });
  if (process.env.DATABASE_URL) break;
  const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
  console.error(`[migrate] attempt ${attempt}: DATABASE_URL not resolved yet; retrying in ${wait}ms`);
  await sleep(wait);
}

if (!process.env.DATABASE_URL) {
  console.error("[migrate] FATAL: DATABASE_URL not resolved from vault");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("[migrate] migrations applied");
