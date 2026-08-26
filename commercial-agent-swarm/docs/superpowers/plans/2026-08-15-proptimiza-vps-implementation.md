# Proptimiza Commercial Swarm VPS Implementation Plan

> Execute with subagent-driven development. Production code follows strict TDD; configuration and runbooks require static validation and dry-run tests before deployment.

**Goal:** Secure the Hostinger VPS, convert the existing proposed swarm into six native Hermes 0.20.1 profiles, add a deterministic approval/mail broker, establish PostgreSQL as the control source of truth, deploy an isolated fail-closed stack, and qualify it through simulation and shadow mode before one separately approved internal email test.

**Architecture:** Codex is the control plane. A dedicated `commercial-swarm` stack contains Hermes execution profiles and a deterministic Node/TypeScript broker. PostgreSQL stores versioned catalog/control/mail state. Hostinger Mail and Telegram secrets are broker-only. A3 remains globally disabled except for a one-time, exact internal action authorized through the Approval Gateway.

## Global Constraints

- Project is Proptimiza; offer is `Operación Sin Planillas` from CLP 1,800,000; no autonomous changes.
- ICP is Chilean B2B service companies with 10-100 employees and manual Excel/WhatsApp/email operations.
- No external prospect contact, campaign, proposal, discount, promise, contract, payment or purchase.
- Only `ventas@proptimiza.com` to `contacto@proptimiza.com` may later be authorized as a real mail test.
- Direct Hostinger Mail MCP access from Hermes is prohibited.
- Secrets never enter Git, agent profiles, model memory, n8n or logs.
- Existing apps stay running; rollback affects only `commercial-swarm`.
- Pin deployable images and source revisions; default deny, least privilege and auditable idempotency are mandatory.

### Task 1: Secure Access and Capture Rollback Evidence

- [ ] Verify a FireLucky administrative key in a second SSH session before revocation.
- [ ] Back up and hash current Compose/config/profile/database metadata without exporting secrets to Git.
- [ ] Remove the agent-readable host key and its authorized entry.
- [ ] Remove broad passwordless sudo from `ops` and verify no container has host/socket/SSH/root mounts.
- [ ] Verify root break-glass access and existing application health.

### Task 2: Runtime Contracts and Approval Broker

- Runtime location: `commercial-agent-swarm/runtime/`, standalone Node 22 TypeScript service using built-in HTTP/crypto plus a PostgreSQL driver; no framework-specific coupling.
- Public interfaces: `POST /v1/work-orders`, `GET /v1/missions/{mission_id}`, `POST /v1/approvals/requests`, `POST /v1/approvals/{id}/decision`, `POST /v1/mail/send`, `POST /webhooks/hostinger-mail/{mailbox_key}`, `GET /healthz`, `GET /readyz`.
- Approval format: `APPROVAL::<mission_id>::<action_hash>::<expires_at>::<nonce>::<signature>`, HMAC-SHA256 over canonical JSON, maximum 30-minute TTL and atomic one-time consumption.
- The mail policy permits only `ventas@proptimiza.com` to `contacto@proptimiza.com`, volume one, and only when A3 is enabled for the exact mission; it rejects all other recipients before transport invocation.
- The webhook accepts only configured mailbox keys, a constant-time compared Bearer secret, bounded JSON payloads and idempotent provider event IDs. External content is stored as untrusted data and cannot become an instruction.
- Required structured fields: mission ID, agent ID, tool/action, timestamps, duration, token/cost summary, redacted input, result/error, retries, external action, approval reference, evidence, state changes and deployed version.

- [ ] Write failing tests for work-order validation, action hashing, approval expiry/replay/content binding, kill switch, webhook authentication/deduplication and mail allowlisting.
- [ ] Implement the minimum TypeScript broker and PostgreSQL repository interfaces to pass them.
- [ ] Expose the approved internal endpoints and structured observability fields.
- [ ] Keep mail and Telegram transports behind injectable adapters; tests use controlled fakes.

### Task 3: Native Hermes 0.20.1 Profiles

- Distribution location: `commercial-agent-swarm/profiles/<profile-id>/` with real `distribution.yaml`, `SOUL.md`, `config.yaml` and an optional profile-owned core skill; no pseudomanifest.
- Every manifest uses `hermes_requires: ">=0.20.1"`, version `0.1.0`, records author/license, lists only distribution-owned paths and declares `CUSTOM_API_KEY` without a value.
- Every config pins `deepseek-v4-flash` through the existing custom OpenAI-compatible provider, disables durable model memory, sets one concurrent session and bounded turns, uses explicit CLI toolsets, no MCP servers and no platform messaging toolsets.
- Tool ceilings: orchestrator may coordinate files/todos/delegation only; market and contact profiles may use public web research plus files; qualification, outreach and QA are local file/analysis only. No profile receives terminal, mail, CRM, Telegram, WhatsApp, payment, contract or admin tools.
- The active roster is exactly: `sales-orchestrator`, `market-account-intelligence`, `contact-data-steward`, `qualification-prioritization`, `outreach-draft-manager`, `commercial-qa-compliance`.
- Existing deferred prompt packages may remain as source documentation but must not appear in the active deployment roster or be installed.

- [ ] Retain exactly six active profiles: sales-orchestrator, market-account-intelligence, contact-data-steward, qualification-prioritization, outreach-draft-manager and commercial-qa-compliance.
- [ ] Add native `distribution.yaml`, prompts, config and least-privilege tool policies for each.
- [ ] Make A3 unavailable to all profiles and preserve A4 as human-only.
- [ ] Update the package validator and tests for the native roster and T01-T16 matrix.

### Task 4: Data Model, Director Migration and Infra Repository

- [ ] Add idempotent migrations for `catalog`, `control` and `mail` schemas plus versioned Proptimiza seed data.
- [ ] Preserve the now non-empty legacy approval/run tables and their existing rows; rename or expose compatibility views only after dependency analysis proves the change safe.
- [ ] Export and redact the old Director Sales evidence, classifying decisions, assumptions, evidence, obsolete configuration and pending work.
- [ ] Prepare a sanitized private `sales-platform-infra` repository with pinned Compose, Caddy, migrations and runbooks.

### Task 5: Isolated VPS Deployment

- Execution is split into two trust zones: the broker owns database, approval and mail capabilities but never runs an LLM; the Hermes executor owns only the OpenCode Go inference credential and never receives database, mail, Telegram, Docker or host credentials.
- Cross-profile dispatch uses a deterministic PostgreSQL-backed queue and a closed six-profile enum. The executor launches a separate, ephemeral `HERMES_HOME` copied from an immutable profile seed, with concurrency one and no model/provider/tool/prompt overrides.
- The executor uses the exact Hermes 0.20.1 image-verified `hermes -p <profile> -z <prompt> --usage-file <path>` path. It never uses unsupported `-q`/`--cli chat`, `--yolo`, `--accept-hooks`, native delegation, Docker socket or the `--oneshot` path that auto-bypasses approvals. Only the broker computes canonical artifact SHA-256 and persists results.
- Executor child processes run as a non-root UID with a filtered environment. Database and broker secrets stay in the root-owned deterministic adapter; OpenCode Go is the only credential passed to the child. `/proc/*/environ`, secret mounts and host paths remain unreadable.
- [ ] Create pre-deploy backup and validate Compose/migrations offline.
- [ ] Deploy the pinned `commercial-swarm` stack on a private network without Docker socket or host mounts.
- [ ] Apply migrations, seed the frozen offer/ICP/policies and install native profiles.
- [ ] Keep A3 kill switch active and verify health/readiness, resource limits, logs and rollback.

### Task 6: Simulation and Shadow Qualification

- [ ] Run all 16 scenarios for all six profiles plus broker/webhook security tests.
- [ ] Require 100% critical authorization/privacy/deduplication/security/schema checks and at least 95% evidence coverage.
- [ ] Start shadow mode with at most ten real public companies, no contact and no critical-system writes.
- [ ] Record human comparison decisions without promoting automatically.

### Task 7: Hostinger Mail, DNS and Telegram Preparation

- [ ] In hPanel, verify/create `contacto@proptimiza.com` and `ventas@proptimiza.com` with the user present.
- [ ] Verify MX/SPF/DKIM/DMARC, create `mailhooks.proptimiza.com`, configure Caddy TLS and a bearer-authenticated `message.received` webhook.
- [ ] Create mailbox-scoped Hostinger and dedicated Telegram bot secrets in the broker only.
- [ ] Restrict outbound mail to the internal mailbox and verify all secret-redaction controls.

### Task 8: Internal Mail Test and Final Gate

- [ ] Generate a neutral versioned internal message and QA verdict.
- [ ] Obtain one-time Telegram approval bound to exact sender, recipient, content, volume and expiry.
- [ ] Send once, receive one manual reply, verify webhook/threading/audit/idempotency and re-enable the A3 kill switch.
- [ ] Stop before any external pilot and report the separate approvals required.
