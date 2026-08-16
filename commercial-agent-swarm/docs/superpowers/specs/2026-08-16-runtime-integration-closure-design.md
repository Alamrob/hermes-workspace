# Runtime Integration Closure Design

## Goal

Close three deployability gaps without external calls: the documented OpenCode Usage Export contract, authenticated multichannel approval routing, and the Twenty CRM sync process entrypoint.

## OpenCode Usage Export

The read-only boundary accepts exactly `scope=service_account`, `range=24h|7d|30d`, and `service_account_id`. The CSV parser accepts exactly the documented 19 columns in order, including `reasoning_mode`, `reasoning_budget_tokens`, and `reasoning_source`. A probe uses a dedicated service account and `24h`; it snapshots IDs, runs one serialized operation, snapshots again, and requires exactly one new ID whose timestamp is within the current UTC 24-hour export window. Zero, multiple, removed baseline IDs, malformed telemetry, or a non-dedicated service-account identity fail closed.

## Approval trust zones

Sales and Telegram decisions use separate bearer secrets and separate routes. The authenticated route fixes the evidence channel; request bodies cannot select or override it. Each request contains only `decision`, `actor_id`, `decided_at`, and `expires_at`; the broker loads the pending approval to bind its stored action hash, persists channel evidence through the narrow PostgreSQL capability, and delegates to `ApprovalModeCoordinator`. The coordinator issues the existing signed, one-time nonce grant only after `sales_only`, `telegram_only`, `either`, or `dual_channel` is satisfied; the default is `either`. No recovery identity or route may issue A3 evidence.

External mail, Telegram notification, and Usage Export construction live behind explicit factories. Production-facing features default disabled and require a feature flag plus injected narrow ports; simulation always constructs disabled implementations and performs no token read or network operation.

## CRM sync process

`crm-sync-main.ts` loads the closed mode/config and builds a PostgreSQL store plus an HTTPS-only Twenty client. Simulation creates no HTTP client and reads no Twenty token. Shadow polls inbound streams every 60 seconds; active also drains one outbox item per cycle. The HTTP client enforces one configured HTTPS origin, fixed paths/methods, token-file input, timeouts, response body caps, and closed response schemas. A bounded retry delay applies only between polling cycles; uncertain writes remain `outcome_unknown`, never auto-retry. A deterministic reconciliation command reports partial/outcome-unknown items for operator review and never auto-merges remote state. Health is liveness; readiness requires valid configuration, database capability, and a successful completed cycle in networked modes. SIGTERM/SIGINT stop the timer, HTTP server, and pool cleanly.

## Verification

Every behavioral correction starts with a failing test. Unit tests use fake HTTP and injected clocks/timers only. Final gates are the full unit suite, TypeScript typecheck/build, PostgreSQL 17 integration suite, clean diff, and no real network/API/VPS/secret activity.
