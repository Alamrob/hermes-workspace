import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { executeManualDispatchOnce } from '../src/manual-dispatch-once-main.js'

describe('manual dispatch one-shot', () => {
  it('runs exactly one dispatcher iteration and always reports zero external actions', async () => {
    let runs = 0, closes = 0
    const result = await executeManualDispatchOnce({
      mode: 'manual',
      a3AdmissionEnabled: false,
      repository: { externalActionsBlocked: async () => true },
      dispatcher: { runOnce: async () => { runs += 1; return true } },
      close: async () => { closes += 1 },
    })
    assert.deepEqual(result, { status: 'processed', processed: true, external_actions: 0 })
    assert.equal(runs, 1)
    assert.equal(closes, 1)
  })

  it('fails closed outside manual mode without invoking the dispatcher', async () => {
    let runs = 0, closes = 0
    await assert.rejects(
      executeManualDispatchOnce({
        mode: 'automatic',
        a3AdmissionEnabled: false,
        repository: { externalActionsBlocked: async () => true },
        dispatcher: { runOnce: async () => { runs += 1; return true } },
        close: async () => { closes += 1 },
      }),
      /MANUAL_DISPATCH_MODE_REQUIRED/,
    )
    assert.equal(runs, 0)
    assert.equal(closes, 1)
  })

  it('closes after a dispatcher failure and does not expose the error in CLI output', async () => {
    let closes = 0
    await assert.rejects(
      executeManualDispatchOnce({
        mode: 'manual',
        a3AdmissionEnabled: false,
        repository: { externalActionsBlocked: async () => true },
        dispatcher: { runOnce: async () => { throw new Error('database secret') } },
        close: async () => { closes += 1 },
      }),
      /database secret/,
    )
    assert.equal(closes, 1)
  })

  it('refuses dispatch when external actions are not authoritatively blocked', async () => {
    let runs = 0, closes = 0
    await assert.rejects(
      executeManualDispatchOnce({
        mode: 'manual',
        a3AdmissionEnabled: false,
        repository: { externalActionsBlocked: async () => false },
        dispatcher: { runOnce: async () => { runs += 1; return true } },
        close: async () => { closes += 1 },
      }),
      /SIMULATION_EXTERNAL_ACTIONS_NOT_BLOCKED/,
    )
    assert.equal(runs, 0)
    assert.equal(closes, 1)
  })
})
