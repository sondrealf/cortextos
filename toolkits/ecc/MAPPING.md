# ECC capability-payload mapping

Source of truth: [`mapping.json`](./mapping.json) — `cherry-pick-ecc.mjs` reads it.
This doc is the human-readable view; keep the two in sync.

The project-bootstrap `/new-project` flow selects an ECC payload **by detected
language/framework only** (never bulk-install) and copies it into a scaffolded
project's `.claude/` via `cherry-pick-ecc.mjs` before a worker-session build.

| Project language | Engineer skills | Tester | Reviewer agents | Build-break agent | Rules |
|---|---|---|---|---|---|
| **TypeScript / Node** (`ts`,`node`,`js`) | `coding-standards`, `backend-patterns`, `frontend-patterns` | `tdd-workflow`, `e2e-testing` | `typescript-reviewer`, `code-reviewer`, `security-reviewer` | `build-error-resolver` | `common`, `typescript`, `web` |
| **Python** (`py`) | `coding-standards`, `python-patterns` | `python-testing` | `python-reviewer`, `code-reviewer`, `security-reviewer` | `build-error-resolver` | `common`, `python` |
| **Python + Django** (framework) | + `django-patterns`, `django-security` | + `django-tdd`, `django-verification` | (inherits python) | (inherits python) | (inherits python) |
| **Go** (`golang`) | `coding-standards`, `golang-patterns` | `golang-testing` | `go-reviewer`, `code-reviewer`, `security-reviewer` | `go-build-resolver` | `common`, `golang` |
| **Rust** (`rs`) | `coding-standards`, `rust-patterns` | `rust-testing` | `rust-reviewer`, `code-reviewer`, `security-reviewer` | `rust-build-resolver` | `common`, `rust` |

> Note: ECC upstream has no `typescript-patterns`/`node-patterns` skill — TS/Node
> capability comes from `coding-standards` + `backend-patterns`/`frontend-patterns`
> + `rules/typescript`. The mapping reflects what actually exists in the vendored subset.

## Precedence guard

`nativePrecedence` in `mapping.json` lists cortextOS-native skill/command names
(`verify`, `code-review`, `simplify`, `review`, `security-review`, `plan`, `e2e`).
If a payload item's name ever matches one, `cherry-pick-ecc.mjs` **skips** it and
logs the skip — the native skill wins, never silently shadowed. (No item in the
current subset collides; the guard protects future additions.)

## Adding a language

1. Add a `languages.<lang>` (or `frameworks.<fw>`) entry to `mapping.json`.
2. Vendor any newly-referenced `skills/`, `agents/`, `rules/` into `.claude/`
   (update `NOTICE` to keep the subset list accurate).
3. Add a row here.
