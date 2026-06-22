---
name: new-project
description: Scaffold a production-ready project end-to-end. Use when the user asks to start/create a new app, project, or service — drives the Superpowers orchestration spine (brainstorm → plan → scaffold+provision → TDD waves → review → verification gate → finish branch) around the `cortextos new-project` entrypoint, with per-project vault provisioning, ECC capability payload, optional Convex backend, and opt-in private GitHub remote.
---

# new-project — production-ready scaffolding flow

This is project-bootstrap's orchestration skill for `/new-project`. It composes the
**Superpowers spine** (how the waves run) with the deterministic
`cortextos new-project` CLI (scaffold + vault provisioning) and the **ECC payload**
(what each worker knows). Run the phases in order; each gate is a real stop.

## Prerequisites (one-time, already set up)
- Superpowers 12-skill spine installed in this agent's `.claude/skills/` (the phases below).
- `newproject-provisioner` identity exists; its creds are at vault
  `/agents/project-bootstrap/PROVISIONER_CLIENT_ID|SECRET` (this agent's read identity fetches them).
- ECC payload vendored at `toolkits/ecc/` + `cherry-pick-ecc.mjs`.

## Pipeline

```
cortextos new-project <name> [--lang <l>] [--framework <f>] [--convex] [--remote]
```

1. **[brainstorming]** — brain-dump → discovery questions. **GATE (user):** confirm scope, language, framework, whether Convex + whether a remote is wanted. Do not proceed until the user confirms.
2. **[writing-plans]** — Architect wave produces the plan-is-the-contract; save to `docs/plans/`. **GATE (user):** approve the plan.
3. **SCAFFOLD + PROVISION** — run `cortextos new-project <name> …` which:
   - `git init` locally (ALWAYS); creates `--remote` private GitHub repo ONLY if the user opted in.
   - detects language → `cherry-pick-ecc.mjs <lang>` copies the mapped ECC skills/agents/rules into the project `.claude/` (precedence guard: native skills win).
   - if `--convex`: copies the convex module + runs `provision-convex.mjs` (team slug auto-resolves from the vaulted account token).
   - **vault-provisions:** mints a per-project read-only identity scoped to `/projects/<name>/**` + `/shared/**`, populates `/projects/<name>/`, wires the child `.env` with the INFISICAL_* triplet, drops `vault-fetch.mjs` (carries the blocklist), strips plaintext + keeps `.env.pre-bootstrap.bak`.
   - writes `CLAUDE.md` + `MOC.md`.
4. **[subagent-driven-development] + [dispatching-parallel-agents]** — Wave 2: Engineer + Tester run TDD. **Mechanism rule:** bounded concern → Agent-tool subagent (inline/inherited skills); long/isolated build → worker-session carrying the cherry-picked ECC payload on disk.
5. **[test-driven-development]** — tests first; red → green.
6. **[systematic-debugging]** — on a red test / failed build, pair with ECC `build-error-resolver`.
7. **[requesting-code-review] / [receiving-code-review]** — Reviewer wave: ECC `<lang>-reviewer` + `security-reviewer` agents.
8. **[verification-before-completion]** — done-gate: evidence before claiming complete (per the plan's pass/fail checklist).
9. **[finishing-a-development-branch]** — commit; the child repo is ready.

## Human escalations (only when the detected project type needs them)
Most secrets are already in vault (GitHub, OpenAI, Convex token) and reused automatically.
Escalate to the user only for a genuinely-new per-type credential (Vercel, Stripe, a non-Convex DB,
auth provider, email/SMS, observability) — and only for the subset this project actually uses.

## Guardrails
- NEVER write plaintext secrets to the child `.env` — vault only, fetched at boot.
- `--remote` is opt-in; default is local-only (respects the no-auto-publish guardrail).
- The per-project identity is read-only and scoped to `/projects/<name>/` — it cannot read other consumers' secrets.
