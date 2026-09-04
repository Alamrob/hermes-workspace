import { TextDecoder } from 'node:util'
import type { Readable } from 'node:stream'

export const IPC_MAX_FRAME_BYTES = 1024 * 1024

export function encodeFrame(value: unknown, maxBytes = IPC_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.length === 0) throw new Error('IPC_FRAME_LENGTH')
  if (payload.length > maxBytes) throw new Error('IPC_FRAME_TOO_LARGE')
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32BE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

export async function readSingleFrame(
  stream: Readable & { destroy(error?: Error): unknown },
  maxBytes = IPC_MAX_FRAME_BYTES,
  timeoutMs = 30_000,
  requireEof = false,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs
    const chunks: Buffer[] = []
    let bytes = 0
    let declared: number | undefined
    let settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
      stream.off('close', onClose)
      if (error) reject(error); else resolve(value)
    }
    const fail = (code: string) => {
      const error = new Error(code)
      stream.destroy()
      finish(error)
    }
    const parseComplete = (all: Buffer) => {
      // Timers can be delayed by a paused event loop. An overdue frame must not
      // be accepted merely because its I/O callback ran before the timer.
      if (performance.now() >= deadline) return fail('IPC_FRAME_TIMEOUT')
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(all.subarray(4))
        finish(undefined, JSON.parse(text))
      } catch {
        fail('IPC_FRAME_JSON')
      }
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buffer)
      bytes += buffer.length
      const all = Buffer.concat(chunks, bytes)
      if (declared === undefined && bytes >= 4) {
        declared = all.readUInt32BE(0)
        if (declared === 0) return fail('IPC_FRAME_LENGTH')
        if (declared > maxBytes) return fail('IPC_FRAME_TOO_LARGE')
      }
      if (bytes > maxBytes + 4 || (declared !== undefined && bytes > declared + 4)) return fail('IPC_FRAME_TRAILING')
      if (!requireEof && declared !== undefined && bytes === declared + 4) parseComplete(all)
    }
    const onEnd = () => {
      const all = Buffer.concat(chunks, bytes)
      if (bytes < 4) return fail('IPC_FRAME_TRUNCATED')
      declared ??= all.readUInt32BE(0)
      if (declared === 0) return fail('IPC_FRAME_LENGTH')
      if (declared > maxBytes) return fail('IPC_FRAME_TOO_LARGE')
      if (bytes < declared + 4) return fail('IPC_FRAME_TRUNCATED')
      if (bytes > declared + 4) return fail('IPC_FRAME_TRAILING')
      parseComplete(all)
    }
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('IPC_FRAME_TRUNCATED'))
    const timer = setTimeout(() => fail('IPC_FRAME_TIMEOUT'), timeoutMs)
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    stream.once('close', onClose)
  })
}
