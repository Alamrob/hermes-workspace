const TELEGRAM_ORIGIN = 'https://api.telegram.org'
const BOT_TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{20,80}$/
const CHAT_ID = /^-?[0-9]{5,20}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const RESPONSE_LIMIT = 65_536

export class TelegramBotApiClient {
  constructor(private readonly options: {
    readToken: () => Promise<string>
    chatId: string
    fetch?: typeof fetch
    timeoutMs?: number
  }) {
    if (!CHAT_ID.test(options.chatId)) throw new Error('TELEGRAM_CHAT_ID_INVALID')
  }

  async postApprovalRequest(request: {
    approval_id: string
    mission_id: string
    action_hash: string
  }): Promise<void> {
    if (!UUID.test(request.approval_id) || !UUID.test(request.mission_id) || !HASH.test(request.action_hash))
      throw new Error('TELEGRAM_APPROVAL_REQUEST_INVALID')
    const token = (await this.options.readToken()).trim()
    if (!BOT_TOKEN.test(token)) throw new Error('TELEGRAM_BOT_TOKEN_INVALID')
    const fetchImpl = this.options.fetch ?? fetch
    const text = [
      'Proptimiza Sales — aprobación requerida',
      `Misión: ${request.mission_id}`,
      `Acción: ${request.action_hash.slice(0, 16)}…`,
      'La decisión se validará nuevamente en el servidor. El botón no contiene credenciales.',
    ].join('\n')
    let response: Response
    try {
      response = await fetchImpl(`${TELEGRAM_ORIGIN}/bot${token}/sendMessage`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout()),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.options.chatId,
          text,
          protect_content: true,
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [[
              { text: 'Aprobar', callback_data: `decision:${request.approval_id}:approved` },
              { text: 'Rechazar', callback_data: `decision:${request.approval_id}:denied` },
            ]],
          },
        }),
      })
    } catch {
      throw new Error('TELEGRAM_DELIVERY_UNCERTAIN')
    }
    if (response.status !== 200) throw new Error(`TELEGRAM_SEND_HTTP_${response.status}`)
    const value = await boundedJson(response)
    if (!record(value) || value.ok !== true || !record(value.result) ||
        !Number.isSafeInteger(value.result.message_id) || value.result.message_id < 1)
      throw new Error('TELEGRAM_SEND_RESPONSE_INVALID')
  }

  async ready(): Promise<void> {
    const token = (await this.options.readToken()).trim()
    if (!BOT_TOKEN.test(token)) throw new Error('TELEGRAM_BOT_TOKEN_INVALID')
    const fetchImpl = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${TELEGRAM_ORIGIN}/bot${token}/getMe`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeout()),
        headers: { accept: 'application/json' },
      })
    } catch {
      throw new Error('TELEGRAM_ACCOUNT_UNAVAILABLE')
    }
    if (response.status !== 200) throw new Error(`TELEGRAM_ACCOUNT_HTTP_${response.status}`)
    const value = await boundedJson(response)
    if (!record(value) || value.ok !== true || !record(value.result) ||
        value.result.is_bot !== true || !Number.isSafeInteger(value.result.id) || value.result.id < 1)
      throw new Error('TELEGRAM_ACCOUNT_RESPONSE_INVALID')
  }

  private timeout(): number {
    const value = this.options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000)
      throw new Error('TELEGRAM_TIMEOUT_INVALID')
    return value
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('TELEGRAM_SEND_RESPONSE_INVALID')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > RESPONSE_LIMIT) {
      await reader.cancel()
      throw new Error('TELEGRAM_SEND_RESPONSE_TOO_LARGE')
    }
    chunks.push(part.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('TELEGRAM_SEND_RESPONSE_INVALID')
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
