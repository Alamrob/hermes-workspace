# End-to-End Commercial Workflow

```text
Codex WorkOrder
→ Orchestrator validation
→ market/account research
→ contact verification
→ qualification
→ outreach draft
→ QA
→ human approval token
→ exact external action
→ response/meeting
→ deal copilot
→ proposal draft
→ QA/human approval
→ human negotiation/signature
→ RevOps closed-won verification
→ customer lifecycle
→ renewal/expansion recommendation
→ Codex audit
```

| Transition              | Entry event                  | Mandatory data                                  | Exit evidence                   | Human gate                  | Timeout       | Exception                 |
| ----------------------- | ---------------------------- | ----------------------------------------------- | ------------------------------- | --------------------------- | ------------- | ------------------------- |
| Work order → plan       | Authenticated order received | IDs, versions, authority, scope, limits, policy | Validation receipt + DAG        | No, unless invalid strategy | 5 min         | Return blocked to Codex   |
| Plan → research         | Assignment ready             | ICP/segment/exclusions/sources                  | Facts/accounts/provenance       | No                          | 4 h           | Partial with gaps         |
| Research → contact      | Candidate account            | Account ID/domain/country/facts                 | Verified/no-match/quarantine    | Sensitive/new source        | 4 h           | QA/Data Steward hold      |
| Contact → qualification | Verified record              | Provenance/freshness/suppression/model          | Score/tier/next action          | Scoring change              | 60 min batch  | No-score/block            |
| Qualification → draft   | Eligible tier                | Facts permitted/channel/policy                  | Versioned draft/cadence/hash    | No send                     | 60 min        | Return data gap           |
| Draft → A3              | Exact action                 | Target/content/policy/QA                        | Approval grant                  | Mandatory human             | Grant expiry  | Deny/new version          |
| A3 → response           | Grant consumed               | Lock/recheck/connector receipt                  | Interaction/receipt             | Already granted             | Immediate     | Reconcile, no blind retry |
| Response → meeting      | Relevant response/booking    | CRM IDs/meeting/evidence                        | Brief/questions/risks           | Human runs meeting          | 30 min        | Anchor gap                |
| Discovery → proposal    | Discovery criteria met       | Problem/priority/buyer/process/success          | Proposal/business case hash     | Price/scope/external send   | 2 h           | Block missing input       |
| Proposal → close        | Human-led negotiation        | Approved terms/artifact                         | Contract/signature/billing refs | Human A4                    | Per deal      | Lost/on-hold reason       |
| Won → onboarding        | Authoritative closed-won     | Contract/scope/success/owner                    | Onboarding plan                 | Customer comm A3            | 1 day         | Contract conflict block   |
| Active → renew/expand   | Health/adoption evidence     | Model/renewal/risks/VOC                         | Recommendation/draft            | A3/A4 as applicable         | Policy window | Pause on incident         |
