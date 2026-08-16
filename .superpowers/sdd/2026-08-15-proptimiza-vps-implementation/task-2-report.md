# Task 2 report — Runtime Contracts and Approval Broker

## Scope

Completed the standalone TypeScript runtime at `commercial-agent-swarm/runtime/` and
resolved the final compiler errors without changing endpoint or broker behavior.

## Inherited TDD cycles

The task arrived with the broker implementation and its original test cycles already
present: work-order validation, canonical hashing, approval expiry/replay/content
binding and kill-switch handling, webhook authentication/deduplication, mail
allowlisting, and application HTTP routing. The inherited suite initially had 18
passing tests.

For the additional safe type boundary required by this fix:

1. **Red:** added `rejects a metadata value that is not an object` to
   `test/contracts.test.ts`. The test failed as intended with `Missing expected
   exception`, demonstrating that the optional field was allowed but not validated.
2. **Green:** declared `metadata?: Record<string, unknown>` on `WorkOrder` and
   applied the existing object validation rule to `metadata`. The complete suite
   then passed with 19 tests.
3. **Refactor/type safety:** extracted an internal common approval-record shape,
   leaving request records limited to `pending | denied` and grants to `approved`.
   That restores TypeScript's discriminated-union narrowing while preserving the
   runtime states. The HTTP body reader now depends on the standard global
   `AsyncIterable` contract instead of the nonexistent `NodeJS.AsyncIterableIterator`.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm --ignore-workspace run typecheck` (baseline) | Failed with the three reported sources: missing `WorkOrder.metadata`, unsafe approval union access, and nonexistent `NodeJS.AsyncIterableIterator`. |
| `pnpm --ignore-workspace test -- test/contracts.test.ts` (red) | Failed 1/19 as expected: malformed `metadata` was accepted. |
| `pnpm --ignore-workspace test` | Passed: 19 tests, 0 failures. |
| `pnpm --ignore-workspace run typecheck` | Passed: `tsc --noEmit -p tsconfig.json` exit 0. |
| `pnpm --ignore-workspace run audit:commercial-swarm` (repository root) | Passed: 0 errors, 0 warnings. |
| `git diff --cached --check` | Passed: no whitespace errors. |

## Files

- `commercial-agent-swarm/runtime/src/work-orders.ts`
- `commercial-agent-swarm/runtime/src/repository.ts`
- `commercial-agent-swarm/runtime/src/server.ts`
- `commercial-agent-swarm/runtime/test/contracts.test.ts`
- `.superpowers/sdd/2026-08-15-proptimiza-vps-implementation/task-2-report.md`

## Decisions and risks

- `metadata` is accepted only when it is a non-array object, matching its use as
  a property bag for the A3 flag and avoiding an unsafe cast.
- Approval request and grant states are represented as a true discriminated union;
  consumption can only read grant-only fields after checking `status === 'approved'`.
- The HTTP reader's structural type permits the chunk values normalized by its
  existing `Buffer.from` handling.
- No endpoint, policy, persistence behavior, or transport behavior was changed.
- Self-review and an independent scope-limited review found no Critical,
  Important, or Minor findings.
- Residual risk: this task uses the in-memory repository supplied by the runtime
  tests; a production PostgreSQL adapter must preserve the same atomic
  compare-and-consume contract.
