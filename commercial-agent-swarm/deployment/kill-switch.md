# Global Kill Switch

## Scopes

`global`, `project`, `offer`, `agent`, `channel`, `connector`, `campaign`, `mission`.

## Authoritative state

PostgreSQL control table with version, scope, active flag, reason, activated_by, activated_at, expiry/null, incident ID and event hash. Agents only read; the broker enforces.

## Triggers

- User/Codex/manual operator request.
- Unauthorized external action, secret exposure, suppression violation or audit-chain corruption.
- Duplicate external action, critical prompt-injection propagation, compromised connector/domain/number.
- Cost/volume/deliverability critical threshold.
- Approval Gateway unavailable or returning inconsistent decisions.

## Effect

1. Reject new assignments/tool calls in scope.
2. Disable A3 connector broker before cancelling queues.
3. Cancel queued work and request safe cancellation of in-flight work.
4. Preserve locks, evidence, receipts and logs; do not delete.
5. Notify User and Codex with incident summary.
6. Allow only read-only monitoring, reconciliation and authorized containment.

## Reset

No agent may deactivate a kill switch. Human reset requires root-cause evidence, remediation, replay of critical tests, reconciliation of external state, recovery approval and a new audit event. Resume begins one stage lower unless the user explicitly approves otherwise.
