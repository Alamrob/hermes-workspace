import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DisabledExternalMailTransport } from '../src/disabled-transports.js'
import {
  createBrokerExternalTransports,
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
      },
      {
        readToken: async (path) => {
          assert.equal(path, '/run/secrets/opencode-usage-token')
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
  })
})
