import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type {
  A0BatchAuthorization,
  A0CompiledBatchPlan,
} from '../src/a0-behavior-batch-admission.js'
import {
  A0BehaviorOneShotError,
  runA0BehaviorOneShot,
  type A0BehaviorOneShotDependencies,
  type A0BehaviorOneShotPreparedInvocation,
} from '../src/a0-behavior-one-shot-main.js'

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'
const BATCH_ID = `a0:${RUN_ID}:t01`
const NOW = new Date('2026-09-13T12:00:00.000Z')

function environment(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    COMMERCIAL_MODE: 'simulation',
    A3_ENABLED: 'false',
    HOSTINGER_MAIL_ENABLED: 'false',
    TELEGRAM_APPROVAL_ENABLED: 'false',
    EXTERNAL_RESEARCH_ENABLED: 'false',
    EXTERNAL_ACTION_KILL_SWITCH: 'true',
    DISPATCH_LOOP_MODE: 'manual',
    A0_BEHAVIOR_RUN_MODE: 'one_shot',
    A0_REAL_CONNECTORS_ENABLED: 'false',
    EXECUTOR_SOCKET_PATH: '/run/commercial-swarm/executor.sock',
    OPENCODE_USAGE_RECONCILIATION_ENABLED: 'true',
    A0_BEHAVIOR_PLAN_BUNDLE_FILE:
      '/run/proptimiza-a0-sealed/plan-bundle-0000000000000000',
    A0_BEHAVIOR_ARTIFACT_SNAPSHOT_FILE:
      '/run/proptimiza-a0-sealed/snapshot-00000000000000000000000000000000',
    A0_BEHAVIOR_BATCH_AUTHORIZATION_FILE:
      '/run/proptimiza-a0-sealed/authorization-0000000000000000',
    A0_BEHAVIOR_AUTHORITY_PUBLIC_KEY_FILE:
      '/run/proptimiza-a0-sealed/public-key-000000000000000000',
    A0_BEHAVIOR_LEDGER_DATABASE_URL_FILE:
      '/run/secrets/a0-behavior-ledger-database-url',
    A0_BEHAVIOR_AUTHORITY_PUBLIC_KEY_SHA256: 'a'.repeat(64),
  }
}

function prepared(): A0BehaviorOneShotPreparedInvocation {
  return {
    compiled: {
      run_id: RUN_ID,
      profile_bundle_sha256: 'b'.repeat(64),
    } as A0CompiledBatchPlan,
    authorization: { batch_id: BATCH_ID } as A0BatchAuthorization,
    authorizationVerifier: { verify: async () => true },
    artifactSnapshotVerifier: {
      verify: async () => ({
        status: 'verified',
        snapshot_sha256: 'c'.repeat(64),
      }),
    },
  }
}

function dependencies(
  events: string[],
  overrides: Partial<A0BehaviorOneShotDependencies> = {},
): A0BehaviorOneShotDependencies {
  return {
    createUsage: () => {
      events.push('usage-config')
      return {
        enabled: true,
        serviceAccountId: 'svcacct_a0_behavior',
        probe: {} as never,
      }
    },
    prepareInvocation: async () => {
      events.push('prepare')
      return prepared()
    },
    readDatabaseUrl: async () => {
      events.push('database-secret')
      return 'postgresql://a0@runtime/control'
    },
    createDatabase: () => {
      events.push('database-open')
      return {
        query: async () => {
          throw new Error('generic query not expected')
        },
        end: async () => {
          events.push('database-close')
        },
      } as never
    },
    runPrepared: async () => {
      events.push('run')
      return {
        status: 'settled',
        batch_id: BATCH_ID,
        reservation_version: 1,
      }
    },
    now: () => NOW,
    ...overrides,
  }
}

describe('A0 behavior one-shot main boundary', () => {
  it('rejects arguments, open channels, path reuse and raw secrets before IO', async () => {
    const cases: Array<[Record<string, string>, string[]]> = [
      [environment(), ['--retry']],
      [{ ...environment(), HOSTINGER_MAIL_ENABLED: 'true' }, []],
      [
        {
          ...environment(),
          A0_BEHAVIOR_BATCH_AUTHORIZATION_FILE:
            environment().A0_BEHAVIOR_PLAN_BUNDLE_FILE!,
        },
        [],
      ],
      [
        {
          ...environment(),
          A0_BEHAVIOR_LEDGER_DATABASE_URL:
            'postgresql://plaintext-secret',
        },
        [],
      ],
      [{ ...environment(), CUSTOM_API_KEY: 'plaintext-secret' }, []],
      [{ ...environment(), TELEGRAM_BOT_TOKEN: 'plaintext-secret' }, []],
      [{ ...environment(), OPENAI_API_KEY: 'plaintext-secret' }, []],
      [{ ...environment(), PGPASSWORD: 'plaintext-secret' }, []],
    ]
    for (const [env, argv] of cases) {
      const events: string[] = []
      await assert.rejects(
        runA0BehaviorOneShot(env, dependencies(events), argv),
        (error) => error instanceof A0BehaviorOneShotError,
      )
      assert.deepEqual(events, [])
    }
  })

  it('requires Usage reconciliation before reading sealed files or database credentials', async () => {
    const events: string[] = []
    await assert.rejects(
      runA0BehaviorOneShot(
        environment(),
        dependencies(events, {
          createUsage: () => {
            events.push('usage-config')
            return { enabled: false }
          },
        }),
      ),
      /A0_ONE_SHOT_USAGE_RECONCILIATION_REQUIRED/,
    )
    assert.deepEqual(events, ['usage-config'])
  })

  it('prepares and verifies the sealed invocation before reading database credentials', async () => {
    const events: string[] = []
    await assert.rejects(
      runA0BehaviorOneShot(
        environment(),
        dependencies(events, {
          prepareInvocation: async () => {
            events.push('prepare')
            throw new Error('SEALED_INPUT_REJECTED')
          },
        }),
      ),
      /SEALED_INPUT_REJECTED/,
    )
    assert.deepEqual(events, ['usage-config', 'prepare'])
  })

  it('executes exactly once and closes the database after a settled batch', async () => {
    const events: string[] = []
    const result = await runA0BehaviorOneShot(
      environment(),
      dependencies(events),
    )
    assert.deepEqual(events, [
      'usage-config',
      'prepare',
      'database-secret',
      'database-open',
      'run',
      'database-close',
    ])
    assert.deepEqual(result, {
      schema_version: 1,
      type: 'commercial_swarm_a0_batch_one_shot_result/v1',
      status: 'settled',
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      reservation_version: 1,
      retry_attempted: false,
      external_actions: 0,
      real_connector_calls: 0,
      crm_writes: 0,
    })
  })

  it('returns an idempotent replay without executing another batch', async () => {
    const events: string[] = []
    const result = await runA0BehaviorOneShot(
      environment(),
      dependencies(events, {
        runPrepared: async () => {
          events.push('run')
          return {
            status: 'reservation_replayed',
            reservation_state: 'settled',
            batch_id: BATCH_ID,
            reservation_version: 2,
          }
        },
      }),
    )
    assert.equal(result.status, 'reservation_replayed')
    assert.equal(result.reservation_state, 'settled')
    assert.equal(result.retry_attempted, false)
    assert.equal(events.filter((event) => event === 'run').length, 1)
  })

  it('closes the database when execution throws and does not retry', async () => {
    const events: string[] = []
    await assert.rejects(
      runA0BehaviorOneShot(
        environment(),
        dependencies(events, {
          runPrepared: async () => {
            events.push('run')
            throw new Error('EXECUTION_OUTCOME_UNKNOWN')
          },
        }),
      ),
      /EXECUTION_OUTCOME_UNKNOWN/,
    )
    assert.equal(events.filter((event) => event === 'run').length, 1)
    assert.equal(events.at(-1), 'database-close')
  })

  it('rejects outcome drift and still closes the database', async () => {
    const events: string[] = []
    await assert.rejects(
      runA0BehaviorOneShot(
        environment(),
        dependencies(events, {
          runPrepared: async () => ({
            status: 'settled',
            batch_id: `a0:${RUN_ID}:t02`,
            reservation_version: 1,
          }),
        }),
      ),
      /A0_ONE_SHOT_OUTCOME_INVALID/,
    )
    assert.equal(events.at(-1), 'database-close')
  })

  it('treats a close failure after success as an operational failure', async () => {
    const events: string[] = []
    await assert.rejects(
      runA0BehaviorOneShot(
        environment(),
        dependencies(events, {
          createDatabase: () =>
            ({
              query: async () => {
                throw new Error('unused')
              },
              end: async () => {
                throw new Error('close')
              },
            }) as never,
        }),
      ),
      /A0_ONE_SHOT_CLOSE_FAILED/,
    )
    assert.equal(events.filter((event) => event === 'run').length, 1)
  })

  it('rejects malformed database URLs after preparation but before opening a pool', async () => {
    const events: string[] = []
    await assert.rejects(
      runA0BehaviorOneShot(
        environment(),
        dependencies(events, {
          readDatabaseUrl: async () => {
            events.push('database-secret')
            return 'not-a-postgres-url'
          },
        }),
      ),
      /A0_ONE_SHOT_DATABASE_URL_INVALID/,
    )
    assert.deepEqual(events, [
      'usage-config',
      'prepare',
      'database-secret',
    ])
  })

  it('publishes closed JSON Schemas for both result channels', async () => {
    const successSchema = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/commercial-swarm-a0-batch-one-shot-result.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    assert.equal(successSchema.additionalProperties, false)
    assert.deepEqual(successSchema.required, [
      'schema_version',
      'type',
      'status',
      'run_id',
      'batch_id',
      'reservation_version',
      'retry_attempted',
      'external_actions',
      'real_connector_calls',
      'crm_writes',
    ])
    assert.deepEqual(Object.keys(successSchema.properties).sort(), [
      'batch_id',
      'crm_writes',
      'external_actions',
      'real_connector_calls',
      'reservation_state',
      'reservation_version',
      'retry_attempted',
      'run_id',
      'schema_version',
      'status',
      'type',
    ])
    assert.deepEqual(successSchema.properties.status.enum, [
      'settled',
      'budget_exceeded',
      'settlement_unconfirmed',
      'held_unknown',
      'reservation_replayed',
    ])
    assert.deepEqual(successSchema.allOf[0].then.required, [
      'reservation_state',
    ])
    assert.deepEqual(successSchema.allOf[0].else.not.required, [
      'reservation_state',
    ])
    const failureSchema = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/commercial-swarm-a0-batch-one-shot-failure.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    assert.equal(failureSchema.additionalProperties, false)
    assert.deepEqual(failureSchema.required, [
      'schema_version',
      'type',
      'status',
      'error_code',
      'retry_attempted',
      'external_actions',
      'real_connector_calls',
      'crm_writes',
    ])
    assert.equal(
      failureSchema.properties.type.const,
      'commercial_swarm_a0_batch_one_shot_failure/v1',
    )
    assert.equal(failureSchema.properties.status.const, 'failed')
    assert.equal(failureSchema.properties.retry_attempted.const, false)
  })
})
