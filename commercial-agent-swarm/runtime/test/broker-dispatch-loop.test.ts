import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startDispatcherLoop } from '../src/broker-main.js'

describe('broker dispatch loop', () => {
  it('polls the wired dispatcher and closes the broker boundary on a fatal database error', async () => {
    let calls = 0
    let fatal: (() => void) | undefined
    const failed = new Promise<void>((resolve) => { fatal = resolve })
    const loop = startDispatcherLoop(
      {
        runOnce: async () => {
          calls += 1
          throw new Error('database details must stay inside the process')
        },
      },
      () => fatal?.(),
      100,
    )
    await failed
    await loop.close()
    assert.equal(calls, 1)
  })

  it('rejects an unsafe polling interval', () => {
    assert.throws(
      () => startDispatcherLoop({ runOnce: async () => false }, () => {}, 99),
      /DISPATCH_POLL_INTERVAL_INVALID/,
    )
  })
})
