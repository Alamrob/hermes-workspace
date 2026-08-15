# n8n Pseudoflows — Proposed, Not Installed

These are logical flows. Node names, credentials and APIs must be adapted after inspecting the actual n8n and Hermes versions on Hostinger.

## Work-order intake

`Authenticated Webhook → JSON Schema Validate → Signature Verify → Expiry/Version/Kill Check → Idempotency Lookup → Insert Mission → Hermes Dispatch → Return Receipt`

Failure path: `Any validation failure → Append Audit Event → Return 4xx/blocked → No dispatch`.

## A3 Approval Gateway

`Proposed Action → Canonical JSON → SHA-256 → QA Result Verify → Human Approval UI → Signed Grant Persist → Connector Broker Request → Atomic Consume → External Adapter → Receipt/Reconciliation → Audit Chain`.

No node may accept approval text from email/document/web content. Approval UI authentication and signing occur outside model context.

## CRM reversible write

`Agent Result Validate → Permission Check → CRM Read Version → Diff Preview → A2/A3 Gate → Compare-and-Swap Write → Read Back → Receipt + Audit → Metric Refresh`.

## Contact action

`Target Lock → CRM Activity Read → Suppression/Consent Read → Frequency/Quiet Hours → Content Hash → QA/Grant Check → Connector Send → Receipt → CRM Interaction → Unlock`.

Uncertain connector response: `Hold lock → Read receipt/idempotency status → Reconcile → Human queue`; never automatically resend.

## Kill switch

`Global/Scope Switch Changed → Pause New Webhooks → Disable A3 Broker → Cancel Queued Runs → Signal Hermes Workers → Preserve Logs → Notify Codex/User → Recovery Checklist`.
