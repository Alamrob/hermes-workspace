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
reservation always precedes credential acquisition and runner invocation; an unknown outcome is
held once for manual reconciliation and is never retried by this capability.
