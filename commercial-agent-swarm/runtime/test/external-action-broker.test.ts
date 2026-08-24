import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExternalActionBrokerApplication } from '../src/external-action-broker.js'

const BEARER = 'z'.repeat(64)
const headers = { authorization: `Bearer ${BEARER}` }
const mail = {
  missionId: '11111111-1111-4111-8111-111111111111',
  mailbox: 'ventas@proptimiza.com' as const,
  recipient: 'contacto@proptimiza.com' as const,
  subject: 'Prueba interna', content: 'Mensaje controlado', idempotencyKey: 'internal:1',
}
const telegram = {
  approval_id: '22222222-2222-4222-8222-222222222222',
  mission_id: mail.missionId, action_hash: 'a'.repeat(64),
}

function application(options: { killed?: boolean; hostinger?: boolean; telegram?: boolean } = {}) {
  const sent: unknown[] = []
  const notices: unknown[] = []
  return {
    sent, notices,
    app: new ExternalActionBrokerApplication({
      bearer: BEARER,
      hostingerEnabled: options.hostinger ?? true,
      telegramEnabled: options.telegram ?? true,
      safety: { isActive: async () => options.killed ?? false },
      hostinger: options.hostinger === false ? undefined : {
        isBlocked: async () => false,
        sendInternal: async (input) => { sent.push(input); return { receipt_id: `hostinger:${'b'.repeat(64)}` } },
      },
      telegram: options.telegram === false ? undefined : {
        postApprovalRequest: async (input) => { notices.push(input) },
      },
    }),
  }
}

describe('external action broker application', () => {
  it('rejects unauthenticated requests and exposes only inert health metadata', async () => {
    const { app } = application()
    assert.deepEqual(await app.handle({ method: 'GET', path: '/readyz' }), {
      status: 200, body: { status: 'ready', hostinger: true, telegram: true },
    })
    assert.equal((await app.handle({ method: 'POST', path: '/internal/v1/mail/send', body: mail })).status, 401)
  })

  it('sends only the exact internal mail after a fresh kill-switch check', async () => {
    const { app, sent } = application()
    const result = await app.handle({ method: 'POST', path: '/internal/v1/mail/send', ...headers, body: mail })
    assert.deepEqual(result, { status: 200, body: { receipt_id: `hostinger:${'b'.repeat(64)}` } })
    assert.equal(sent.length, 1)
    assert.equal((sent[0] as { recipient: string }).recipient, 'contacto@proptimiza.com')
  })

  it('blocks all sends and Telegram notices while the kill switch is active', async () => {
    const { app, sent, notices } = application({ killed: true })
    assert.equal((await app.handle({ method: 'POST', path: '/internal/v1/mail/send', ...headers, body: mail })).status, 403)
    assert.equal((await app.handle({ method: 'POST', path: '/internal/v1/telegram/approval-request', ...headers, body: telegram })).status, 403)
    assert.equal(sent.length, 0)
    assert.equal(notices.length, 0)
  })

  it('keeps disabled providers fail-closed', async () => {
    const { app } = application({ hostinger: false, telegram: false })
    assert.deepEqual(await app.handle({ method: 'POST', path: '/internal/v1/mail/block-status', ...headers, body: {
      mailbox: mail.mailbox, recipient: mail.recipient,
    } }), { status: 200, body: { blocked: true } })
    assert.equal((await app.handle({ method: 'POST', path: '/internal/v1/mail/send', ...headers, body: mail })).status, 403)
    assert.equal((await app.handle({ method: 'POST', path: '/internal/v1/telegram/approval-request', ...headers, body: telegram })).status, 403)
  })

  it('never forwards malformed or expanded payloads', async () => {
    const { app, sent } = application()
    assert.equal((await app.handle({ method: 'POST', path: '/internal/v1/mail/send', ...headers, body: {
      ...mail, recipient: 'prospect@example.com', secret: 'exfiltrate',
    } })).status, 400)
    assert.equal(sent.length, 0)
  })
})
