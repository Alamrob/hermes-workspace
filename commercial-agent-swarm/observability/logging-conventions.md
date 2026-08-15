# Logging Conventions

## Required event fields

Every event validates against `audit-event.schema.json` and includes mission/trace/agent, event type/time, tool, duration, token/cost, redacted input summary, outcome/error, retry count, external flag, approval ID, evidence/change refs and integrity hashes.

## Conventions

- UTC ISO-8601 timestamps; Hostinger/Chile timezone only for user presentation and contact-window checks.
- JSONL or structured database events, never free-text-only logs.
- `trace_id` spans Codex → Hermes → connector; `mission_id` spans a work order; `assignment_id` spans one worker; `action_hash` spans one possible side effect.
- No secrets, cookies, auth headers, full message bodies, raw contact fields or sensitive data in logs. Use IDs, hashes and redacted summaries.
- Append-only audit events with previous-event hash. Corrections append a new event; they do not rewrite history.
- External change is successful only with a connector receipt and read-back/reconciliation where supported.

## Core metrics

- Missions by terminal state and cycle time.
- Tool latency/error/retry and token/cost by agent/mission.
- Budget consumption and cost per verified outcome.
- Approval requested/approved/denied/expired/consumed and mismatches.
- External attempts/success/uncertain/duplicate-prevented.
- Data quality, QA findings, human corrections and evidence coverage.
- Delivery/bounce/complaint/opt-out and positive/qualified outcomes.
- Kill-switch activations, containment/recovery time and recurrence.
