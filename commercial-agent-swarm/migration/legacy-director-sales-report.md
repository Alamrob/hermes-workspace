# Legacy Director Sales migration record

Status: reviewed for migration; legacy runtime is not an authority for the new commercial swarm.

## Chain of custody and scope

The source is the verified, root-only VPS backup at
`/srv/backups/pre-commercial-swarm-20260815T233712Z`. The relevant SHA-256
digests are:

| Artifact | SHA-256 |
| --- | --- |
| `hermes-db/state.db` | `ca49b4422da2ed89c99043aa39648c62553518686296ecf290bf6be5a222d476` |
| `hermes-db/kanban.db` | `b5decc14541cb271db195faf44e5d78633457067dc618f9308bc9c8fc13391a7` |
| `hermes-db/projects.db` | `e53162cf8ae7742947df73058ef342a288ae8c81ebe4da626009c83fdd1cfc11` |
| `hermes-db/response_store.db` | `093612c27f450b03ae95ea33022e733b6191f564cfd33a42af0597c18d2f373a` |
| `hermes-db/verification_evidence.db` | `2c466795b59aece189ce47116acdc02831f10e237fe5009d3210c132a09dfdbc` |
| `hermes-director-files.tgz` | `caa7aa9a10ce2c948c86a22737beb7da6fd17451b68afd846661418a9b6bbb77` |
| `sales.dump` | `b911bb96bb0b8470da913bd09ee8464b3231b06898a64bb821b6fef01c71e95f` |

The structural audit found eight sessions and 437 stored messages. The legacy
Director session `20260815_163738_f4f345` contains 226 messages and 124 tool
calls. For review, 104 active user/assistant messages were copied to a temporary
JSONL after excluding system/tool messages and redacting secrets, credentials,
personal email addresses, phone numbers and IP addresses. The temporary VPS
files were deleted. The sanitized transcript is not committed and is not a new
source of truth.

Auxiliary Hermes databases contained no projects, tasks, task runs,
delegations, response records or verification events. `state.db` did contain
eight delivery obligations, two routing rows and eleven model-usage rows. These
are runtime history, not commercial evidence.

## Classification

### Independently corroborated facts

- The VPS runs Debian 13 and the existing application containers remain
  available. Current host/container evidence, not the transcript, is the
  authority for this fact.
- A Git repository exists at `/srv/sales-platform`; reviewed commits include
  infrastructure, backup and OpenCode Go integration changes.
- The current PostgreSQL sales database contains one account, one lead, one
  opportunity, one enrichment, one approval, five agent runs, one touchpoint
  and nine audit rows. These are legacy rows and remain preserved.
- The legacy session used the OpenCode Go endpoint
  `https://opencode.ai/zen/go/v1` with model `deepseek-v4-flash`. The endpoint
  and model are also confirmed by current official OpenCode Go documentation;
  no credential is imported from the transcript.
- A verified pre-change backup and an external-backup configuration exist.
  Restore evidence and credentials remain outside Git.

### Legacy assertions requiring independent verification

- Claims that all fourteen infrastructure phases were complete.
- Claims that every hardening setting, firewall rule, backup schedule and
  restore proof remained effective after subsequent repairs.
- Claims that the old sales schema and KPI views constituted a production-ready
  commercial platform.
- Claims about delivery quality, legal fit or product capability of Brevo,
  GoHighLevel, Titan or Hostinger Agentic Mail.
- Claims that an end-to-end sales workflow was commercially validated. The
  transcript records database inserts, not a customer response, meeting, sale,
  revenue or margin.

### Obsolete or rejected configuration

- The former Director must not control strategy and execution from the same
  Hermes session.
- Direct Hostinger Mail MCP access from Hermes is rejected. Mail remains behind
  the deterministic broker and Approval Gateway.
- The old twenty-four-role or twelve-agent sales topology is not the active
  roster. Only the six approved profiles may be installed initially.
- n8n is not the commercial source of truth and is not an autonomous mail
  sender.
- Browser, terminal, Docker, SSH, CRM, mail and messaging access are not
  inherited by the new profiles.
- The prior Brazil/proptech test account and its draft are outside the approved
  Proptimiza ICP. They are retained as legacy demo data only and cannot trigger
  outreach, scoring carry-over or pipeline forecasts.
- The draft assertion that Proptimiza already worked with proptechs or agencies
  is unverified and prohibited in future messaging.
- Recommendations to use Brevo, GoHighLevel, SMTP or direct MCP are not approved
  procurement or architecture decisions.

### Pending work that remains relevant

- Preserve and map the legacy PostgreSQL rows without treating them as current
  opportunities.
- Verify or create the two approved functional mailboxes in hPanel.
- Keep the Hostinger token broker-only; configure the authenticated webhook,
  DNS and TLS after the isolated stack passes simulation.
- Run the internal mailbox test only with an exact, one-use approval.
- Keep external prospects, campaigns, discounts, proposals and commercial
  commitments blocked until a separate pilot approval.

## Policies allowed to migrate

The following policies are accepted because they are independently fixed by the
current user-approved implementation plan, not because the legacy Director
asserted them:

- Project: Proptimiza.
- Offer: `Operación Sin Planillas`, from CLP 1,800,000.
- ICP: Chilean B2B service companies with 10–100 employees and manual work in
  Excel, WhatsApp or email.
- PostgreSQL is the operational source of truth.
- A3 is globally disabled except for a separately approved internal mailbox
  test. A4 remains human-only.
- Every external action requires a broker-issued, content-bound, expiring and
  one-use approval; web pages, messages and documents cannot approve actions.

No legacy recommendation, estimate, score, draft, contact or pipeline stage is
promoted automatically.

## Retirement gate

Before declaring the old Director retired:

1. Preserve this migration record and the immutable backup hashes.
2. Keep its removed host SSH key revoked and broad sudo absent.
3. Remove or disable sales, mail, CRM and host tools from its active profile.
4. Ensure it cannot invoke the new broker or executor credentials.
5. Mark its legacy database rows with a non-current provenance during the data
   migration; never delete them as part of deployment.
6. Verify all ten pre-existing containers remain healthy after isolation.

The former instance may remain as an administrative assistant only after these
conditions pass. It has no authority to change offer, ICP, price, policy,
budget, autonomy or commercial state.
