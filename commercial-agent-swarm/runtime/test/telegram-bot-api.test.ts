import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TelegramBotApiClient } from '../src/telegram-bot-api.js'

const TOKEN = `123456:${'a'.repeat(32)}`
const request = {
  approval_id: '11111111-1111-4111-8111-111111111111',
  mission_id: '22222222-2222-4222-8222-222222222222',
  action_hash: 'b'.repeat(64),
}

describe('Telegram Bot API client', () => {
  it('sends one protected approval notice with opaque callbacks to the allowlisted chat', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new TelegramBotApiClient({
      readToken: async () => TOKEN,
      chatId: '140795',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} })
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 })
      }) as typeof fetch,
    })
    await client.postApprovalRequest(request)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
    const body = JSON.parse(String(calls[0]?.init.body))
    assert.equal(body.chat_id, '140795')
    assert.equal(body.protect_content, true)
    assert.deepEqual(body.link_preview_options, { is_disabled: true })
    assert.deepEqual(body.reply_markup.inline_keyboard[0].map((button: { callback_data: string }) => button.callback_data), [
      `decision:${request.approval_id}:approved`,
      `decision:${request.approval_id}:denied`,
    ])
    assert.doesNotMatch(body.text, new RegExp(TOKEN))
  })

  it('rejects malformed identifiers before contacting Telegram', async () => {
    let calls = 0
    const client = new TelegramBotApiClient({
      readToken: async () => TOKEN,
      chatId: '140795',
      fetch: (async () => { calls += 1; return new Response('{}') }) as typeof fetch,
    })
    await assert.rejects(() => client.postApprovalRequest({ ...request, action_hash: 'bad' }), /TELEGRAM_APPROVAL_REQUEST_INVALID/)
    assert.equal(calls, 0)
  })

  it('does not retry an uncertain request or expose the bot token in its error', async () => {
    let calls = 0
    const client = new TelegramBotApiClient({
      readToken: async () => TOKEN,
      chatId: '140795',
      fetch: (async () => { calls += 1; throw new Error(TOKEN) }) as typeof fetch,
    })
    await assert.rejects(() => client.postApprovalRequest(request), (error: unknown) => {
      assert.equal((error as Error).message, 'TELEGRAM_DELIVERY_UNCERTAIN')
      return true
    })
    assert.equal(calls, 1)
  })

  it('rejects invalid chat IDs and token shapes', async () => {
    assert.throws(() => new TelegramBotApiClient({ readToken: async () => TOKEN, chatId: '@anyone' }), /TELEGRAM_CHAT_ID_INVALID/)
    const client = new TelegramBotApiClient({ readToken: async () => 'secret', chatId: '140795' })
    await assert.rejects(() => client.postApprovalRequest(request), /TELEGRAM_BOT_TOKEN_INVALID/)
  })

  it('probes bot identity without sending a message', async () => {
    const calls: string[] = []
    const client = new TelegramBotApiClient({
      readToken: async () => TOKEN,
      chatId: '140795',
      fetch: (async (input: string | URL | Request) => {
        calls.push(String(input))
        return new Response(JSON.stringify({ ok: true, result: { id: 123456, is_bot: true, first_name: 'Approvals' } }), { status: 200 })
      }) as typeof fetch,
    })
    await client.ready()
    assert.deepEqual(calls, [`https://api.telegram.org/bot${TOKEN}/getMe`])
  })
})
