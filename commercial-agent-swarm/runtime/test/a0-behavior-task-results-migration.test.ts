import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const migration = new URL(
  '../migrations/039_a0_behavior_task_results.sql',
  import.meta.url,
)
const rollback = new URL(
  '../migrations/039_a0_behavior_task_results.rollback.sql',
  import.meta.url,
)

describe('A0 behavior durable task results migration', () => {
  it('creates an immutable six-result evidence boundary with zero external effects', async () => {
    const sql = await readFile(migration, 'utf8')
    assert.match(sql, /CREATE TABLE control\.a0_behavior_task_results/)
    assert.match(sql, /CREATE TRIGGER a0_behavior_task_results_immutable/)
    assert.match(sql, /external_actions integer NOT NULL CHECK\(external_actions=0\)/)
    assert.match(sql, /real_connector_calls integer NOT NULL CHECK\(real_connector_calls=0\)/)
    assert.match(sql, /agent_result jsonb NOT NULL CHECK\(jsonb_typeof\(agent_result\)='object'\)/)
    assert.match(sql, /UNIQUE\(run_id,batch_id,reservation_version,task_id\)/)
    assert.match(sql, /usage_record_id text NOT NULL UNIQUE/)
    assert.match(sql, /FOREIGN KEY\(run_id,batch_id,reservation_version\)/)
    assert.match(sql, /A0_TASK_RESULT_CONTRACT_DRIFT/)
    assert.match(sql, /A0_TASK_RESULT_IMMUTABLE_CONFLICT/)
  })

  it('exposes only record and settlement functions to the A0 capability', async () => {
    const sql = await readFile(migration, 'utf8')
    const grants = sql.slice(sql.lastIndexOf('GRANT EXECUTE ON FUNCTION'))
    assert.match(
      grants,
      /record_a0_behavior_task_result\(\s*uuid,text,bigint,uuid,uuid,text,text,boolean,text,text,jsonb,boolean,text,text,bigint,integer,integer\s*\)/,
    )
    assert.match(grants, /settle_a0_behavior_batch\(uuid,text,bigint,bigint,jsonb\)/)
    assert.match(grants, /TO commercial_a0_behavior_ledger/)
    assert.doesNotMatch(
      sql,
      /GRANT (SELECT|INSERT|UPDATE|DELETE|ALL) ON control\.a0_behavior_task_results/,
    )
    assert.doesNotMatch(grants, /enqueue_dispatch|mail\.|integration\./)
  })

  it('blocks settlement until all six exact task receipts are durable', async () => {
    const sql = await readFile(migration, 'utf8')
    assert.match(sql, /RENAME TO legacy_039_settle_a0_behavior_batch/)
    assert.match(sql, /result_count<>6 OR result_sum<>\$4/)
    assert.match(sql, /jsonb_array_length\(\$5\)<>6/)
    assert.match(sql, /result\.usage_record_id=receipt->>'usage_record_id'/)
    assert.match(sql, /A0_SETTLEMENT_REQUIRES_DURABLE_TASK_RESULTS/)
    assert.match(
      sql,
      /RETURN control\.legacy_039_settle_a0_behavior_batch\(\$1,\$2,\$3,\$4,\$5\)/,
    )
  })

  it('requires an empty contained ledger for migration and rollback', async () => {
    const [sql, undo] = await Promise.all([
      readFile(migration, 'utf8'),
      readFile(rollback, 'utf8'),
    ])
    assert.match(sql, /A0_TASK_RESULT_MIGRATION_REQUIRES_EMPTY_CONTAINED_LEDGER/)
    assert.match(sql, /EXISTS\(SELECT 1 FROM control\.a0_behavior_batch_ledger\)/)
    assert.match(undo, /A0_TASK_RESULT_ROLLBACK_REQUIRES_EMPTY_CONTAINED_LEDGER/)
    assert.match(undo, /EXISTS\(SELECT 1 FROM control\.a0_behavior_task_results\)/)
    assert.match(undo, /DROP TABLE control\.a0_behavior_task_results/)
    assert.match(
      undo,
      /ALTER FUNCTION control\.legacy_039_settle_a0_behavior_batch\(uuid,text,bigint,bigint,jsonb\)[\s\S]*RENAME TO settle_a0_behavior_batch/,
    )
    assert.doesNotMatch(undo, /DELETE FROM control\.a0_behavior_task_results/)
  })
})
