import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertDistinctApplicationSecrets,
  loadSimulationBrokerConfig,
  validateSecretFileMetadata,
} from '../src/simulation-entrypoint.js'
import { DisabledExternalMailTransport } from '../src/disabled-transports.js'

const environment = {
  NODE_ENV: 'production',
  COMMERCIAL_MODE: 'simulation',
  A3_ENABLED: 'false',
  EXTERNAL_RESEARCH_ENABLED: 'false',
  EXTERNAL_ACTION_KILL_SWITCH: 'true',
  BROKER_HOST: '0.0.0.0',
  BROKER_PORT: '8080',
  DEPLOYED_VERSION: '56364edc',
  DATABASE_URL_FILE: '/run/secrets/runtime-db-url',
  WORK_ORDER_DATABASE_URL_FILE: '/run/secrets/work-order-db-url',
  APPROVER_DATABASE_URL_FILE: '/run/secrets/approver-db-url',
  SAFETY_DATABASE_URL_FILE: '/run/secrets/safety-db-url',
  APPROVAL_EVIDENCE_DATABASE_URL_FILE: '/run/secrets/approval-evidence-db-url',
  WORK_ORDER_HMAC_SECRET_FILE: '/run/secrets/work-order-hmac',
  CONTROL_PLANE_BEARER_FILE: '/run/secrets/control-plane-bearer',
  APPROVAL_SALES_GATEWAY_BEARER_FILE: '/run/secrets/approval-sales-gateway-bearer',
  APPROVAL_TELEGRAM_GATEWAY_BEARER_FILE: '/run/secrets/approval-telegram-gateway-bearer',
  CONNECTOR_BEARER_FILE: '/run/secrets/connector-bearer',
  INTERNAL_BEARER_FILE: '/run/secrets/internal-bearer',
  APPROVAL_HMAC_SECRET_FILE: '/run/secrets/approval-hmac',
  WORK_ORDER_ISSUER: 'codex-auditor',
  WORK_ORDER_AUDIENCE: 'proptimiza-hermes',
  WORK_ORDER_KEY_ID: 'codex-v1',
  SALES_APPROVER_IDS: 'sales-director',
  TELEGRAM_APPROVER_IDS: 'telegram-user-1',
}

describe('Simulation broker entrypoint', () => {
  it('accepts only the closed no-external-action deployment mode', () => {
    const config = loadSimulationBrokerConfig(environment)
    assert.equal(config.mode, 'simulation')
    assert.equal(config.port, 8080)
    assert.equal(config.databaseSecretFiles.length, 5)
    assert.equal(config.approvalMode, 'either')
    assert.deepEqual(config.approvalActors, {
      sales: ['sales-director'],
      telegram: ['telegram-user-1'],
    })

    for (const [name, value] of [
      ['COMMERCIAL_MODE', 'shadow'],
      ['A3_ENABLED', 'true'],
      ['EXTERNAL_RESEARCH_ENABLED', 'true'],
      ['EXTERNAL_ACTION_KILL_SWITCH', 'false'],
    ]) {
      assert.throws(
        () => loadSimulationBrokerConfig({ ...environment, [name]: value }),
        /SIMULATION_BOUNDARY_INVALID/,
      )
    }
    assert.throws(
      () => loadSimulationBrokerConfig({ ...environment, APPROVAL_MODE: 'all' }),
      /INVALID_APPROVAL_MODE/,
    )
  })

  it('rejects raw credentials and missing file-backed secrets', () => {
    assert.throws(
      () =>
        loadSimulationBrokerConfig({
          ...environment,
          CONTROL_PLANE_BEARER: 'raw-secret',
        }),
      /RAW_SECRET_FORBIDDEN/,
    )
    const missing = { ...environment }
    delete (missing as Partial<typeof environment>).DATABASE_URL_FILE
    assert.throws(
      () => loadSimulationBrokerConfig(missing),
      /DATABASE_URL_FILE_REQUIRED/,
    )
  })

  it('accepts only an owner-readable regular secret file with no group/world access', () => {
    assert.doesNotThrow(() =>
      validateSecretFileMetadata(
        { isFile: true, isSymbolicLink: false, uid: 10001, mode: 0o100400, size: 64 },
        10001,
      ),
    )
    for (const metadata of [
      { isFile: false, isSymbolicLink: false, uid: 10001, mode: 0o100400, size: 64 },
      { isFile: true, isSymbolicLink: true, uid: 10001, mode: 0o100400, size: 64 },
      { isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100400, size: 64 },
      { isFile: true, isSymbolicLink: false, uid: 10001, mode: 0o100440, size: 64 },
      { isFile: true, isSymbolicLink: false, uid: 10001, mode: 0o100400, size: 0 },
    ]) {
      assert.throws(
        () => validateSecretFileMetadata(metadata, 10001),
        /UNSAFE_SECRET_FILE/,
      )
    }
  })

  it('denies mail before any external transport can exist', async () => {
    await assert.rejects(
      new DisabledExternalMailTransport().send({} as never),
      /EXTERNAL_ACTIONS_DISABLED/,
    )
  })

  it('does not reuse one secret across trust boundaries', () => {
    assert.doesNotThrow(() =>
      assertDistinctApplicationSecrets({
        workOrderHmac: 'a'.repeat(32),
        controlPlane: 'b'.repeat(32),
        approvalSalesGateway: 'c'.repeat(32),
        approvalTelegramGateway: 'd'.repeat(32),
        connector: 'e'.repeat(32),
        internal: 'f'.repeat(32),
        approvalHmac: 'g'.repeat(32),
      }),
    )
    assert.throws(
      () =>
        assertDistinctApplicationSecrets({
          workOrderHmac: 'a'.repeat(32),
          controlPlane: 'b'.repeat(32),
          approvalSalesGateway: 'c'.repeat(32),
          approvalTelegramGateway: 'd'.repeat(32),
          connector: 'e'.repeat(32),
          internal: 'f'.repeat(32),
          approvalHmac: 'a'.repeat(32),
        }),
      /APPLICATION_SECRETS_NOT_DISTINCT/,
    )
  })
})
