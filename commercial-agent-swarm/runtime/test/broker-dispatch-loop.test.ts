import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  configureDispatcherBeforeListen,
  startDispatcherLoop,
} from '../src/broker-main.js'

describe('broker dispatch loop', () => {
  it('does not open the HTTP listener when dispatcher configuration is invalid', async () => {
    let listens = 0
    await assert.rejects(
      configureDispatcherBeforeListen(
        () => { throw new Error('OPENCODE_USAGE_TOKEN_FILE_INVALID') },
        async () => { listens += 1 },
      ),
      /OPENCODE_USAGE_TOKEN_FILE_INVALID/,
    )
    assert.equal(listens, 0)
  })

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
