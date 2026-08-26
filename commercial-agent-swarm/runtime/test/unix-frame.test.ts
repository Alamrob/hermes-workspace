import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { encodeFrame, readSingleFrame } from '../src/unix-frame.js'

describe('bounded Unix IPC frame', () => {
  it('encodes one uint32be length-prefixed JSON value', () => {
    const frame = encodeFrame({ ok: true }, 1024)
    assert.equal(frame.readUInt32BE(0), 11)
    assert.equal(frame.subarray(4).toString('utf8'), '{"ok":true}')
  })

  it('rejects oversized, zero, truncated, trailing, and malformed frames', async () => {
    for (const [bytes, code] of [
      [Buffer.from([0, 0, 0, 0]), 'IPC_FRAME_LENGTH'],
      [Buffer.from([0, 0, 8, 1]), 'IPC_FRAME_TOO_LARGE'],
      [Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('{}')]), 'IPC_FRAME_TRUNCATED'],
      [Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from('{}x')]), 'IPC_FRAME_TRAILING'],
      [Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('{')]), 'IPC_FRAME_JSON'],
    ] as const) {
      const stream = new PassThrough()
      stream.end(bytes)
      await assert.rejects(readSingleFrame(stream, 8, 100), new RegExp(code))
    }
  })

  it('times out a frame that never completes and destroys the stream', async () => {
    const stream = new PassThrough()
    stream.write(Buffer.from([0, 0, 0, 2, 0x7b]))
    await assert.rejects(readSingleFrame(stream, 8, 5), /IPC_FRAME_TIMEOUT/)
    assert.equal(stream.destroyed, true)
  })

  it('waits for EOF in strict one-request mode and rejects a delayed trailing chunk', async () => {
    const stream = new PassThrough()
    const pending = readSingleFrame(stream, 1024, 100, true)
    stream.write(encodeFrame({ ok: true }))
    await new Promise(resolve => setImmediate(resolve))
    stream.end(Buffer.from('trailing'))
    await assert.rejects(pending, /IPC_FRAME_TRAILING/)
  })
})
