# M2 — Templatize the `/new-project` default stack (project-local Postgres)

**Status:** plan (pre-build) · **Branch:** `feat/m2-templatize-postgres-stack` (off `sondre/main`)
**Owner:** project-bootstrap · **Greenlit:** commander 2026-06-02 (Postgres decision **A** = project-local Dockerized PG per project)
**Gate:** commander signs off pre-merge per the verification bar (named executed path + gaps).

## Problem / context
`cortextos new-project` today scaffolds: dir + `git init`, ECC capability payload, optional
Convex backend, per-project vault read-identity, `CLAUDE.md`/`MOC.md`. It emits **no app
skeleton and no Postgres/Drizzle/Auth.js stack** — the locked default stack
([[feedback_sondre_stack_preference]]) had to be hand-built during M1.

M1 (`/root/projects/nextjs-test-0530`) is the **proven, live** reference: Next.js 15 +
`next-auth@5` + Drizzle + `pg`, a project-local Dockerized Postgres (`docker-compose.yml`),
`boot.mjs` (vault-first boot), `migrate.mjs`, `vault-fetch.mjs`. Decision A means each
scaffolded project ships its **own** Postgres container (isolated, trivially torn down) —
so the one thing M1 did NOT solve is **multi-project coexistence on one host** (M1 hardcodes
port `5433` and dev port `4174`).

**M2 = lift the proven M1 artifacts into a reusable template the CLI emits automatically,
parameterized per project, with collision-free port + secret allocation.**

## Scope of templatization (per-project substitution surface)
From the M1 audit, these tokens must be parameterized:

| File | Token(s) |
|------|----------|
| `docker-compose.yml` | `container_name` (`<name>-db`), host port `${DB_PORT}:5432`, volume name |
| `package.json` | `name`, `dev -p <DEV_PORT>` |
| `migrate.mjs` | vault path `/projects/<name>` |
| `boot.mjs` / `vault-fetch.mjs` | vault paths `["/shared", "/projects/<name>"]` |
| vault `/projects/<name>/` | **new:** `DATABASE_URL`, `POSTGRES_PASSWORD`, `AUTH_SECRET` (minted, not just `PROVISIONED_AT`) |
| `CLAUDE.md` / `MOC.md` | name, chosen ports, stack summary |

App source (`src/auth.ts`, `src/db/{index,schema}.ts`, `src/app/**`, the auth route, the
initial Drizzle migration) is copied verbatim — it's project-agnostic.

## Design decisions
1. **Default stack vs Convex.** Postgres+Drizzle+Auth.js is the **default** for
   `lang=typescript` (no flag). `--convex` remains the opt-in alternative backend
   (mutually exclusive with the Postgres stack). A `--no-stack` escape hatch keeps the
   current bare git+ECC behavior for non-web TS libs.
2. **Port allocation (the project-local crux).** Derive a deterministic candidate from a
   hash of the project name into a range (DB `5433–5933`, dev `4100–4600`), then **probe**
   for a free host port (and absence of a same-named docker container) and increment on
   collision. The chosen ports are written into `docker-compose.yml`, `package.json`, vault
   `DATABASE_URL`, and recorded in `MOC.md`. Pure allocation fn → unit-testable.
3. **Secret minting.** Extend `provisionVault()` to also mint+upsert into `/projects/<name>/`:
   `POSTGRES_PASSWORD` (random), `AUTH_SECRET` (random, `openssl rand`-equiv), and
   `DATABASE_URL=postgres://app:<pw>@localhost:<DB_PORT>/appdb`. Decision-A note baked into
   `docker-compose.yml`: switching to central PG later = just repoint vaulted `DATABASE_URL`,
   no app-code change (already worded in M1).
4. **Template location.** `templates/nextjs-postgres/` holding the M1 files as `.tmpl`
   where tokens appear, verbatim otherwise. A small `renderStack()` in `new-project.ts`
   does the copy+substitute (mirrors existing `renderChildEnv`/`renderClaudeMd` purity style).

## Build steps (TDD, branch-only)
1. Extract `templates/nextjs-postgres/` from the M1 demo (verbatim app src + tokenized stack files).
2. `allocatePorts(name, takenProbe)` pure fn + unit tests (deterministic, collision-skip).
3. `renderStack(name, ports)` copy+substitute + unit tests (no stray `nextjs-test-0530`).
4. Extend `provisionVault()` to mint `POSTGRES_PASSWORD`/`AUTH_SECRET`/`DATABASE_URL`.
5. Wire CLI: default→stack, `--convex`→convex, `--no-stack`→bare; update `--dry-run` to
   emit the skeleton but skip vault/docker.
6. `npm run build` clean + `npm test` green (unset `CTX_*` to avoid the env-leak false-fails,
   see [[project_npm_test_ctx_env_leak]]).

## Verification path (for the pre-merge sign-off)
- **Executed:** `cortextos new-project m2-verify --dry-run` → skeleton diff matches M1 shape,
  ports allocated, no `nextjs-test-0530` residue. Then a **full** non-dry-run scaffold of a
  throwaway project → `docker compose up` Postgres healthy → `npm run db:migrate` → `npm run build`
  → `npm run start` (boot.mjs) reachable, login works. Teardown after (provisioner is
  create-only — short-lived admin, see [[project_provisioner_create_only]]).
- **Gaps to call out:** `--convex` path unchanged by this work (regression-check only, not
  re-proven); Python/Go/Rust langs still bare git+ECC (out of scope — stack is TS-only);
  port-exhaustion above the range falls back to probe-and-error (documented, not auto-widened).

## Guardrails
- Branch-only; no merge/deploy without commander sign-off. No Sondre approval needed to *build*.
- NEVER write plaintext secrets to child `.env` — vault only ([[project_new_project_infisical_wrapper]]).
- Bake the M1 boot gotchas into the template boot wrapper: force-parse `.env` over inherited
  `INFISICAL_*`, vault-fetch retry/backoff ([[project_scaffolded_pm2_vault_boot_gotchas]]).
- `--remote` stays opt-in (no auto-publish).
