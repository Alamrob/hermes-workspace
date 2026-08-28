import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeCommercialAutomationError,
  reportCommercialAutomationError,
} from '../src/commercial-automation-main.js'

describe('commercial automation error observability', () => {
  it('preserves only explicitly allowlisted dependency and workflow codes', () => {
    assert.equal(normalizeCommercialAutomationError(new Error('PAPERCLIP_HTTP_503')), 'PAPERCLIP_HTTP_503')
    assert.equal(normalizeCommercialAutomationError(new Error('BROKER_UNAVAILABLE')), 'BROKER_UNAVAILABLE')
    assert.equal(
      normalizeCommercialAutomationError(new Error('AUTOMATION_PREDECESSOR_RESULT_INVALID')),
      'AUTOMATION_PREDECESSOR_RESULT_INVALID',
    )
  })

  it('redacts unknown errors rather than logging their messages or coercing arbitrary values', () => {
    const secret = 'Bearer secret-that-must-never-be-logged'
    assert.equal(normalizeCommercialAutomationError(new Error(secret)), 'AUTOMATION_UNEXPECTED_ERROR')
    assert.equal(normalizeCommercialAutomationError({ toString: () => { throw new Error(secret) } }), 'AUTOMATION_UNEXPECTED_ERROR')
  })

  it('emits one bounded structured event with no raw message, stack or payload', () => {
    const lines: string[] = []
    reportCommercialAutomationError(new Error('token=highly-sensitive'), (line) => lines.push(line))
    assert.equal(lines.length, 1)
    const event = JSON.parse(lines[0]) as Record<string, unknown>
    assert.deepEqual(Object.keys(event).sort(), [
      'component', 'error_code', 'event', 'external_actions', 'schema_version',
    ])
    assert.equal(event.error_code, 'AUTOMATION_UNEXPECTED_ERROR')
    assert.equal(event.external_actions, 0)
    assert.doesNotMatch(lines[0], /highly-sensitive|token=|stack|message/i)
    assert.ok(Buffer.byteLength(lines[0]) < 512)
  })
})
