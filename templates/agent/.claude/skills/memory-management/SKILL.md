---
name: memory-management
description: Auto-ingestion rules for the dev agent's knowledge base — what to keep searchable, what to skip.
---

# Memory Management — dev

## Auto-Ingestion Rules (from onboarding 2026-05-06)

Always ingest on create/update:
- `memory/YYYY-MM-DD.md` — daily memory files
- `MEMORY.md` — long-term learnings
- `GOALS.md` — current goals
- `IDENTITY.md` — role/vibe
- Any reports or write-ups produced under `experiments/` or `docs/`

Never ingest:
- `.env`, `.cortextos-env`, anything with secrets / API keys
- Raw log files (`*.log`, `logs/**`)
- `node_modules/**`, build artifacts, `dist/**`
- Bot tokens, chat IDs, credentials of any kind

Key topics to keep searchable:
- cortextOS internals (bus, daemon, hooks, schedulers, dashboard)
- Coliseum infra (shadow ledger, Alpaca reconciliation, run-routine.sh)
- Custom MCP servers: saxo, gpt-researcher, trading-journal, polymarket
- Upstream cortextOS fixes / PRs / issues
- Mini-orchestration patterns (subagent dispatch, Explore/Plan/general-purpose)

## How to Ingest

```bash
cortextos bus kb-ingest <file> [<file2> ...] \
  --org $CTX_ORG --scope private \
  --agent $CTX_AGENT_NAME \
  --force
```

Use `--scope shared` only for content the whole org should see.
