# Handoff Protocol

## Envelope

Every handoff is an `assignment` with `mission_id`, `trace_id`, `assignment_id`, upstream/downstream agent IDs, objective, allowed/prohibited actions, input artifact hashes, prerequisites, expected output, SLA, budget allocation, autonomy ceiling and checkpoint contract.

The receiver must revalidate the parent work order. A handoff never inherits unstated permissions and cannot raise autonomy.

## Canonical handoffs

| From                           | To                               | Required evidence                                                                   | Exit criterion                                                       |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Orchestrator                   | Market & Account Intelligence    | Valid work order, project/offer/ICP versions, source policy                         | Bounded account/market facts with provenance and exclusions.         |
| Market & Account Intelligence  | Contact Data Steward             | Account IDs, fit rationale, source URLs/IDs, freshness                              | Identity-resolved contacts or explicit no-match with confidence.     |
| Contact Data Steward           | Qualification & Prioritization   | Verified contact/account, provenance, suppression/consent state                     | Score with factor contributions, disqualifiers and next action.      |
| Qualification & Prioritization | Outreach & Sequence Manager      | Approved segment, qualification evidence, permitted channel                         | Draft/content version and cadence proposal; no send unless A3.       |
| Outreach & Sequence Manager    | QA/Compliance                    | Exact target, channel, content hash/version, timing, consent and suppression checks | `allow`, `deny`, or `approval_required` with findings.               |
| QA/Compliance                  | Approval Gateway                 | QA allow verdict plus exact proposed action                                         | Valid one-time approval grant or denial.                             |
| Outreach & Sequence Manager    | Meeting & Deal Copilot           | Grounded response/meeting, CRM IDs and interaction evidence                         | Meeting brief or deal-risk handoff.                                  |
| Meeting & Deal Copilot         | Proposal & Business Case         | Discovery evidence, economic buyer, decision process, approved price catalog        | Draft proposal/business case with assumptions and approval needs.    |
| Proposal & Business Case       | QA/Compliance                    | Exact artifact hash, offer/price/scope versions and sources                         | External-delivery approval request or blocked result.                |
| Any commercial agent           | Revenue Operations & Analytics   | Schema-valid result, authoritative record IDs, action/evidence hashes               | Validated reversible internal update or metric refresh.              |
| Revenue Operations & Analytics | Customer Lifecycle               | Closed-won evidence, contract/billing references and success criteria               | Onboarding plan and accountable owner.                               |
| Customer Lifecycle             | Codex via Orchestrator           | Adoption, health, risk, VOC and renewal evidence                                    | Recommendation; A3 communication remains gated.                      |
| Any agent                      | Runtime Observability & Recovery | Error/latency/cost/log evidence                                                     | Alert, bounded retry, pause, rollback recommendation or kill switch. |

## Checkpoints

Workers return `completed`, `partial`, `blocked`, `failed` or `approval_required`. A checkpoint includes exact evidence, actions, cost, errors, risks and next action. The Orchestrator may continue only when prerequisites and hashes still match.

## Timeouts and retries

- Read-only transient errors: maximum 2 retries with exponential backoff and jitter.
- External write: no automatic retry unless the connector proves idempotency and the same action hash has no success receipt; otherwise stop for reconciliation.
- Authentication, authorization, policy, consent, suppression, budget, volume, CAPTCHA and prompt-injection events: zero automatic retries.
- Stale assignment or expired parent order: cancel and request a new order.

## Conflict resolution

Authoritative systems win over Hermes memory. If two authoritative sources conflict, stop the affected branch, preserve both facts, lower confidence and request RevOps/Codex review. Agents may not select the commercially convenient value.
