# Convex managed-cloud auto-provisioning

Drop-in module so a Convex-backed `/new-project` scaffold self-provisions its
own managed-cloud deployment with **zero manual signup/login per project**.

Status: **branch-only**, authored against the project-bootstrap Phase 6.3 spec.
The `/new-project` flow is still parked (awaiting Sondre's toolkit decision), so
this is the reusable provisioning module it will invoke once unparked. The
consume-side both-paths vault verify is coordinated by commander + the
project-bootstrap identity once the secret is written (see below).

## Files

| File | Purpose |
|------|---------|
| `provision-convex.mjs` | Provisioning module + CLI. Creates the cloud project/deployment, parses the result, optionally mints a per-project deploy key. |
| `vault-fetch.mjs` | Verbatim copy of the canonical Infisical Universal-Auth helper (`dashboard/vault-fetch.mjs`). No-dependency, soft-fail. |

## Credential model (verified vs convex CLI v1.39.1)

Two distinct Convex credential classes:

1. **Account access token** — the *only* credential that can **create** a new
   project + deployment. Minted once by Sondre via `npx convex login`. The
   durable copy lives in Infisical at **`/agents/project-bootstrap/CONVEX_ACCESS_TOKEN`**
   so only the provisioner can read it (it can create/delete projects across
   the whole Convex account → least-privilege demands tight scoping, NOT
   `/shared`).
2. **Deploy key** (`CONVEX_DEPLOY_KEY`) — scoped to an *existing* project or
   deployment; **cannot** create a project. This is what a scaffolded child
   repo gets for ongoing `convex deploy` in its own CI, so the broad account
   token never lives in the child.

**A per-project deploy key needs no special handling at provisioning time** —
the account token alone creates the project. The deploy key is a post-provision
hardening step (commander-approved standard): mint a project-scoped key, hand
*that* to the child.

### How the account token is consumed

Verified in the CLI source:

```js
if (process.env.CONVEX_OVERRIDE_ACCESS_TOKEN) {
  return { accessToken: process.env.CONVEX_OVERRIDE_ACCESS_TOKEN, ... };
}
// else fall back to ~/.convex/config.json {accessToken}
```

We use the **`CONVEX_OVERRIDE_ACCESS_TOKEN` env-var path**: vault-fetch the
token, inject it into the convex subprocess env only. Nothing is written to
disk, precedence is deterministic, and it avoids the `--env-file` re-auth-loop
bug ([convex-backend#370](https://github.com/get-convex/convex-backend/issues/370)).
This is a real consumable secret — **not** a `VAULT_OVERLAY_BLOCKLIST`
candidate (unlike `ANTHROPIC_AUTH_TOKEN`).

## The verified unattended-create command

```bash
CONVEX_OVERRIDE_ACCESS_TOKEN=<from vault> \
npx convex dev --once \
  --configure new \
  --team <team_slug> \
  --project <project_slug> \
  --dev-deployment cloud \
  --typecheck=disable
```

`--once` runs configure + push then stops (no watch loop). It creates the
managed-cloud project + dev deployment and writes `CONVEX_DEPLOYMENT` +
`NEXT_PUBLIC_CONVEX_URL` / `CONVEX_URL` into `<projectDir>/.env.local`.

## Usage

```bash
# project-bootstrap identity env must be present:
#   INFISICAL_HOST, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET
node provision-convex.mjs \
  --project-dir /path/to/new-project \
  --project <convex-project-slug> \
  --team <convex-team-slug> \
  [--vault-path /agents/project-bootstrap] \
  [--no-deploy-key]
```

Programmatic:

```js
import { provisionConvex } from './provision-convex.mjs';
const { deployment, url, deployKey } = await provisionConvex({
  projectDir, project, team, vaultPath: '/agents/project-bootstrap', deployKey: true,
});
```

## How `/new-project` wires this in (Phase 6.3)

1. Scaffold the project files (Convex template, `convex/` dir, package.json).
2. Ensure the project-bootstrap agent env has the `INFISICAL_*` triplet.
3. Copy this directory's two `.mjs` files into the scaffold's tooling dir.
4. Run `provision-convex.mjs` with the chosen project/team slug.
5. The child repo keeps `.env.local` (`CONVEX_DEPLOYMENT` + URL) and, once the
   deploy-key mint is verified, `CONVEX_DEPLOY_KEY` for CI — never the account
   token.

## Open verification items (first real run)

- **Deploy-key mint endpoint** (`mintProjectDeployKey`) uses the documented
  management API shape but has not been smoke-tested live (no token at author
  time). It is non-fatal — provisioning succeeds without it. Confirm the
  endpoint/payload on the first real provisioning run and adjust if needed.
- **Team slug resolution.** The team slug is currently an explicit input. If
  the account has a single default team, this can later be auto-resolved via
  the management API rather than passed in.

## Free tier

Convex free Starter plan includes **40 deployments**. One dev deployment per
project ⇒ ~40 self-provisioned projects covered at no cost.
