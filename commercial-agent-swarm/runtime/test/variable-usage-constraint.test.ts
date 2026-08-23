import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('variable authoritative usage constraint', () => {
  it('allows bounded variable reservations and prevents actual usage above the reservation', async () => {
    const sql = await readFile(new URL('../migrations/014_variable_usage_constraint.sql', import.meta.url), 'utf8')
    assert.match(sql, /usage_value_reservation_micro_cents BETWEEN 1 AND 10000000/)
    assert.match(sql, /usage_value_actual_micro_cents BETWEEN 1 AND usage_value_reservation_micro_cents/)
  })

  it('refuses rollback after variable reservation history exists', async () => {
    const sql = await readFile(new URL('../migrations/014_variable_usage_constraint.rollback.sql', import.meta.url), 'utf8')
    assert.match(sql, /VARIABLE_USAGE_HISTORY_PRESENT/)
    assert.match(sql, /usage_value_reservation_micro_cents<>10000000/)
    assert.match(sql, /version='014_variable_usage_constraint'/)
  })
})
