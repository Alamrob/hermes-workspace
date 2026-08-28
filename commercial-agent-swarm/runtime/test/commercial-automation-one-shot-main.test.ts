import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('commercial automation authorized one-shot CLI', () => {
  it('requires one exact stage and emits only a redacted fail-closed error', () => {
    const entry = readFileSync(new URL('../src/commercial-automation-one-shot-main.ts', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../src/commercial-automation-main.ts', import.meta.url), 'utf8')
    assert.match(entry, /runCommercialAutomationAuthorizedOneShot/)
    assert.match(entry, /AUTOMATION_ONE_SHOT_UNAVAILABLE/)
    assert.match(entry, /external_actions.*0/)
    assert.doesNotMatch(entry, /mail\.send|approval|token|crm/i)
    assert.match(main, /stage !== 'ALA-52' && stage !== 'ALA-53'/)
    assert.match(main, /config\.humanHold !== false/)
    assert.match(main, /runAuthorizedOneShot/)
  })
})
