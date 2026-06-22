---
name: reset-context
description: "User typed /reset-context in Telegram — write a lightweight handoff doc, notify the user, then hard-restart to get a fresh session. The last 40 Telegram messages are automatically injected into the boot prompt so no conversation context is lost."
triggers: ["/reset-context"]
---

# /reset-context

User requested a context reset via Telegram. Write a handoff doc, notify, and hard-restart. The daemon injects the last 40 Telegram messages into the boot prompt automatically, so the fresh session is not starting blind.

## Steps

```bash
# 1. Write lightweight handoff doc
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
HANDOFF_PATH="$(pwd)/memory/handoffs/handoff-${TS}.md"
mkdir -p "$(pwd)/memory/handoffs"

TASKS=$(cortextos bus list-tasks --agent "$CTX_AGENT_NAME" --status in_progress 2>/dev/null || echo "none")

cat > "$HANDOFF_PATH" << HANDOFF
# Handoff — ${TS}

Triggered by: user-initiated /reset-context via Telegram
Agent: ${CTX_AGENT_NAME}
Note: RECENT TELEGRAM in boot prompt carries the last 40 messages — conversation context is preserved.

## Active In-Progress Tasks
${TASKS}
HANDOFF

# 2. Notify user
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" "resetting context, brb"

# 3. Hard-restart with handoff doc
cortextos bus hard-restart --reason "user-initiated /reset-context" --handoff-doc "$HANDOFF_PATH"
```
