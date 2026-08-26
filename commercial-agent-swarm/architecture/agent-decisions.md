# Agent Consolidation Decisions

The approved initial operating model needs separation where risk or evidence independence matters, and consolidation where volume is initially low.

| Candidate role                       | Decision    | Implemented owner                                      | Reason                                                                                                               |
| ------------------------------------ | ----------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1. Swarm Orchestrator                | Independent | Commercial Orchestrator                                | Authority, budgets, idempotency and coordination require one accountable control point.                              |
| 2. Market & Competition Research     | Combine     | Market & Account Intelligence                          | Market, competitor, account discovery and public signals share sources and are A1 research.                          |
| 3. Account Discovery                 | Combine     | Market & Account Intelligence                          | Same research lane; avoids separate lists without decision context.                                                  |
| 4. Contact Enrichment & Verification | Independent | Contact Data Steward                                   | Personal-data provenance, identity resolution, suppression and confidence need a distinct data-steward gate.         |
| 5. Signals & Intent                  | Combine     | Market & Account Intelligence; scored by Qualification | Discovery gathers signals; qualification interprets them. Separation prevents research from self-approving priority. |
| 6. Lead Scoring & Prioritization     | Independent | Qualification & Prioritization                         | Scoring rules, exceptions and calibration require explicit ownership.                                                |
| 7. Outreach Personalization          | Combine     | Outreach & Sequence Manager                            | Drafting and cadence must share content versions, frequency limits and reply state.                                  |
| 8. Sequence & Follow-up              | Combine     | Outreach & Sequence Manager                            | One owner prevents duplicate or conflicting contact. A3 remains approval-gated.                                      |
| 9. Inbound Qualification             | Combine     | Qualification & Prioritization                         | Uses the same qualification rubric, with source-specific SLA and consent rules.                                      |
| 10. Meeting Preparation              | Combine     | Meeting & Deal Copilot                                 | Meeting context and deal strategy use the same opportunity evidence.                                                 |
| 11. Proposal & Business Case         | Independent | Proposal & Business Case                               | Price, scope and ROI carry elevated commercial risk and require independent version/approval controls.               |
| 12. Deal Strategy & Closing          | Combine     | Meeting & Deal Copilot                                 | Low initial volume; human seller retains negotiation and commitments.                                                |
| 13. CRM & Revenue Operations         | Combine     | Revenue Operations & Analytics                         | CRM quality, pipeline definitions, forecast and analytics share authoritative data definitions.                      |
| 14. Onboarding                       | Combine     | Customer Lifecycle                                     | Low volume; one lifecycle owner avoids handoff fragmentation.                                                        |
| 15. Customer Success & Churn         | Combine     | Customer Lifecycle                                     | Same customer evidence and health model.                                                                             |
| 16. Renewal, Expansion & Referrals   | Combine     | Customer Lifecycle                                     | Activation only after customer volume and validated health signals.                                                  |
| 17. Voice of Customer                | Combine     | Customer Lifecycle                                     | Captured as evidence and fed to RevOps/Codex; no need for an autonomous role yet.                                    |
| 18. QA, Privacy & Compliance         | Independent | Commercial QA, Privacy & Compliance                    | Mandatory separation of duties before A3 actions and sensitive-data use.                                             |
| 19. Observability, Cost & Recovery   | Independent | Runtime Observability & Recovery                       | Must detect and stop failures independently from revenue-optimizing agents.                                          |
| 20. Forecast & Commercial Analytics  | Combine     | Revenue Operations & Analytics                         | No separate forecaster until pipeline volume and data quality justify it.                                            |

## Human-only functions

- Legal advice and acceptance of legal terms.
- Contract signature, payments and bank-account changes.
- Discounts outside approved policy.
- Unapproved commitments of scope, dates, guarantees or performance.
- Credential issuance, administrative permission changes and destructive data operations.
- Complaints, reputational incidents and sensitive negotiations unless a human explicitly approves a prepared response.

## Deferred separations

Create independent Forecast, Onboarding, Customer Success, Renewal/Expansion or Voice-of-Customer agents only when both conditions hold: at least 20 active records in the relevant stage per month and a measured queue/SLA conflict that the combined owner cannot meet for two consecutive review periods.
