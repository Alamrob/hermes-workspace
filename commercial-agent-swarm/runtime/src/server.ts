import { createServer } from 'node:http'
import type { BrokerApplication } from './application.js'

export function createBrokerHttpServer(
  app: BrokerApplication,
  options: { maxBodyBytes: number },
) {
  return createServer((request, response) => {
    void (async () => {
      try {
        const rawBody = await readBoundedBody(request, options.maxBodyBytes)
        const path = new URL(request.url ?? '/', 'http://broker.local').pathname
        const isWebhook = path.startsWith('/webhooks/hostinger-mail/')
        const body = rawBody.length > 0 && !isWebhook ? JSON.parse(rawBody.toString('utf8')) : undefined
        const result = await app.handle({
          method: request.method ?? 'GET',
          path,
          headers: {
            authorization: request.headers.authorization,
            'x-agent-id': stringHeader(request.headers['x-agent-id']),
          },
          body,
          rawBody: isWebhook ? rawBody : undefined,
        })
        response.statusCode = result.status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(result.body))
      } catch (error) {
        response.statusCode = error instanceof PayloadTooLargeError ? 413 : 400
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'bad_request' }))
      }
    })()
  })
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large')
  }
}

async function readBoundedBody(
  request: AsyncIterable<Buffer | Uint8Array | string> & { headers: Record<string, unknown> },
  maximum: number,
): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > maximum) throw new PayloadTooLargeError()
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximum) throw new PayloadTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
