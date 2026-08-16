export async function readBoundedHttpBody(
  response: Response,
  maximumBytes: number,
  tooLargeCode: string,
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximumBytes)
      throw new Error(tooLargeCode)
  }
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel(tooLargeCode)
        throw new Error(tooLargeCode)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } finally {
    reader.releaseLock()
  }
}
