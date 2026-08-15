# Rollback and Recovery Procedure

## Before deployment

- Pin commit/image digests and record config hashes.
- Back up roster/profiles/policies/control DB and test restore.
- Keep previous images/configs available.
- Separate schema migrations from profile/prompt deployment; migrations need tested down/forward recovery.

## Rollback order

1. Activate appropriate kill-switch scope and disable A3 broker.
2. Stop new dispatch; preserve in-flight receipts and locks.
3. Snapshot logs/control DB and reconcile every uncertain external action.
4. Restore previous prompt/roster/policy versions or previous container images.
5. Restore database only when necessary; prefer forward correction to avoid losing audit history.
6. Probe health/capabilities; run critical simulation suite.
7. Keep external actions disabled until Codex/user approve recovery.

## Non-reversible external effects

Sent messages, delivered proposals and calendar invitations cannot be rolled back as if they never happened. Record them, stop follow-up, and let a human decide correction/apology. Never send an automatic correction without a new A3 approval.
