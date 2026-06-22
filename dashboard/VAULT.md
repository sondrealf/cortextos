# Infisical vault integration — dashboard

The cortextOS dashboard fetches its NextAuth signing secret and the
bootstrap admin credentials from Infisical at server-worker startup,
before any API route handler initialises NextAuth.

## What this consumer reads from vault

| Path | Keys |
|---|---|
| `/dashboard` | `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `AUTH_SECRET` |
| `/shared` | 8 org-wide keys (GEMINI_API_KEY, GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENROUTER_API_KEY, FREELLMAPI_TOKEN, ALPACA_PAPER_API_KEY, ALPACA_PAPER_SECRET_KEY) |

The dashboard itself only directly consumes the `/dashboard/*` set; the
`/shared/*` set is loaded so the dashboard's own bus commands (e.g.
KB-search routes that hit the same GEMINI_API_KEY the agents use)
inherit a unified env.

## Identity

| Field | Value |
|---|---|
| Identity name | `dashboard-runtime` |
| Role slug | `dashboard-runtime-readonly` |
| Scope | read-only on `/dashboard/**` + `/shared/**` |
| `clientId` + `clientSecret` | committed to `.env.local` (gitignored) |

## Where the integration code lives

- **Helper (canonical):** [`vault-fetch.mjs`](./vault-fetch.mjs) — the
  full-featured helper with both programmatic API and CLI mode. Used by
  ad-hoc scripts and by other repos as a reference copy.
- **Helper (Turbopack-safe):** [`src/lib/vault-fetch.mjs`](./src/lib/vault-fetch.mjs)
  — programmatic exports only. The Next.js bundler walks every import
  path (including the edge runtime), and rejects the CLI block as "too
  dynamic". Two-file pattern keeps both consumers happy.
- **Boot hook:** [`src/instrumentation.ts`](./src/instrumentation.ts) —
  Next.js's `register()` function. Guards on `NEXT_RUNTIME === 'nodejs'`
  (skips the edge runtime), then `await loadInfisical(...)`. Next.js
  awaits `register()` before accepting requests, so AUTH_SECRET reaches
  process.env before NextAuth initialises lazily on first /api/auth call.

## How to debug

Set `INFISICAL_LOG=1` in `.env.local` to print a per-step trace from the
Next.js worker stderr:

```
[vault-fetch:debug] POST http://localhost:8090/api/v1/auth/universal-auth/login (clientId=802170cc...)
[vault-fetch:debug] login 200
[vault-fetch:debug] GET http://localhost:8090/api/v1/workspace
[vault-fetch:debug] workspace 200
[vault-fetch:debug] project sondre-hq-bq-wx → a1b1b213-...
[vault-fetch:debug] GET secretPath=/shared → 200
[vault-fetch:debug]   /shared returned 8 secret(s): ...
[vault-fetch:debug] GET secretPath=/dashboard → 200
[vault-fetch:debug]   /dashboard returned 3 secret(s): ADMIN_USERNAME, ADMIN_PASSWORD, AUTH_SECRET
[vault-fetch:debug] merged 11 total: ...
```

Normal startup log line `[vault-fetch] loaded 11 secret(s) from vault
(paths: /shared, /dashboard)` is visible in `pm2 logs dashboard-preview`.

Common boot states:
- `[vault-fetch] loaded 11 secret(s)` → vault reachable. Normal.
- `[vault-fetch] skipped (login 401)` → wrong `INFISICAL_CLIENT_SECRET`
  in `.env.local`. Mint a fresh one in the Infisical UI under the
  `dashboard-runtime` identity → Universal Auth → Client Secrets → "New
  Secret".
- Login works but `/dashboard` returns 0 secrets → identity lost its
  role binding. Re-attach `dashboard-runtime-readonly` via UI.

## Curl fallback (read this consumer's keys directly)

```bash
BASE=http://localhost:8090
CLIENT_ID=802170cc-c677-4d75-86fd-ebade1ea25bb         # dashboard-runtime
CLIENT_SECRET=...                                       # see .env.local

TOKEN=$(curl -s -X POST "$BASE/api/v1/auth/universal-auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\"}" | jq -r .accessToken)

PROJECT_ID=$(curl -s "$BASE/api/v1/workspace" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.workspaces[] | select(.slug=="sondre-hq-bq-wx") | .id')

# List /dashboard:
curl -s "$BASE/api/v3/secrets/raw?workspaceId=$PROJECT_ID&environment=prod&secretPath=/dashboard" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.secrets[].secretKey'

# Read one:
curl -s "$BASE/api/v3/secrets/raw/AUTH_SECRET?workspaceId=$PROJECT_ID&environment=prod&secretPath=/dashboard" \
  -H "Authorization: Bearer $TOKEN" | jq -r .secret.secretValue
```

CLI equivalent:

```bash
cortextos vault list /dashboard --identity $CLIENT_ID:$CLIENT_SECRET
cortextos vault get /dashboard/AUTH_SECRET --identity $CLIENT_ID:$CLIENT_SECRET --quiet
```

## Restart contract

NextAuth reads `AUTH_SECRET` only on module-load (first request after a
server boot). After rotating it:

1. `cortextos vault rotate /dashboard/AUTH_SECRET` (or via UI).
2. `pm2 restart dashboard-preview`.
3. Every existing session is invalidated — users must re-login. This is
   the expected behaviour; AUTH_SECRET rotates the JWT signing key.

`ADMIN_PASSWORD` is only consumed at first-boot to seed the admin row in
the users sqlite table. Once that row exists, the env var is ignored on
subsequent boots — login checks the bcrypt hash in the DB. To change the
admin password, log in and use the dashboard's password-change UI, or
update the DB row directly.

## Related docs

- [`docs/infisical-vault.md`](../docs/infisical-vault.md) — architecture,
  identity model, full backup strategy.
- Upstream API spec: <https://infisical.com/docs/api-reference/overview>.
- `cortextos vault --help` for the CLI.
