import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('variable authoritative usage reservations', () => {
  it('reserves the signed assignment amount and enforces mission and activation ceilings with integer accounting', async () => {
    const sql = await readFile(
      new URL('../migrations/013_variable_usage_reservations.sql', import.meta.url),
      'utf8',
    )
    assert.match(sql, /requested_reservation:=round\(job\.usage_value_reservation_usd\*100000000\)::bigint/)
    assert.match(sql, /requested_reservation>guard\.run_ceiling_micro_cents/)
    assert.match(sql, /mission_committed\+requested_reservation>mission_limit/)
    assert.match(sql, /total_committed\+requested_reservation>guard\.activation_ceiling_micro_cents/)
    assert.match(sql, /usage_value_reservation_micro_cents=requested_reservation/)
    assert.match(sql, /usage_value_consumed_usd=requested_reservation::numeric\/100000000/)
    assert.doesNotMatch(sql, /usage_value_reservation_micro_cents=guard\.run_ceiling_micro_cents/)
  })

  it('restores the fixed reservation claim function and removes only its own migration record', async () => {
    const sql = await readFile(
      new URL('../migrations/013_variable_usage_reservations.rollback.sql', import.meta.url),
      'utf8',
    )
    assert.match(sql, /mission_committed\+guard\.run_ceiling_micro_cents>mission_limit/)
    assert.match(sql, /usage_value_reservation_micro_cents=guard\.run_ceiling_micro_cents/)
    assert.match(sql, /WHERE version='013_variable_usage_reservations'/)
    assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/)
  })
})
