import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DisabledExternalMailTransport } from '../src/disabled-transports.js'
import {
  createBrokerExternalTransports,
  createExternalActionBrokerClientFromEnvironment,
  createOpenCodeUsageProbeFromEnvironment,
} from '../src/integration-factories.js'

describe('disabled-default integration factories', () => {
  it('keeps broker transports disabled without constructing external ports', async () => {
    const transports = createBrokerExternalTransports({ NODE_ENV: 'production' })
    assert(transports.mail instanceof DisabledExternalMailTransport)
    assert.equal(transports.telegram, undefined)
    await assert.rejects(transports.mail.send({} as never), /EXTERNAL_ACTIONS_DISABLED/)
  })

  it('fails closed when external transport flags are malformed or lack injected ports', () => {
    assert.throws(
      () => createBrokerExternalTransports({ HOSTINGER_MAIL_ENABLED: 'yes' }),
      /EXTERNAL_TRANSPORT_FLAG_INVALID/,
    )
    assert.throws(
      () => createBrokerExternalTransports({ NODE_ENV: 'production', HOSTINGER_MAIL_ENABLED: 'true' }),
      /HOSTINGER_PORT_REQUIRED/,
    )
    assert.throws(
      () => createBrokerExternalTransports({ NODE_ENV: 'production', TELEGRAM_APPROVAL_ENABLED: 'true' }),
      /TELEGRAM_PORT_REQUIRED/,
    )
  })

  it('constructs the sidecar client only from a distinct file-backed capability', async () => {
    let reads = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      assert.equal(String(input), 'http://external-action-broker:8091/internal/v1/mail/block-status')
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${'s'.repeat(64)}`)
      return new Response(JSON.stringify({ blocked: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const client = createExternalActionBrokerClientFromEnvironment(
      {
        NODE_ENV: 'production',
        HOSTINGER_MAIL_ENABLED: 'true',
        EXTERNAL_ACTION_BROKER_URL: 'http://external-action-broker:8091',
        EXTERNAL_ACTION_BROKER_BEARER_FILE: '/run/secrets/external-action-broker-bearer',
        BROKER_INTERNAL_BEARER_FILE: '/run/secrets/broker-internal-bearer',
      },
      {
        readBearer: async (path, gid) => {
          reads += 1
          assert.equal(path, '/run/secrets/external-action-broker-bearer')
          assert.equal(gid, 10001)
          return 's'.repeat(64)
        },
        fetch: fetchImpl,
      },
    )
    assert.ok(client)
    assert.equal(reads, 0)
    assert.equal(await client.isBlocked({
      mailbox: 'ventas@proptimiza.com',
      recipient: 'contacto@proptimiza.com',
    }), false)
    assert.equal(reads, 1)
  })

  it('rejects raw, reused, missing and alternate sidecar authority', () => {
    const enabled = {
      NODE_ENV: 'production', HOSTINGER_MAIL_ENABLED: 'true',
      EXTERNAL_ACTION_BROKER_URL: 'http://external-action-broker:8091',
      EXTERNAL_ACTION_BROKER_BEARER_FILE: '/run/secrets/external-action-broker-bearer',
      BROKER_INTERNAL_BEARER_FILE: '/run/secrets/broker-internal-bearer',
    }
    assert.throws(
      () => createExternalActionBrokerClientFromEnvironment({
        ...enabled, EXTERNAL_ACTION_BROKER_BEARER: 'raw-secret',
      }),
      /RAW_BEARER_FORBIDDEN/,
    )
    assert.throws(
      () => createExternalActionBrokerClientFromEnvironment({
        ...enabled,
        EXTERNAL_ACTION_BROKER_BEARER_FILE: '/run/secrets/broker-internal-bearer',
      }),
      /SECRET_REUSE/,
    )
    assert.throws(
      () => createExternalActionBrokerClientFromEnvironment({
        ...enabled, EXTERNAL_ACTION_BROKER_BEARER_FILE: undefined,
      }),
      /BEARER_FILE_INVALID/,
    )
    assert.throws(
      () => createExternalActionBrokerClientFromEnvironment({
        ...enabled, EXTERNAL_ACTION_BROKER_URL: 'http://attacker.invalid:8091',
      }),
      /URL_INVALID/,
    )
  })

  it('does not read the Usage token or construct HTTP while its flag is off', () => {
    let touched = false
    const result = createOpenCodeUsageProbeFromEnvironment(
      { NODE_ENV: 'production' },
      {
        readToken: async () => { touched = true; return 'never' },
        reader: { getCsvExport: async () => { touched = true; return 'never' } },
      },
    )
    assert.deepEqual(result, { enabled: false })
    assert.equal(touched, false)
  })

  it('constructs the real read-only Usage probe only from a dedicated file-backed config', () => {
    const result = createOpenCodeUsageProbeFromEnvironment(
      {
        NODE_ENV: 'production', OPENCODE_USAGE_RECONCILIATION_ENABLED: 'true',
        OPENCODE_USAGE_SERVICE_ACCOUNT_ID: 'service-account-proptimiza',
        OPENCODE_USAGE_TOKEN_FILE: '/run/secrets/opencode-usage-token',
        OPENCODE_USAGE_PROXY_URL: 'http://egress-proxy:3128',
      },
      {
        readToken: async (path, expectedGid) => {
          assert.equal(path, '/run/secrets/opencode-usage-token')
          assert.equal(expectedGid, 10001)
          return 'read-only-token'
        },
        reader: { getCsvExport: async () => { throw new Error('no network in unit test') } },
      },
    )
    assert.equal(result.enabled, true)
    if (result.enabled) {
      assert.equal(result.serviceAccountId, 'service-account-proptimiza')
      assert.ok(result.probe)
    }
    assert.throws(
      () => createOpenCodeUsageProbeFromEnvironment({
        NODE_ENV: 'production', OPENCODE_USAGE_RECONCILIATION_ENABLED: 'true',
        OPENCODE_USAGE_SERVICE_ACCOUNT_ID: 'service-account-proptimiza',
        OPENCODE_USAGE_TOKEN: 'raw-secret',
      }),
      /OPENCODE_USAGE_RAW_TOKEN_FORBIDDEN/,
    )
    assert.throws(
      () => createOpenCodeUsageProbeFromEnvironment({
        NODE_ENV: 'production', OPENCODE_USAGE_RECONCILIATION_ENABLED: 'true',
        OPENCODE_USAGE_SERVICE_ACCOUNT_ID: 'service-account-proptimiza',
        OPENCODE_USAGE_TOKEN_FILE: '/run/secrets/opencode-usage-token',
        OPENCODE_USAGE_PROXY_URL: 'http://attacker.invalid:3128',
      }),
      /OPENCODE_USAGE_PROXY_INVALID/,
    )
  })
})
