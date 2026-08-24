const EXACT_ORIGIN = 'http://external-action-broker:8091'
const RESPONSE_LIMIT = 65_536

export class ExternalActionBrokerClient {
  constructor(private readonly options: {
    baseUrl: string
    readBearer: () => Promise<string>
    fetch?: typeof fetch
    timeoutMs?: number
  }) {
    const parsed = new URL(options.baseUrl)
    if (parsed.origin !== EXACT_ORIGIN || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password)
      throw new Error('EXTERNAL_ACTION_BROKER_ORIGIN_INVALID')
  }

  async isBlocked(input: { mailbox: string; recipient: string }): Promise<boolean> {
    const value = await this.request('/internal/v1/mail/block-status', input)
    if (!record(value) || typeof value.blocked !== 'boolean' || Object.keys(value).length !== 1)
      throw new Error('EXTERNAL_ACTION_BROKER_RESPONSE_INVALID')
    return value.blocked
  }

  async sendInternal(input: {
    missionId: string
    mailbox: 'ventas@proptimiza.com'
    recipient: 'contacto@proptimiza.com'
    subject: string
    content: string
    idempotencyKey: string
  }): Promise<{ receipt_id: string }> {
    const value = await this.request('/internal/v1/mail/send', input)
    if (!record(value) || typeof value.receipt_id !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(value.receipt_id) || Object.keys(value).length !== 1)
      throw new Error('EXTERNAL_ACTION_BROKER_RESPONSE_INVALID')
    return { receipt_id: value.receipt_id }
  }

  async postApprovalRequest(input: {
    approval_id: string
    mission_id: string
    action_hash: string
  }): Promise<void> {
    const value = await this.request('/internal/v1/telegram/approval-request', input)
    if (!record(value) || value.accepted !== true || Object.keys(value).length !== 1)
      throw new Error('EXTERNAL_ACTION_BROKER_RESPONSE_INVALID')
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const bearer = (await this.options.readBearer()).trim()
    if (bearer.length < 32 || bearer.length > 4_096 || /\s/.test(bearer))
      throw new Error('EXTERNAL_ACTION_BROKER_BEARER_INVALID')
    const fetchImpl = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(new URL(path, EXACT_ORIGIN), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout()),
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error('EXTERNAL_ACTION_BROKER_UNAVAILABLE')
    }
    if (response.status !== 200) throw new Error(`EXTERNAL_ACTION_BROKER_HTTP_${response.status}`)
    return boundedJson(response)
  }

  private timeout(): number {
    const value = this.options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000)
      throw new Error('EXTERNAL_ACTION_BROKER_TIMEOUT_INVALID')
    return value
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('EXTERNAL_ACTION_BROKER_RESPONSE_INVALID')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > RESPONSE_LIMIT) {
      await reader.cancel()
      throw new Error('EXTERNAL_ACTION_BROKER_RESPONSE_TOO_LARGE')
    }
    chunks.push(part.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('EXTERNAL_ACTION_BROKER_RESPONSE_INVALID')
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
