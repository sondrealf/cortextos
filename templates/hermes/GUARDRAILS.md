# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |
| About to type or paste a credential | "It is just a quick curl test / one-off command" | Never paste a full token into a command, message, or chat — terminal echo lands it in logs permanently. Fetch it into an env var instead: KEY=$(node dashboard/vault-fetch.mjs KEY). Masked tails (last 4) are fine for discussion. |
| Calling "live-verified" / "tested" after a rebuild | "I probed it, the record stands" | Verification of record attaches to a deploy ARTIFACT. Any rebuild/redeploy AFTER the probe invalidates the record until re-probed on the new artifact. (analyst, 2026-06-04) |
| Writing a spec or wiring a feature against the env | "process.env / config obviously has X" | Verify env + topology assumptions against DEPLOYED reality at spec/impl time, the same way you verify source assumptions. (e.g. the daemon process env carries no INFISICAL_* — they live only in per-agent .env; a process.env-only gate would have shipped inert.) |
| About to call complete-task / update-task with an ID | "that ID looks right" | Never GUESS or eyeball a task ID — they are too similar to tell apart. Pull it from `list-tasks` / the tasks dir first. complete-task silently OVERWRITES an existing result. (2026-06-04) |

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

For the complete red flag table (15 patterns), see `.claude/skills/guardrails-reference/SKILL.md`.

---

## Secret-Exposure Handling (coliseum 2026-06-04 01:05Z footgun family)

These three are one incident family: an unhardened `vault-fetch.mjs` invoked in single-secret style returned the FULL multi-secret export blob, which then got transmitted as an HTTP header. Source: coliseum's exposure-accounting (wording reviewed by coliseum 2026-06-04). The dump-all footgun itself is fixed (102c32d single-secret mode, swept host-wide), but these guardrails catch the class wherever a copy lags or a new sink appears.

**1. Shape-assert before a secret enters a header (the prevention).**
Before `curl -H "Authorization: Bearer $VAL" ...` where `VAL=$(node vault-fetch.mjs KEY)` (or any command-substituted secret), assert `VAL` is **single-line, plausible length, and the expected shape** first. A dump-all blob is multi-line; the assert stops it transmitting as headers. Blast-radius multiplier: if the same variable feeds two headers (e.g. `apikey:` + `Authorization:`), the blob transmits TWICE per request. Version caveat: verbatim multi-line `-H` transmission (bare-LF lines included) is verified on curl 7.81.0; newer curls may reject CRLF client-side — assume NEITHER behavior protects you. Safer mechanism: write the header to a file and use `curl -K` instead of shell interpolation.
```bash
[[ "$VAL" == *$'\n'* || ${#VAL} -gt 300 ]] && { echo "ABORT: multi-line/oversized secret — vault-fetch dump-all footgun?"; exit 1; }
[[ "$VAL" =~ ^sk-or-v1-[A-Za-z0-9]+$ ]] || { echo "ABORT: unexpected shape"; exit 1; }  # adapt regex per key
```

**2. `curl` exit code 92 on an authed request: treat as contaminated-header SYMPTOM, not a network blip.**
Exit 92 (HTTP/2 stream error) **immediately after sending headers** on an authenticated request: TREAT it as a contaminated-header symptom (a multi-line value malforms the header field value) and inspect the variable you just sent BEFORE any retry — 92 has other legitimate causes (flaky h2 proxies, server-side stream resets), so the rule is inspect-first, never assume-and-retry. **Never blind-retry** — every retry re-transmits the blob; in the source incident the `--http1.1` retry is what completed the exposure. Observed signature: contaminated multi-line header → h2: headers transmitted, then stream error (exit 92, consistent with edge RST), while the same request over http1.1 falls through to a 401 at the gateway.

**3. Wire-capture method for exposure accounting (the answer, when asked "did secret X leave the box").**
Reconstruct the EXACT transmission from the wire, not from intent. Evidence-grade, not "probably fine":
- **What bytes** went out (e.g. curl 7.81.0 transmits multi-line `-H` verbatim).
- **To what destination** (e.g. Supabase edge: Cloudflare → Kong).
- **Over what transport** (e.g. TLS-only).
- **How far it penetrated** (e.g. h2: headers transmitted, then stream error — exit 92, consistent with edge RST, the frame itself not captured; http1.1 died 401 at the gateway, never reached Postgres).
- **Explicitly name the unverifiable cells** (e.g. edge-log retention) rather than implying full coverage.

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table in `.claude/skills/guardrails-reference/SKILL.md`. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it to the skill file. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |
