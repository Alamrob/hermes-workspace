import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('failed dependency terminalization', () => {
  it('fails only queued descendants of terminal non-success jobs and records an event', async () => {
    const sql = await readFile(
      new URL(
        '../migrations/012_dependency_terminalization.sql',
        import.meta.url,
      ),
      'utf8',
    )
    assert.match(sql, /child\.status='queued'/)
    assert.match(sql, /parent\.status IN\('failed','budget_exceeded'\)/)
    assert.match(sql, /usage_budget_state='released'/)
    assert.match(sql, /usage_value_consumed_usd=0/)
    assert.match(sql, /DEPENDENCY_TERMINAL_NON_SUCCESS/g)
    assert.match(sql, /EXIT WHEN batch_count = 0/)
    assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE|DROP TABLE/)
  })

  it('blocks schema rollback after terminalization history exists', async () => {
    const sql = await readFile(
      new URL(
        '../migrations/012_dependency_terminalization.rollback.sql',
        import.meta.url,
      ),
      'utf8',
    )
    assert.match(sql, /ROLLBACK_BLOCKED_DEPENDENCY_TERMINALIZATION_HISTORY/)
    assert.match(sql, /DEPENDENCY_TERMINAL_NON_SUCCESS/)
  })
})
