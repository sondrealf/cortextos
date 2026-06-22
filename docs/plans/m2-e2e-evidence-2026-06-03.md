# M2 Live E2E Evidence — 2026-06-03 (~11:50–12:00Z)

**Branch:** `feat/m2-templatize-postgres-stack` @ 67a6581 (rebased onto `sondre/main` 5d32a6a, zero conflicts)
**Throwaway project:** `m2-e2e-0603` → `/root/projects/m2-e2e-0603` (torn down post-evidence, short-lived admin)
**Greenlight:** commander msg 1780480047261 post obs-detector Gate-5 pass.

## Exact e2e path executed (per verification bar)

1. **Rebase** in isolated worktree `/root/worktrees/m2-e2e`: a964732 → 67a6581 onto sondre/main 5d32a6a, clean.
2. **Build:** `npm ci` + `npm run build` (tsup) clean.
3. **Units:** full suite with `CTX_*` unset — **117/117 files, 1836 passed, 1 skipped**. (First run showed 11 dashboard-file fails = missing `dashboard/node_modules` in fresh worktree, not code; green after `dashboard/ npm ci`.)
4. **Scaffold (vault-live):** `CTX_FRAMEWORK_ROOT=/root/worktrees/m2-e2e node dist/cli.js new-project m2-e2e-0603 --lang typescript --dir /root/projects`
   - 23 stack files rendered; ports allocated **DB :5733 / dev :4146** (deterministic+probed)
   - vault minted `POSTGRES_PASSWORD` + `AUTH_SECRET` + `DATABASE_URL` under `/projects/m2-e2e-0603/`
   - per-project **read identity** minted; child `.env` is **identity-only** (INFISICAL_* triplet, zero plaintext secrets)
   - residue check: no `nextjs-test-0530` / `5433` / `4174` strings anywhere
5. **DB up:** `npm run db:up` → `m2-e2e-0603-db` container **healthy**.
6. **Migrate:** `npm run db:migrate` → applied via vaulted `DATABASE_URL` (vault-fetch loaded 9 secrets from `/shared` + `/projects/m2-e2e-0603`). Template confirmed to bake in both M1 boot gotchas: force-parse `.env` over inherited `INFISICAL_*` + retry-with-backoff on dropped vault path.
7. **Prod build:** `next build` clean (4 routes).
8. **Boot:** `npm run start` (boot.mjs, vault-first) → up in ~2s; unauth `/` → **307** to login; `/login` → **200**.
9. **Login (real, not smoke):** seeded `e2e@test.local` via vaulted DATABASE_URL (one-off `seed-e2e.mjs`, removed at teardown); `/api/auth/csrf` → POST `/api/auth/callback/credentials` → **302 + authjs.session-token cookie**; `/api/auth/session` → authenticated user with correct DB id; authed `/` → **200**.
10. **Coexistence (the M2 crux):** M1 demos unaffected while M2 live — bootstrap-test :4173 → 200, nextjs-test :4174 → 307, `nextjs-test-0530-db` (:5433) and `m2-e2e-0603-db` (:5733) **healthy side-by-side**.

## Findings

1. **Template path resolution (hardening, post-M2 dev task — commander-ack'd):** `src/cli/new-project.ts:144` resolves `frameworkRoot` from `CTX_FRAMEWORK_ROOT || process.cwd()`. Running the worktree-built CLI from an agent shell (which carries `CTX_FRAMEWORK_ROOT=/root/cortextos`) crashed at template render — `/root/cortextos/templates/nextjs-postgres` doesn't exist pre-merge. Same CTX_* env-leak family as the npm-test trap. Recommend resolving templates relative to the dist itself. **Post-merge production is unaffected** (templates will exist at the real framework root), but every worktree/dev context trips this.
2. **MOC.md ECC summary renders "(none)"** for skills/agents/rules despite 5 skills + 4 agents + 3 rule-sets actually installed in `.claude/`. Cosmetic render bug; payload itself correct on disk.

## NOT covered (explicit gaps)

- `--convex` path: unchanged by M2, **not re-proven live** (regression-check only).
- `--no-stack` and non-TS langs (python/go/rust bare git+ECC): out of scope, not exercised.
- `--remote` GitHub repo creation: not exercised (no external artifacts).
- Port-exhaustion above DB 5433–5933 / dev 4100–4600 ranges: unit-tested only, not live.
- `npm run dev` path: only prod `next build` + `boot.mjs start` exercised.
- Concurrent-scaffold port races (two simultaneous `new-project` runs): allocation is probe-based, not locked — not exercised.
- Login UI form interaction (browser): login proven at the HTTP/auth-API layer, not via headless browser.

## Teardown record (completed post-evidence)

See task log — project dir, docker container+volume+network, vault secrets+folder+read-identity all removed via short-lived admin `m2-teardown-admin-20260603`; confirmed to commander; admin revoked last by dev.
