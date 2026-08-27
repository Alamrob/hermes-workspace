const TELEGRAM_ORIGIN = 'https://api.telegram.org'
const BROKER_ORIGIN = 'http://broker:8080'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CALLBACK = /^decision:([0-9a-f-]{36}):(approved|denied)$/i
const RESPONSE_LIMIT = 65_536

export interface TelegramCursorStorePort {
  load(): Promise<number>
  save(nextOffset: number): Promise<void>
}

export interface TelegramBrokerControlPort {
  decideApproval(input: {
    approvalId: string
    decision: 'approved' | 'denied'
    decidedAt: string
    expiresAt: string
  }): Promise<'recorded' | 'not_pending'>
  activateGlobalKillSwitch(input: { occurredAt: string }): Promise<void>
}

export interface TelegramControlPort {
  poll(nextOffset: number): Promise<unknown[]>
  answerCallback(input: { callbackId: string; text: string }): Promise<void>
}

export class TelegramApprovalPoller {
  constructor(private readonly options: {
    approverChatId: string
    cursor: TelegramCursorStorePort
    telegram: TelegramControlPort
    broker: TelegramBrokerControlPort
    now?: () => Date
  }) {
    if (!/^-?[0-9]{5,20}$/.test(options.approverChatId))
      throw new Error('TELEGRAM_APPROVER_CHAT_ID_INVALID')
  }

  async tick(): Promise<{ observed: number; decisions: number; killSwitches: number; ignored: number; answerFailures: number }> {
    let nextOffset = await this.options.cursor.load()
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0)
      throw new Error('TELEGRAM_CURSOR_INVALID')
    const raw = await this.options.telegram.poll(nextOffset)
    if (raw.length > 100) throw new Error('TELEGRAM_UPDATE_BATCH_TOO_LARGE')
    const updates = raw.map(parseUpdate).sort((left, right) => left.updateId - right.updateId)
    const seen = new Set(updates.map((update) => update.updateId))
    if (seen.size !== updates.length) throw new Error('TELEGRAM_UPDATE_DUPLICATE')
    let decisions = 0
    let killSwitches = 0
    let ignored = 0
    let answerFailures = 0
    for (const update of updates) {
      if (update.updateId < nextOffset) continue
      if (update.kind === 'callback' && authorized(update, this.options.approverChatId)) {
        const match = CALLBACK.exec(update.data)
        if (match && UUID.test(match[1]!)) {
          const now = (this.options.now ?? (() => new Date()))()
          const result = await this.options.broker.decideApproval({
            approvalId: match[1]!,
            decision: match[2]!.toLowerCase() as 'approved' | 'denied',
            decidedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          })
          await this.options.telegram.answerCallback({
            callbackId: update.callbackId,
            text: result === 'recorded' ? 'Decisión registrada.' : 'La solicitud ya no está pendiente.',
          }).catch(() => { answerFailures += 1 })
          decisions += 1
        } else {
          ignored += 1
        }
      } else if (update.kind === 'message' && authorized(update, this.options.approverChatId) && update.text === '/kill') {
        const now = (this.options.now ?? (() => new Date()))()
        await this.options.broker.activateGlobalKillSwitch({ occurredAt: now.toISOString() })
        killSwitches += 1
      } else {
        ignored += 1
      }
      nextOffset = update.updateId + 1
      await this.options.cursor.save(nextOffset)
    }
    return { observed: updates.length, decisions, killSwitches, ignored, answerFailures }
  }
}

type ParsedUpdate =
  | { kind: 'callback'; updateId: number; callbackId: string; fromId: string; chatId: string; chatType: string; data: string }
  | { kind: 'message'; updateId: number; fromId: string; chatId: string; chatType: string; text: string }
  | { kind: 'unknown'; updateId: number }

function parseUpdate(value: unknown): ParsedUpdate {
  if (!record(value) || !Number.isSafeInteger(value.update_id) || value.update_id < 0 ||
      value.update_id >= Number.MAX_SAFE_INTEGER)
    throw new Error('TELEGRAM_UPDATE_INVALID')
  const updateId = value.update_id as number
  if (record(value.callback_query)) {
    const query = value.callback_query
    const message = record(query.message) ? query.message : null
    const from = record(query.from) ? query.from : null
    const chat = message && record(message.chat) ? message.chat : null
    if (!from || !chat || typeof query.id !== 'string' || query.id.length < 1 || query.id.length > 256 ||
        !Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || typeof chat.type !== 'string' ||
        typeof query.data !== 'string' || query.data.length > 128)
      return { kind: 'unknown', updateId }
    return {
      kind: 'callback', updateId, callbackId: query.id,
      fromId: String(from.id), chatId: String(chat.id), chatType: chat.type, data: query.data,
    }
  }
  if (record(value.message)) {
    const message = value.message
    const from = record(message.from) ? message.from : null
    const chat = record(message.chat) ? message.chat : null
    if (!from || !chat || !Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) ||
        typeof chat.type !== 'string' || typeof message.text !== 'string' || message.text.length > 128)
      return { kind: 'unknown', updateId }
    return {
      kind: 'message', updateId, fromId: String(from.id), chatId: String(chat.id),
      chatType: chat.type, text: message.text,
    }
  }
  return { kind: 'unknown', updateId }
}

function authorized(
  update: Exclude<ParsedUpdate, { kind: 'unknown' }>,
  expectedChatId: string,
): boolean {
  return update.chatType === 'private' && update.chatId === expectedChatId && update.fromId === expectedChatId
}

export class TelegramBotControlClient implements TelegramControlPort {
  constructor(private readonly options: {
    readToken: () => Promise<string>
    chatId: string
    fetch?: typeof fetch
    timeoutMs?: number
  }) {
    if (!/^-?[0-9]{5,20}$/.test(options.chatId)) throw new Error('TELEGRAM_CHAT_ID_INVALID')
  }

  async poll(nextOffset: number): Promise<unknown[]> {
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0) throw new Error('TELEGRAM_CURSOR_INVALID')
    const value = await this.request('getUpdates', {
      offset: nextOffset,
      timeout: 10,
      limit: 20,
      allowed_updates: ['message', 'callback_query'],
    })
    if (!record(value) || value.ok !== true || !Array.isArray(value.result))
      throw new Error('TELEGRAM_POLL_RESPONSE_INVALID')
    return value.result
  }

  async answerCallback(input: { callbackId: string; text: string }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.callbackId) || input.text.length < 1 || input.text.length > 120)
      throw new Error('TELEGRAM_CALLBACK_ANSWER_INVALID')
    const value = await this.request('answerCallbackQuery', {
      callback_query_id: input.callbackId,
      text: input.text,
      show_alert: false,
      cache_time: 0,
    })
    if (!record(value) || value.ok !== true || value.result !== true)
      throw new Error('TELEGRAM_CALLBACK_ANSWER_RESPONSE_INVALID')
  }

  private async request(method: string, body: unknown): Promise<unknown> {
    const token = (await this.options.readToken()).trim()
    if (!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,80}$/.test(token))
      throw new Error('TELEGRAM_BOT_TOKEN_INVALID')
    const fetchImpl = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${TELEGRAM_ORIGIN}/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeout()),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error('TELEGRAM_CONTROL_UNAVAILABLE')
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`TELEGRAM_CONTROL_HTTP_${response.status}`)
    }
    return boundedJson(response)
  }

  private timeout(): number {
    const value = this.options.timeoutMs ?? 15_000
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000)
      throw new Error('TELEGRAM_TIMEOUT_INVALID')
    return value
  }
}

export class TelegramBrokerControlClient implements TelegramBrokerControlPort {
  constructor(private readonly options: {
    baseUrl: string
    readBearer: () => Promise<string>
    actorId: string
    fetch?: typeof fetch
    timeoutMs?: number
  }) {
    const parsed = new URL(options.baseUrl)
    if (parsed.origin !== BROKER_ORIGIN || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password)
      throw new Error('TELEGRAM_BROKER_ORIGIN_INVALID')
    if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(options.actorId))
      throw new Error('TELEGRAM_ACTOR_ID_INVALID')
  }

  async decideApproval(input: { approvalId: string; decision: 'approved' | 'denied'; decidedAt: string; expiresAt: string }): Promise<'recorded' | 'not_pending'> {
    if (!UUID.test(input.approvalId) || !['approved', 'denied'].includes(input.decision))
      throw new Error('TELEGRAM_APPROVAL_DECISION_INVALID')
    const response = await this.request(`/v1/approvals/${input.approvalId}/decision`, {
      decision: input.decision,
      actor_id: this.options.actorId,
      decided_at: input.decidedAt,
      expires_at: input.expiresAt,
    })
    if (response.status === 409) {
      await response.body?.cancel()
      return 'not_pending'
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`TELEGRAM_BROKER_HTTP_${response.status}`)
    }
    const value = await boundedJson(response)
    if (!record(value) || !['pending', 'approved', 'denied'].includes(String(value.status)))
      throw new Error('TELEGRAM_BROKER_RESPONSE_INVALID')
    return 'recorded'
  }

  async activateGlobalKillSwitch(input: { occurredAt: string }): Promise<void> {
    const response = await this.request('/v1/kill-switches/activate', {
      actor_id: this.options.actorId,
      occurred_at: input.occurredAt,
      reason: 'telegram_emergency_stop',
      scope: 'global',
      scope_id: '*',
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`TELEGRAM_BROKER_HTTP_${response.status}`)
    }
    const value = await boundedJson(response)
    if (!record(value) || value.active !== true || value.scope !== 'global' || value.scope_id !== '*')
      throw new Error('TELEGRAM_KILL_SWITCH_RESPONSE_INVALID')
  }

  private async request(path: string, body: unknown): Promise<Response> {
    const bearer = (await this.options.readBearer()).trim()
    if (bearer.length < 32 || bearer.length > 4_096 || /\s/.test(bearer))
      throw new Error('TELEGRAM_BROKER_BEARER_INVALID')
    const fetchImpl = this.options.fetch ?? fetch
    try {
      return await fetchImpl(new URL(path, BROKER_ORIGIN), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeout()),
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error('TELEGRAM_BROKER_UNAVAILABLE')
    }
  }

  private timeout(): number {
    const value = this.options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000)
      throw new Error('TELEGRAM_BROKER_TIMEOUT_INVALID')
    return value
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('TELEGRAM_RESPONSE_INVALID')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > RESPONSE_LIMIT) {
      await reader.cancel()
      throw new Error('TELEGRAM_RESPONSE_TOO_LARGE')
    }
    chunks.push(part.value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('TELEGRAM_RESPONSE_INVALID') }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
