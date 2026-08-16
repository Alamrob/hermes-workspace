import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('approval contract modes', () => {
  it('publishes the closed multichannel mode and evidence contract with either as default', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL('../../contracts/approval.schema.json', import.meta.url),
        'utf8',
      ),
    )
    assert.deepEqual(schema.properties.approval_mode, {
      type: 'string',
      enum: ['sales_only', 'telegram_only', 'either', 'dual_channel'],
      default: 'either',
    })
    assert.deepEqual(schema.properties.approval_evidence.items.required, [
      'channel',
      'decision',
      'actor_id',
      'decided_at',
    ])
    assert.deepEqual(schema.properties.approval_evidence.items.properties.channel.enum, [
      'sales',
      'telegram',
    ])
    assert.deepEqual(schema.properties.approval_evidence.items.properties.decision.enum, [
      'approved',
      'denied',
    ])
  })
})
