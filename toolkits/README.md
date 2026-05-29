# toolkits/ — vendored external skill toolkits for /new-project

Vendored (MIT) subsets of two upstream toolkits that power the project-bootstrap
`/new-project` flow. They play **orthogonal** roles and compose — neither replaces
the other.

| Toolkit | Role | Where it runs | Provenance |
|---|---|---|---|
| [`superpowers/`](./superpowers/) | **Orchestration spine** — 12 skills that *are* the /new-project phases (plan → dispatch → TDD → review → verify). | Installed into the **project-bootstrap agent's own** `.claude/skills/`. Governs HOW bootstrap orchestrates. | obra/superpowers (MIT) — see `superpowers/NOTICE` |
| [`ecc/`](./ecc/) | **Capability payload** — per-language skills/agents/rules cherry-picked into each scaffolded project. Equips WHAT a worker knows. | Copied into a **scaffolded project's** `.claude/` by `ecc/cherry-pick-ecc.mjs`. | affaan-m/everything-claude-code (MIT) — see `ecc/NOTICE` |

Each subdir retains the upstream **MIT `LICENSE`** (copyright line verbatim) and a
**`NOTICE`** recording the upstream repo URL + commit SHA + vendor date + exactly
what subset was vendored. This is an MIT redistribution requirement — do not remove.

## Layer 1 — Superpowers spine (installed into project-bootstrap)

The 12 spine skills map onto the bootstrap wave loop:

| Bootstrap phase | Spine skill |
|---|---|
| brain-dump → discovery | `brainstorming` |
| Wave 1 Architect → plan-contract | `writing-plans` (→ `docs/plans/`) |
| Engineer executes the plan | `executing-plans` |
| how waves are run | `subagent-driven-development` + `dispatching-parallel-agents` |
| Wave 2 Tester (TDD) | `test-driven-development` |
| red test / failed build | `systematic-debugging` (+ ECC `build-error-resolver`) |
| Reviewer wave | `requesting-code-review` / `receiving-code-review` |
| done-gate | `verification-before-completion` |
| parallel workers w/o conflict | `using-git-worktrees` |
| branch finish | `finishing-a-development-branch` |

Skipped: `using-superpowers` (conflicts with cortextOS native Skill-tool discovery),
`writing-skills` (authoring, irrelevant to a scaffold run).

## Layer 2 — ECC payload (cherry-picked into scaffolds)

See [`ecc/MAPPING.md`](./ecc/MAPPING.md). One payload per detected language/framework,
never the full toolkit. `cherry-pick-ecc.mjs` does the selective, idempotent copy.

## Mechanism-selection rule (which spawn path delivers the payload)

The bootstrap wave dispatcher picks the spawn mechanism by **isolation need + build
duration**, NOT raw subagent count:

- **Small / bounded concern** (research, single-file review, a quick check) →
  **Agent-tool subagent**. It has no own `.claude/`; it inherits bootstrap's skills
  or gets the relevant skill inlined in the dispatch prompt. No ECC file-copy.
- **Long / isolated build** (a feature, a service, anything needing its own context
  + token budget) → **worker-session** (`worker-agents` / `m2c1-worker`). It has its
  own `.claude/`, so run `cherry-pick-ecc.mjs` to copy the mapped ECC payload onto
  disk *before* launch. ECC file-copy applies only to this path.

Rationale: the reason to pay for a worker-session is context isolation + an
independent token budget + an own `.claude/` to hold the file-copied payload. If a
task doesn't need those, an in-session subagent is cheaper.

## Precedence guard (native skills win)

cortextOS-native Power skills (`verify`, `code-review`, `simplify`, `review`,
`security-review`, …) always win over an ECC equivalent of the same name. The spine
install and `cherry-pick-ecc.mjs` both enforce this — colliding ECC items are skipped
(logged), never silently shadowing a native skill. See `ecc/mapping.json`
`nativePrecedence`.
