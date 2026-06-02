// Bring up the project-local Postgres container WITHOUT a plaintext password
// on disk: fetch POSTGRES_PASSWORD from vault into the env, then run
// `docker compose up -d db`. docker-compose.yml reads ${POSTGRES_PASSWORD}
// from this process's env (not from a committed .env).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadInfisical } from "./vault-fetch.mjs";

// Force the per-project .env identity to WIN over any inherited INFISICAL_*.
try {
  const body = readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch { /* .env optional */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let attempt = 1; attempt <= 8; attempt++) {
  await loadInfisical({ paths: ["/shared", "/projects/__CTX_PROJECT_NAME__"] });
  if (process.env.POSTGRES_PASSWORD) break;
  const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
  console.error(`[db-up] attempt ${attempt}: POSTGRES_PASSWORD not resolved yet; retrying in ${wait}ms`);
  await sleep(wait);
}
if (!process.env.POSTGRES_PASSWORD) {
  console.error("[db-up] FATAL: POSTGRES_PASSWORD not resolved from vault — aborting");
  process.exit(1);
}

const child = spawn("docker", ["compose", "up", "-d", "db"], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
