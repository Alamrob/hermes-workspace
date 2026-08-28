import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('commercial automation preflight CLI', () => {
  it('calls only the read-only preflight and emits a redacted fail-closed error', () => {
    const source = readFileSync(new URL('../src/commercial-automation-preflight-main.ts', import.meta.url), 'utf8')
    assert.match(source, /runCommercialAutomationPreflight/)
    assert.match(source, /AUTOMATION_PREFLIGHT_UNAVAILABLE/)
    assert.match(source, /external_actions.*0/)
    assert.doesNotMatch(source, /\.tick\(|createWorkOrder|createAssignments|addSignedComment|updateIssueStatus|mail\.send|A3/)
  })
})
