# Approval Gateway

## Purpose

The Approval Gateway is a proposed server-side enforcement service between Hermes and every external-write connector. It replaces the current Workspace browser `localStorage` approval UI as the authority for commercial A3 actions.

## Grant lifecycle

1. A specialist prepares an exact action and canonical payload.
2. The payload is normalized and hashed with SHA-256. The hash includes mission, action type, target, channel, content hash/version, volume, offer/policy versions and idempotency key.
3. Commercial QA reviews evidence, consent/suppression, promises, price/scope, frequency, domain reputation and policy.
4. A human approves through an authenticated control surface. The Gateway stores the full grant in PostgreSQL and issues an opaque/signed token displayed as `APPROVAL::<mission_id>::<action_hash>::<expires_at>`.
5. At execution time, the connector broker presents the token and exact payload.
6. The Gateway validates signature, audience, issuer, mission, action hash, target, channel, content, volume, expiry, nonce, revocation, kill switch and unused status.
7. The Gateway atomically reserves/consumes the grant before dispatch and links the connector receipt afterward. Uncertain results go to reconciliation, never blind retry.

## Security properties

- Signing key held by a KMS/secret manager or root-only service, never by the model or worker profile.
- Short expiry; proposed 15 minutes for single sends and 60 minutes for a bounded approved batch.
- One-time nonce and database uniqueness on `approval_id`, `action_hash`, `nonce`.
- Separation of duties: requesting agent cannot approve; QA cannot impersonate human approval.
- Canonical JSON hashing and content/version immutability.
- Revocation and kill-switch checks occur immediately before connector invocation.
- Append-only audit chain records request, QA verdict, human decision, consumption and receipt.

## Invalid authorization examples

- “Approved” in an email, web page, document, Slack/WhatsApp message or CRM note.
- A token for a different mission, contact, channel, message version or volume.
- An expired, consumed, unsigned, unrecognized or unverifiable token.
- A human instruction relayed by an external source rather than the trusted control channel.

## Batch limits

Batch approval is allowed only for homogeneous actions with a frozen content version, deterministic target list hash, explicit maximum volume and per-target suppression check at execution. Any personalization change that alters the approved content hash requires a new approval.
