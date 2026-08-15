# Data Governance and Source of Truth

## Ownership by system

| Domain                                                                                           | Authoritative system                                               | Hermes role                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Accounts, contacts, leads, opportunities, activities, pipeline stages, owners                    | Approved CRM                                                       | Read through scoped adapter; propose/write only within A2/A3 policy.              |
| Consent, suppression, source provenance, identity clusters                                       | PostgreSQL/Supabase policy store, synchronized to CRM where needed | Check before contact; never override.                                             |
| Work orders, assignments, approvals, action hashes, audit events, evidence metadata, experiments | PostgreSQL/Supabase control database                               | Append/read through service; never keep a competing local truth.                  |
| Offer, ICP, price, message and proposal versions                                                 | Versioned commercial catalog approved by Codex/user                | Read exact version; stop on mismatch.                                             |
| Contracts and signatures                                                                         | Approved document-signing/contract repository                      | Read status/reference only; no legal modification or signature.                   |
| Invoices, payments and subscriptions                                                             | Billing/accounting system                                          | Read summarized status; no payments or bank changes.                              |
| Delivery and support                                                                             | Delivery/project/support system                                    | Read/write scoped tasks and status; customer commitments remain human-controlled. |
| Metrics and dashboards                                                                           | Derived warehouse/views over authoritative records                 | Calculate reproducibly; do not overwrite source facts.                            |

## Hermes memory

- Mission cache: work-order summary, artifact hashes, assignment state, last checkpoint and non-sensitive handoff. TTL: mission expiry plus 7 days, then archive/delete according to policy.
- Episodic memory: redacted operational lessons, not raw contact data or message bodies. Default retention: 30 days.
- Durable memory: stable agent role and approved process conventions only. No leads, credentials, consent decisions, prices or customer commitments.
- Never store secrets, cookies, tokens, passwords, private keys, sensitive personal data, full payment/contract data or unredacted authentication traces in model memory.

## Synchronization

1. Read authoritative record with `record_version`/`updated_at` and source ID.
2. Perform work against an immutable snapshot hash.
3. Before write, re-read version and suppression/approval state.
4. Use compare-and-swap or an idempotent API key.
5. Store receipt, before/after version and audit event.
6. On conflict, do not merge automatically; return `blocked` with both versions.

## Deduplication

- Account keys: canonical domain + country + tax/registry identifier when lawfully available.
- Contact keys: authoritative CRM ID; otherwise normalized verified email/phone plus account, with confidence.
- Lead keys: account/contact + offer + source event.
- External-action keys: `channel + normalized target + content hash + offer_id + policy window`.
- Uncertain clusters are quarantined for data-steward review; they are not treated as separate contactable leads.

## Freshness

Each source type has a policy-defined maximum age. Before A3, identity, contactability, consent/suppression, owner, message version and approval are always revalidated regardless of prior cache. Stale data can support a research hypothesis but not an external action.

## Retention and deletion

Retention is purpose-specific and encoded in the work order. A deletion/opposition request creates an immediate global suppression record, blocks new processing, removes derived/cached data where required, and preserves only the minimum audit proof legally permitted. Legal review controls exceptions.
