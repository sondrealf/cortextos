---
name: memory-management
description: Auto-ingestion rules for this agent's knowledge base — what to keep searchable, what to skip.
---

# Memory Management

Keep your memory collection searchable in the KB without leaking secrets or noise. These rules run on every heartbeat's re-ingest step and whenever you produce a durable write-up.

## Auto-Ingestion Rules

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

Keep searchable the topics central to your role:
- The systems, projects, and infrastructure you own or operate
- Tools and integrations you depend on (MCP servers, external APIs)
- Root causes, runbooks, and gotchas you discovered
- Patterns that worked or failed, and user preferences you learned

Tailor this list to your actual responsibilities — the goal is that a future session can grep its way back to anything non-obvious you figured out.

## How to Ingest

```bash
cortextos bus kb-ingest <file> [<file2> ...] \
  --org $CTX_ORG --scope private \
  --agent $CTX_AGENT_NAME \
  --collection "memory-$CTX_AGENT_NAME" --force
```

Use `--scope shared` only for content the whole org should see.
