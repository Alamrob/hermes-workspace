# Observability Alerts

| Alert                   | Trigger                                                  | Severity      | Automatic response                          | Human/Codex response                 |
| ----------------------- | -------------------------------------------------------- | ------------- | ------------------------------------------- | ------------------------------------ |
| Unauthorized action     | External attempt without exact valid grant               | Critical      | Global A3 kill; preserve evidence           | Immediate incident review            |
| Duplicate contact/write | Same action/target policy key already pending/succeeded  | Critical      | Block action and lock target                | Reconcile records                    |
| Secret exposure         | Secret pattern or auth material in output/log            | Critical      | Stop affected agent/connectors; revoke path | Rotate through human runbook         |
| Prompt injection        | Injection risk from external content                     | High/Critical | Quarantine source; pause branch             | QA review; global hold if propagated |
| Suppression violation   | Suppressed target enters contact path                    | Critical      | Block and project/channel kill              | Privacy incident review              |
| Cost anomaly            | 2× rolling median or 80% budget                          | High          | Throttle/pause noncritical work             | Approve reduced scope or stop        |
| Loop                    | Three identical state/action hashes without progress     | High          | Cancel assignment                           | Diagnose prompt/tool/dependency      |
| Error spike             | >10% tool errors in 15 min or 3 auth failures            | High          | Circuit breaker                             | Connector/runtime owner review       |
| Missing receipt         | External attempt no definitive receipt within SLA        | High          | Hold target; reconciliation only            | Manual provider check                |
| Deliverability decline  | Bounce >3%, complaint >0.1%, or provider critical health | Critical      | Channel kill                                | Domain/number remediation            |
| Negative response spike | >20% negative/opt-out in pilot cohort                    | High          | Pause sequence                              | Offer/ICP/message review in Codex    |
| Data inconsistency      | Authoritative version conflict or audit hash break       | Critical      | Block writes                                | RevOps/security review               |
| Credential health       | Expiry/revocation/auth anomaly                           | Critical      | Disable connector                           | Human secret rotation                |

Thresholds are proposed gates and require approval/tuning before production. Stricter provider/legal thresholds prevail.
