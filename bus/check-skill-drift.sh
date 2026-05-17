#!/usr/bin/env bash
# check-skill-drift.sh — Diff live agent skills against their template counterparts
#
# Detects two failure modes:
#   (1) Template-ahead-of-live: framework updates that never propagated to agents
#   (2) Live-ahead-of-template: hotfixes applied to live agents that were never backported
#
# Usage:
#   cortextos bus check-skill-drift [--org ORG] [--agent AGENT] [--format text|json] [--content]
#
# Options:
#   --org ORG       Limit to a specific org (default: all orgs)
#   --agent AGENT   Limit to a specific agent within the org
#   --format        Output format: text (default) or json
#   --content       Show actual content diff lines (default: names only)
#
# Exit codes:
#   0   No drift found
#   1   Drift detected
#   2   Error (bad args, missing dirs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_ctx-env.sh"

# ── Args ─────────────────────────────────────────────────────────────────────
FILTER_ORG=""
FILTER_AGENT=""
FORMAT="text"
SHOW_CONTENT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org)      FILTER_ORG="$2";   shift 2 ;;
    --agent)    FILTER_AGENT="$2"; shift 2 ;;
    --format)   FORMAT="$2";       shift 2 ;;
    --content)  SHOW_CONTENT=true; shift   ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "text" && "$FORMAT" != "json" ]]; then
  echo "Error: --format must be 'text' or 'json'" >&2
  exit 2
fi

# ── Locate framework root ─────────────────────────────────────────────────────
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-}"
if [[ -z "$FRAMEWORK_ROOT" ]]; then
  # Walk up from the script to find the cortextos root (contains templates/)
  CANDIDATE="$SCRIPT_DIR"
  while [[ "$CANDIDATE" != "/" ]]; do
    if [[ -d "$CANDIDATE/templates" && -d "$CANDIDATE/orgs" ]]; then
      FRAMEWORK_ROOT="$CANDIDATE"
      break
    fi
    CANDIDATE="$(dirname "$CANDIDATE")"
  done
fi

if [[ -z "$FRAMEWORK_ROOT" || ! -d "$FRAMEWORK_ROOT/templates" ]]; then
  echo "Error: cannot locate cortextos framework root (need templates/ dir)" >&2
  exit 2
fi

TEMPLATES_DIR="$FRAMEWORK_ROOT/templates"
ORGS_DIR="$FRAMEWORK_ROOT/orgs"

if [[ ! -d "$ORGS_DIR" ]]; then
  echo "Error: orgs/ directory not found at $ORGS_DIR" >&2
  exit 2
fi

# ── Build list of template skill sets ────────────────────────────────────────
# Each template type gets its own skill set for best-match detection.
declare -A TEMPLATE_SKILLS  # template_name -> space-separated skill list

while IFS= read -r -d '' tmpl_skills_dir; do
  tmpl_name="$(basename "$(dirname "$(dirname "$tmpl_skills_dir")")")"
  if [[ -d "$tmpl_skills_dir" ]]; then
    skills="$(ls "$tmpl_skills_dir" 2>/dev/null | tr '\n' ' ')"
    TEMPLATE_SKILLS["$tmpl_name"]="$skills"
  fi
done < <(find "$TEMPLATES_DIR" -type d -name skills -path "*/.claude/skills" -print0 2>/dev/null)

if [[ ${#TEMPLATE_SKILLS[@]} -eq 0 ]]; then
  echo "Error: no template skill directories found under $TEMPLATES_DIR" >&2
  exit 2
fi

# ── Helper: pick best-matching template for an agent ─────────────────────────
best_template_for_agent() {
  local agent_skills_dir="$1"
  local best_tmpl=""
  local best_count=0

  local agent_skills
  agent_skills="$(ls "$agent_skills_dir" 2>/dev/null | tr '\n' ' ')"

  for tmpl_name in "${!TEMPLATE_SKILLS[@]}"; do
    local tmpl_skills="${TEMPLATE_SKILLS[$tmpl_name]}"
    local count=0
    for skill in $agent_skills; do
      if echo "$tmpl_skills" | grep -qw "$skill"; then
        ((count++)) || true
      fi
    done
    if [[ $count -gt $best_count ]]; then
      best_count=$count
      best_tmpl="$tmpl_name"
    fi
  done

  echo "$best_tmpl"
}

# ── Collect drift data ────────────────────────────────────────────────────────
# JSON accumulator for --format json
json_agents="[]"

total_agents=0
total_drift_agents=0
total_live_only=0
total_tmpl_only=0
total_content_drift=0

drift_found=false

text_output=""

process_agent() {
  local org="$1"
  local agent="$2"
  local agent_dir="$ORGS_DIR/$org/agents/$agent"
  local agent_skills_dir="$agent_dir/.claude/skills"

  [[ -d "$agent_skills_dir" ]] || return 0

  local best_tmpl
  best_tmpl="$(best_template_for_agent "$agent_skills_dir")"
  [[ -z "$best_tmpl" ]] && return 0

  local tmpl_skills_dir="$TEMPLATES_DIR/$best_tmpl/.claude/skills"
  [[ -d "$tmpl_skills_dir" ]] || return 0

  local live_skills tmpl_skills
  live_skills="$(ls "$agent_skills_dir" | sort)"
  tmpl_skills="$(ls "$tmpl_skills_dir"  | sort)"

  # Three categories
  local live_only tmpl_only content_drift
  live_only="$(comm -13 <(echo "$tmpl_skills") <(echo "$live_skills"))"
  tmpl_only="$(comm -23 <(echo "$tmpl_skills") <(echo "$live_skills"))"

  content_drift=""
  while IFS= read -r skill; do
    [[ -z "$skill" ]] && continue
    local lf="$agent_skills_dir/$skill/SKILL.md"
    local tf="$tmpl_skills_dir/$skill/SKILL.md"
    if [[ -f "$lf" && -f "$tf" ]]; then
      if ! diff -q "$tf" "$lf" > /dev/null 2>&1; then
        content_drift="${content_drift}${skill}"$'\n'
      fi
    fi
  done < <(comm -12 <(echo "$tmpl_skills") <(echo "$live_skills"))

  local has_drift=false
  [[ -n "$live_only" || -n "$tmpl_only" || -n "$content_drift" ]] && has_drift=true

  ((total_agents++)) || true
  $has_drift && { ((total_drift_agents++)) || true; drift_found=true; }

  local lo_count to_count cd_count
  lo_count=$(echo "$live_only"     | grep -c '[^[:space:]]' || true)
  to_count=$(echo "$tmpl_only"     | grep -c '[^[:space:]]' || true)
  cd_count=$(echo "$content_drift" | grep -c '[^[:space:]]' || true)
  ((total_live_only   += lo_count)) || true
  ((total_tmpl_only   += to_count)) || true
  ((total_content_drift += cd_count)) || true

  if [[ "$FORMAT" == "text" ]]; then
    local block=""
    block+="  Agent: $org/$agent  (template: $best_tmpl)\n"
    if ! $has_drift; then
      block+="    ✓ no drift\n"
    else
      if [[ -n "$live_only" ]]; then
        block+="    live-only ($lo_count): $(echo "$live_only" | tr '\n' ' ')\n"
      fi
      if [[ -n "$tmpl_only" ]]; then
        block+="    template-only ($to_count): $(echo "$tmpl_only" | tr '\n' ' ')\n"
      fi
      if [[ -n "$content_drift" ]]; then
        block+="    content-drift ($cd_count): $(echo "$content_drift" | tr '\n' ' ')\n"
        if $SHOW_CONTENT; then
          while IFS= read -r skill; do
            [[ -z "$skill" ]] && continue
            local lf="$agent_skills_dir/$skill/SKILL.md"
            local tf="$tmpl_skills_dir/$skill/SKILL.md"
            block+="    --- diff $skill ---\n"
            block+="$(diff "$tf" "$lf" | sed 's/^/      /')\n"
          done < <(echo "$content_drift")
        fi
      fi
    fi
    text_output+="$block\n"
  fi

  if [[ "$FORMAT" == "json" ]]; then
    local lo_arr to_arr cd_arr
    lo_arr="$(echo "$live_only"     | grep -v '^$' | jq -R . | jq -s . 2>/dev/null || echo "[]")"
    to_arr="$(echo "$tmpl_only"     | grep -v '^$' | jq -R . | jq -s . 2>/dev/null || echo "[]")"
    cd_arr="$(echo "$content_drift" | grep -v '^$' | jq -R . | jq -s . 2>/dev/null || echo "[]")"

    local agent_json
    agent_json="$(jq -n \
      --arg org "$org" \
      --arg agent "$agent" \
      --arg tmpl "$best_tmpl" \
      --argjson live_only "$lo_arr" \
      --argjson tmpl_only "$to_arr" \
      --argjson content_drift "$cd_arr" \
      '{org:$org, agent:$agent, template:$tmpl, live_only:$live_only, template_only:$tmpl_only, content_drift:$content_drift}')"

    json_agents="$(echo "$json_agents" | jq --argjson a "$agent_json" '. + [$a]')"
  fi
}

# ── Main scan loop ────────────────────────────────────────────────────────────
while IFS= read -r -d '' org_dir; do
  org="$(basename "$org_dir")"
  [[ -n "$FILTER_ORG" && "$org" != "$FILTER_ORG" ]] && continue
  [[ -d "$org_dir/agents" ]] || continue

  while IFS= read -r -d '' agent_dir; do
    agent="$(basename "$agent_dir")"
    [[ -n "$FILTER_AGENT" && "$agent" != "$FILTER_AGENT" ]] && continue
    process_agent "$org" "$agent"
  done < <(find "$org_dir/agents" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
done < <(find "$ORGS_DIR" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

# ── Output ────────────────────────────────────────────────────────────────────
if [[ "$FORMAT" == "text" ]]; then
  echo "=== Skill Drift Report — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo ""
  echo "Summary: $total_agents agent(s) scanned, $total_drift_agents with drift"
  echo "         live-only: $total_live_only  template-only: $total_tmpl_only  content-drift: $total_content_drift"
  echo ""
  echo "--- Agents ---"
  printf "%b" "$text_output"
fi

if [[ "$FORMAT" == "json" ]]; then
  jq -n \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson agents_scanned "$total_agents" \
    --argjson agents_with_drift "$total_drift_agents" \
    --argjson live_only_total "$total_live_only" \
    --argjson tmpl_only_total "$total_tmpl_only" \
    --argjson content_drift_total "$total_content_drift" \
    --argjson agents "$json_agents" \
    '{
      timestamp: $ts,
      summary: {
        agents_scanned: $agents_scanned,
        agents_with_drift: $agents_with_drift,
        live_only_total: $live_only_total,
        template_only_total: $tmpl_only_total,
        content_drift_total: $content_drift_total
      },
      agents: $agents
    }'
fi

$drift_found && exit 1 || exit 0
