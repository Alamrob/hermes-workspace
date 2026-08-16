# Runtime Integration Closure Design

## Goal

Close three deployability gaps without external calls: the documented OpenCode Usage Export contract, authenticated multichannel approval routing, and the Twenty CRM sync process entrypoint.

## OpenCode Usage Export

The read-only boundary accepts exactly `scope=service_account`, `range=24h|7d|30d`, and `service_account_id`. The CSV parser accepts exactly the documented 19 columns in order, including `reasoning_mode`, `reasoning_budget_tokens`, and `reasoning_source`. A probe uses a dedicated service account and `24h`; it snapshots IDs, runs one serialized operation, snapshots again, and requires exactly one new ID whose timestamp is within the current UTC 24-hour export window. Zero, multiple, removed baseline IDs, malformed telemetry, or a non-dedicated service-account identity fail closed.

## Approval trust zones

Sales and Telegram decisions use separate bearer secrets on the same compatibility endpoint, `POST /v1/approvals/{id}/decision`. Constant-time comparison of the Bearer against the two non-colliding secrets fixes the evidence channel; paths and request bodies cannot select or override it. Each request contains only `decision`, `actor_id`, `decided_at`, and `expires_at`; the broker loads the pending approval to bind its stored action hash, persists channel evidence through the narrow PostgreSQL capability, and delegates to `ApprovalModeCoordinator`. The coordinator issues the existing signed, one-time nonce grant only after `sales_only`, `telegram_only`, `either`, or `dual_channel` is satisfied; the default is `either`. No recovery identity or route may issue A3 evidence.

External mail, Telegram notification, and Usage Export construction live behind explicit factories. `HOSTINGER_MAIL_ENABLED`, `TELEGRAM_APPROVAL_ENABLED`, and `OPENCODE_USAGE_RECONCILIATION_ENABLED` accept only `true` or `false` and default to false. Enabling a transport requires its injected narrow port and kill-switch port. Enabling Usage Export requires `NODE_ENV=production`, a dedicated `OPENCODE_USAGE_SERVICE_ACCOUNT_ID`, and `OPENCODE_USAGE_TOKEN_FILE` under `/run/secrets`; a raw token is rejected. The disabled factory path constructs no HTTP reader and reads no token. The simulation broker obtains its mail and Telegram dependencies from this factory and therefore always constructs disabled implementations with the approved simulation environment.

## CRM sync process

`crm-sync-main.ts` loads the closed mode/config and builds a PostgreSQL store plus a Twenty client. Simulation creates no HTTP client and reads no Twenty token. Shadow polls inbound streams every 60 seconds; active also drains one outbox item per cycle. The HTTP client enforces either one HTTPS origin or the exact allowlisted Docker origin `http://twenty-server:3000`; it rejects IP literals, credentials, redirects, paths, queries, and any other plaintext host. Object routes and field/query mappings are explicit and versioned, with no generic changes endpoint. Token-file input, timeouts, streaming response body caps, and closed response schemas fail closed. A bounded retry delay applies only between polling cycles; uncertain writes remain `outcome_unknown`, never auto-retry. A deterministic reconciliation command reports partial/outcome-unknown items for operator review and never auto-merges remote state. Health is liveness; readiness requires valid configuration, database capability, and a successful completed cycle in networked modes. SIGTERM/SIGINT stop the timer, HTTP server, and pool cleanly.

## Verification

Every behavioral correction starts with a failing test. Unit tests use fake HTTP and injected clocks/timers only. Final gates are the full unit suite, TypeScript typecheck/build, PostgreSQL 17 integration suite, clean diff, and no real network/API/VPS/secret activity.
