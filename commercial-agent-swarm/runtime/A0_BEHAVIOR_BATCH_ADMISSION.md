# A0 behavior batch admission

`createA0BehaviorBatchAdmission` is an inert, dependency-injected capability exported from
`src/runtime-entrypoints.ts`. Importing or constructing it does not read credentials, reserve
credit, start a timer, call a model, or spawn a process. This change intentionally provides no
production runner, command, HTTP route, scheduler, or startup wiring.

The compiler accepts the prepared 6 x 16 source plan only together with an exact sealed artifact
snapshot. The snapshot binds all 96 fixture files and 24 profile files to byte counts, SHA-256
digests, and opaque `a0-sealed:` handles. Admission requires an injected snapshot verifier to
attest those handles before authorization or budget reservation.

Admission synchronously copies and deeply freezes the complete authorization-bearing plan before
its first asynchronous boundary. Only dense plain-JSON arrays and objects are accepted: accessors,
proxies, custom prototypes, exotic values, sparse indices, and a verifier result other than the
primitive boolean `true` fail closed. Every verifier, ledger, credential, runner, settlement, and
hold call is then derived exclusively from that stable snapshot.

One explicit admission call can target one exact six-task batch. Its dedicated contract fixes each
task to A0, 4096 tokens, one model call, one attempt, no runtime tools, no real connectors, and a
USD 0.01 reservation (1,000,000 microcents). The full plan is 96,000,000 microcents. A created
reservation always precedes credential acquisition and runner invocation. A database-authoritative,
expiry-aware execution permit is checked immediately before credential acquisition and again
immediately before spawn; denial holds the reservation and no provider process starts. An unknown
outcome is held once for manual reconciliation and is never retried by this capability.

`createA0BehaviorAuthorityAdapters` composes the optional production boundaries without enabling
them. Construction performs no database or filesystem I/O. `PostgresA0BehaviorLedger` exposes
only five fixed PostgreSQL functions from migration 038 (reserve, execution permit, settle, one
exact settlement read, and hold) and verifies the exact
`proptimiza_a0_behavior_ledger_login` function-only principal before use. The separate
`scripts/provision-a0-behavior-ledger-principal.sql` template creates that secret-free LOGIN,
removes effective database TEMP through the PUBLIC grant, and grants only the capability role;
authentication secrets remain a deployment-boundary responsibility.
`PosixA0ArtifactSnapshotVerifier` resolves opaque handles only below
`/run/proptimiza-a0-sealed`, reusing the root-owned, group-0440, one-link, `O_NOFOLLOW` reader and
then comparing the exact canonical snapshot bytes and every artifact byte count and SHA-256.

The append-only PostgreSQL ledger permits sixteen 6,000,000-microcent reservations per run and a
96,000,000-microcent run ceiling. It admits at most one active A0 batch globally, excludes A0 and
A1 attempts from coexisting, and counts both authorities against the shared 1,000,000,000-
microcent activation ceiling under one lock order. An expired reservation becomes
`held_unknown` and activates shared quarantine. A later exact known result supersedes only that
expiry hold with a new append-only terminal version, records the immutable shared receipt and full
audit evidence, and retains quarantine. Usage above a batch reservation becomes
`budget_exceeded` and also activates shared quarantine. If the
settlement response is lost, admission performs one exact read, then returns the confirmed state
or `settlement_unconfirmed`; it performs no second mutation. A shared immutable receipt registry
keys provider plus usage-record ID and binds authority, value, and fingerprint so the same receipt
cannot be consumed across A0 and A1. Migration 038 also wraps future A1 claim, activation, and
settlement paths to enforce these shared invariants; its empty-ledger rollback restores all three
retained functions and their prior grants. None of these adapters is wired into a startup, timer,
scheduler, CLI, route, credential provider, or process runner.
