# Gradual Activation Plan

## Stage 1 — Simulation

- Synthetic data only; Internet and all connector adapters disabled.
- All 16 tests per agent plus end-to-end, approval, idempotency, rollback and kill-switch suites.
- 100% schema-valid outputs; 100% critical security/authorization/privacy/dedup tests pass; zero tool outside policy; evidence coverage ≥95%; no unbounded loop.
- Advance only after Codex audit and user approval.

## Stage 2 — Shadow Mode

- Real authorized data and A1 research may be allowed only after source approval; no external writes/contact.
- Compare agent recommendations against human decisions for at least 30 decision units or 2 weeks, whichever is longer.
- Promotion: ≥90% decision agreement on non-subjective gates; 100% suppression/consent detection; ≥95% evidence completeness; ≤5% material correction; budget within 110% of planned; zero critical incidents.
- Regress on any critical failure or two consecutive review periods below threshold.

## Stage 3 — Approved Pilot

- One project: proposed initial candidate Proptimiza; one frozen offer, ICP, country and channel; final choice requires user approval.
- Maximum 10 external targets total and one A3 action per target initially. Every action has QA plus one-time human approval.
- Promotion after minimum 30 executed actions or 4 weeks: 100% authorized/receipted, 0 duplicates/suppression violations, bounce <3%, complaint <0.1%, opt-out and negative rates within approved guardrails, ≥95% CRM/audit reconciliation, ≤5% material human correction, no critical incident, cost within budget.
- Do not promote from response rate alone.

## Stage 4 — Controlled Production

- Only validated flows/channels; versioned offers/messages; explicit daily/weekly cost and volume caps; permanent monitoring, rollback and quarterly Codex audit.
- Reduce per-action approval only by action class after at least 100 clean homogeneous actions, 60 days with zero critical incidents, ≥99% authorization/audit completeness, stable deliverability and user approval. New domain/channel/offer/ICP returns to Stage 2/3 gates.
- Maximum autonomy remains A3; A4 stays human-only.

## Regression rules

Immediate one-stage regression for metric breach sustained over one review window; immediate Stage 1/disabled A3 for unauthorized action, suppression violation, secret leak, audit corruption, duplicate send, compromised domain/number or failed kill switch.
