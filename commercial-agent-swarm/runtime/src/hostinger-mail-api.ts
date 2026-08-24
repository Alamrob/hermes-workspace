import { createHash } from 'node:crypto'

const HOSTINGER_ORIGIN = 'https://api.mail.hostinger.com'
const VENTAS = 'ventas@proptimiza.com'
const CONTACTO = 'contacto@proptimiza.com'
const RESOURCE_ID = /^AC[A-Za-z0-9]+$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,256}$/
const RESPONSE_LIMIT = 65_536

export interface HostingerInternalMail {
  mailbox: typeof VENTAS
  recipient: typeof CONTACTO
  subject: string
  content: string
  idempotencyKey: string
}

export class HostingerMailApiClient {
  private scopePromise: Promise<Map<string, string>> | undefined

  constructor(private readonly options: {
    readToken: () => Promise<string>
    fetch?: typeof fetch
    timeoutMs?: number
  }) {}

  async isBlocked(input: { mailbox: string; recipient: string }): Promise<boolean> {
    return input.mailbox !== VENTAS || input.recipient !== CONTACTO
  }

  async ready(): Promise<void> {
    await this.scope()
  }

  async sendInternal(input: HostingerInternalMail): Promise<{ receipt_id: string }> {
    validateInternalMail(input)
    const scope = await this.scope()
    const mailboxResourceId = scope.get(VENTAS)
    if (!mailboxResourceId) throw new Error('HOSTINGER_REQUIRED_MAILBOX_MISSING')
    const token = await this.token()
    const fetchImpl = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(
        `${HOSTINGER_ORIGIN}/api/v1/mailboxes/${encodeURIComponent(mailboxResourceId)}/send`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeout()),
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            to: [CONTACTO],
            displayName: 'Equipo Proptimiza',
            subject: input.subject,
            text: input.content,
          }),
        },
      )
    } catch {
      // The provider may have accepted a request before a timeout. The caller
      // must preserve the claimed action for manual reconciliation and never
      // retry it automatically.
      throw new Error('HOSTINGER_DELIVERY_UNCERTAIN')
    }
    if (response.status !== 204) throw new Error(`HOSTINGER_SEND_HTTP_${response.status}`)
    if (response.body) {
      const body = await response.arrayBuffer()
      if (body.byteLength !== 0) throw new Error('HOSTINGER_SEND_RESPONSE_INVALID')
    }
    return {
      receipt_id: `hostinger:${createHash('sha256')
        .update(`${input.idempotencyKey}\n${input.mailbox}\n${input.recipient}\n${input.subject}\n${input.content}`)
        .digest('hex')}`,
    }
  }

  private async scope(): Promise<Map<string, string>> {
    this.scopePromise ??= this.loadScope().catch((error) => {
      this.scopePromise = undefined
      throw error
    })
    return this.scopePromise
  }

  private async loadScope(): Promise<Map<string, string>> {
    const token = await this.token()
    const fetchImpl = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${HOSTINGER_ORIGIN}/api/v1/me`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout()),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    } catch {
      throw new Error('HOSTINGER_ACCOUNT_UNAVAILABLE')
    }
    if (response.status !== 200) throw new Error(`HOSTINGER_ACCOUNT_HTTP_${response.status}`)
    const value = await boundedJson(response)
    if (!record(value) || !record(value.data) || !Array.isArray(value.data.mailboxes))
      throw new Error('HOSTINGER_ACCOUNT_RESPONSE_INVALID')
    const mailboxes = new Map<string, string>()
    for (const candidate of value.data.mailboxes) {
      if (!record(candidate) || typeof candidate.address !== 'string' ||
          typeof candidate.resourceId !== 'string' || !RESOURCE_ID.test(candidate.resourceId))
        throw new Error('HOSTINGER_ACCOUNT_RESPONSE_INVALID')
      const address = candidate.address.toLowerCase()
      if (mailboxes.has(address)) throw new Error('HOSTINGER_ACCOUNT_RESPONSE_INVALID')
      mailboxes.set(address, candidate.resourceId)
    }
    const expected = [CONTACTO, VENTAS].sort()
    if (JSON.stringify([...mailboxes.keys()].sort()) !== JSON.stringify(expected))
      throw new Error('HOSTINGER_TOKEN_SCOPE_INVALID')
    return mailboxes
  }

  private async token(): Promise<string> {
    const token = (await this.options.readToken()).trim()
    if (token.length < 32 || token.length > 4_096 || /\s/.test(token))
      throw new Error('HOSTINGER_TOKEN_INVALID')
    return token
  }

  private timeout(): number {
    const value = this.options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000)
      throw new Error('HOSTINGER_TIMEOUT_INVALID')
    return value
  }
}

function validateInternalMail(input: HostingerInternalMail): void {
  if (input.mailbox !== VENTAS || input.recipient !== CONTACTO)
    throw new Error('HOSTINGER_ACTION_NOT_ALLOWED')
  if (input.subject.length < 1 || input.subject.length > 200 || /[\r\n]/.test(input.subject))
    throw new Error('HOSTINGER_SUBJECT_INVALID')
  if (input.content.length < 1 || input.content.length > 20_000 || input.content.includes('\u0000'))
    throw new Error('HOSTINGER_CONTENT_INVALID')
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey))
    throw new Error('HOSTINGER_IDEMPOTENCY_KEY_INVALID')
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('HOSTINGER_ACCOUNT_RESPONSE_INVALID')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > RESPONSE_LIMIT) {
      await reader.cancel()
      throw new Error('HOSTINGER_ACCOUNT_RESPONSE_TOO_LARGE')
    }
    chunks.push(part.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('HOSTINGER_ACCOUNT_RESPONSE_INVALID')
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
