#!/bin/bash
# quota-watchdog-v3.sh — Watchdog v3 Phase 2 (live broadcast, no agent pause).
#
# Graduates from Phase 1 (shadow-mode, log-only) to Phase 2: actually
# broadcasts QUOTA_LOW / QUOTA_RECOVERED Telegram alerts to Sondre when
# thresholds are hit. Does NOT pause or resume agents (Phase 3+).
#
# Tunables (env):
#   QUOTA_PAUSE_THRESHOLD   — % below which a QUOTA_LOW alert is sent (default 10)
#   QUOTA_RESUME_THRESHOLD  — % above which a QUOTA_RECOVERED alert is sent (default 50)
#   CTX_ROOT                — cortextos state root (default /root/.cortextos/default)
#   WATCHDOG_CHAT_ID        — Telegram chat_id to notify (default: 8654231106)
#
# Designed to run from system crontab every 4h (commander's heartbeat
# cadence). NEVER spawns a Claude session — pure shell + bus CLI.
#
# Phase progression:
#   Phase 1 (quota-shadow-commander.sh)  — log decisions, no action
#   Phase 2 (this script)               — broadcast Telegram alert only
#   Phase 3+                            — commander pauses/resumes agents

set -uo pipefail

THRESHOLD_PAUSE_PCT="${QUOTA_PAUSE_THRESHOLD:-10}"
THRESHOLD_RESUME_PCT="${QUOTA_RESUME_THRESHOLD:-50}"
CHAT_ID="${WATCHDOG_CHAT_ID:-8654231106}"

CTX_ROOT="${CTX_ROOT:-/root/.cortextos/default}"
STATE_DIR="$CTX_ROOT/state/quota-watchdog-v3"
LOG="$STATE_DIR/watchdog.log"
LAST_ALERT_FILE="$STATE_DIR/last-alert.json"
mkdir -p "$STATE_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

CORTEXTOS=/usr/bin/cortextos
JQ=/usr/bin/jq
CLAUDE_CREDS=/root/.claude/.credentials.json

# OAuth fallback
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$CLAUDE_CREDS" ]; then
  TOK=$("$JQ" -r '.claudeAiOauth.accessToken // empty' "$CLAUDE_CREDS" 2>/dev/null)
  [ -n "$TOK" ] && export CLAUDE_CODE_OAUTH_TOKEN="$TOK"
fi

export CTX_AGENT_NAME=commander
export CTX_ROOT
export CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/root/cortextos}"
export CTX_ORG="${CTX_ORG:-sondre-hq}"

log "=== v3-check start (pause<${THRESHOLD_PAUSE_PCT}%, resume>${THRESHOLD_RESUME_PCT}%) ==="

# Read remaining %
if ! API_OUT=$("$CORTEXTOS" bus check-usage-api --json 2>/dev/null); then
  log "  API unavailable → no-action (no token)"
  log "=== v3-check end ==="
  exit 0
fi
FIVE_H=$(echo "$API_OUT" | "$JQ" -r '.five_hour_utilization // empty')
if [ -z "$FIVE_H" ] || [ "$FIVE_H" = "null" ]; then
  log "  API returned no 5h util → no-action"
  log "=== v3-check end ==="
  exit 0
fi

REMAINING_PCT=$(awk -v u="$FIVE_H" 'BEGIN { p = (1-u)*100; if (p<0) p=0; printf "%.0f", p }')

# Read last alert state
LAST_ALERT="none"
if [ -f "$LAST_ALERT_FILE" ]; then
  LAST_ALERT=$("$JQ" -r '.alert // "none"' "$LAST_ALERT_FILE" 2>/dev/null || echo "none")
fi

DECISION="no-action"

if [ "$REMAINING_PCT" -lt "$THRESHOLD_PAUSE_PCT" ]; then
  if [ "$LAST_ALERT" != "low" ]; then
    DECISION="broadcast-LOW"
    echo '{"alert":"low"}' > "$LAST_ALERT_FILE"
  else
    DECISION="no-action (already-alerted-low)"
  fi
elif [ "$REMAINING_PCT" -gt "$THRESHOLD_RESUME_PCT" ] && [ "$LAST_ALERT" = "low" ]; then
  DECISION="broadcast-RECOVERED"
  echo '{"alert":"none"}' > "$LAST_ALERT_FILE"
fi

log "remaining=${REMAINING_PCT}% last_alert=${LAST_ALERT} → decision=$DECISION"

# Execute broadcast
if [ "$DECISION" = "broadcast-LOW" ]; then
  MSG="Quota watchdog: ${REMAINING_PCT}% remaining on 5h window (below ${THRESHOLD_PAUSE_PCT}% threshold). Consider pausing non-critical agents."
  "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" 2>/dev/null && log "  Telegram sent: QUOTA_LOW" || log "  Telegram send failed"
  "$CORTEXTOS" bus log-event watchdog quota_low warning --meta "{\"remaining_pct\":${REMAINING_PCT}}" 2>/dev/null || true
elif [ "$DECISION" = "broadcast-RECOVERED" ]; then
  MSG="Quota watchdog: ${REMAINING_PCT}% remaining — quota has recovered above ${THRESHOLD_RESUME_PCT}%. Agents may be resumed."
  "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$MSG" 2>/dev/null && log "  Telegram sent: QUOTA_RECOVERED" || log "  Telegram send failed"
  "$CORTEXTOS" bus log-event watchdog quota_recovered info --meta "{\"remaining_pct\":${REMAINING_PCT}}" 2>/dev/null || true
fi

log "=== v3-check end ==="
exit 0
