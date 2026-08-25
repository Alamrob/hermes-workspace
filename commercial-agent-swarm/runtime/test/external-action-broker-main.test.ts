import assert from 'node:assert/strict'
import { once } from 'node:events'
import { describe, it } from 'node:test'
import { ExternalActionBrokerApplication } from '../src/external-action-broker.js'
import { createExternalActionBrokerHttpServer, loadExternalActionBrokerConfig } from '../src/external-action-broker-main.js'

const base = {
  NODE_ENV: 'production',
  EXTERNAL_ACTION_BROKER_HOST: '0.0.0.0',
  EXTERNAL_ACTION_BROKER_PORT: '8091',
  HOSTINGER_MAIL_ENABLED: 'false',
  TELEGRAM_APPROVAL_ENABLED: 'false',
  EXTERNAL_ACTION_BROKER_BEARER_FILE: '/run/secrets/external-action-broker-bearer',
  BROKER_INTERNAL_BEARER_FILE: '/run/secrets/broker-internal-bearer',
}

describe('external action broker entrypoint', () => {
  it('starts from a disabled configuration without provider secrets', () => {
    assert.deepEqual(loadExternalActionBrokerConfig(base), {
      host: '0.0.0.0', port: 8091, hostingerEnabled: false, telegramEnabled: false,
      bearerFile: '/run/secrets/external-action-broker-bearer',
      brokerInternalFile: null,
      hostingerTokenFile: null, telegramTokenFile: null, telegramChatIdFile: null, proxyUrl: null,
    })
  })

  it('requires file-backed provider secrets and the exact egress proxy when enabled', () => {
    assert.throws(
      () => loadExternalActionBrokerConfig({
        ...base, HOSTINGER_MAIL_ENABLED: 'true', BROKER_INTERNAL_BEARER_FILE: undefined,
      }),
      /BROKER_INTERNAL_BEARER_FILE/,
    )
    assert.throws(() => loadExternalActionBrokerConfig({
      ...base, HOSTINGER_MAIL_ENABLED: 'true', HOSTINGER_MAIL_TOKEN: 'secret',
      HOSTINGER_MAIL_TOKEN_FILE: '/run/secrets/hostinger-mail-token',
    }), /RAW_SECRET_FORBIDDEN/)
    const config = loadExternalActionBrokerConfig({
      ...base,
      HOSTINGER_MAIL_ENABLED: 'true', HOSTINGER_MAIL_TOKEN_FILE: '/run/secrets/hostinger-mail-token',
      TELEGRAM_APPROVAL_ENABLED: 'true', TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram-bot-token',
      TELEGRAM_APPROVER_CHAT_ID_FILE: '/run/secrets/telegram-approver-chat-id',
      EXTERNAL_ACTION_PROXY_URL: 'http://external-egress-proxy:3128',
    })
    assert.equal(config.hostingerEnabled, true)
    assert.equal(config.telegramEnabled, true)
    assert.equal(config.telegramChatIdFile, '/run/secrets/telegram-approver-chat-id')
    assert.throws(() => loadExternalActionBrokerConfig({
      ...base,
      TELEGRAM_APPROVAL_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram-bot-token',
      TELEGRAM_APPROVER_CHAT_ID: '140795',
      TELEGRAM_APPROVER_CHAT_ID_FILE: '/run/secrets/telegram-approver-chat-id',
      EXTERNAL_ACTION_PROXY_URL: 'http://external-egress-proxy:3128',
    }), /RAW_SECRET_FORBIDDEN:TELEGRAM_APPROVER_CHAT_ID/)
  })

  it('serves bounded JSON without reflecting malformed input', async () => {
    const app = new ExternalActionBrokerApplication({
      bearer: 'b'.repeat(64), hostingerEnabled: false, telegramEnabled: false,
      safety: { isActive: async () => true },
    })
    const server = createExternalActionBrokerHttpServer(app)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`)
      assert.equal(health.status, 200)
      const invalid = await fetch(`http://127.0.0.1:${address.port}/internal/v1/mail/send`, {
        method: 'POST', headers: { authorization: `Bearer ${'b'.repeat(64)}`, 'content-type': 'application/json' },
        body: '{"secret":',
      })
      assert.equal(invalid.status, 400)
      assert.deepEqual(await invalid.json(), { error: 'invalid_json' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
