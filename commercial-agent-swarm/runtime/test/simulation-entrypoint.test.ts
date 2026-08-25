import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BROKER_SERVICE_GID,
  assertBrokerServiceIdentity,
  assertDistinctApplicationSecrets,
  assertHostingerWebhookSecrets,
  loadSimulationBrokerConfig,
  validateSecretFileMetadata,
} from '../src/simulation-entrypoint.js'
import { validateGroupSecretFileMetadata } from '../src/secret-file.js'
import { DisabledExternalMailTransport } from '../src/disabled-transports.js'
import {
  assertSimulationKillSwitchActive,
  assertSimulationSafetyBoundary,
} from '../src/broker-main.js'

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
  INSTRUCTION_INBOX_BEARER_FILE: '/run/secrets/instruction-inbox-bearer',
  SALES_COMMAND_BEARER_FILE: '/run/secrets/sales-command-bearer',
  SHADOW_REVIEW_BEARER_FILE: '/run/secrets/shadow-review-bearer',
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
    assert.equal(config.a3AdmissionEnabled, false)
    assert.equal(config.hostingerWebhookSecretFiles, null)
    assert.equal(config.secretGid, BROKER_SERVICE_GID)
    assert.equal(config.secretGid, 10001)
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
    assert.doesNotThrow(() =>
      loadSimulationBrokerConfig({
        ...environment,
        OPENCODE_USAGE_RECONCILIATION_ENABLED: 'true',
      }),
    )
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
    assert.throws(
      () => loadSimulationBrokerConfig({
        ...environment,
        HOSTINGER_WEBHOOK_MAILBOX_KEY_FILE: '/run/secrets/hostinger-webhook-mailbox-key',
      }),
      /HOSTINGER_WEBHOOK_SECRET_PAIR_REQUIRED/,
    )
    assert.throws(
      () => loadSimulationBrokerConfig({
        ...environment,
        HOSTINGER_WEBHOOK_MAILBOX_KEY: 'raw-mailbox-key',
        HOSTINGER_WEBHOOK_MAILBOX_KEY_FILE: '/run/secrets/hostinger-webhook-mailbox-key',
        HOSTINGER_WEBHOOK_BEARER_FILE: '/run/secrets/hostinger-webhook-bearer',
      }),
      /RAW_SECRET_FORBIDDEN:HOSTINGER_WEBHOOK_MAILBOX_KEY/,
    )
    const withWebhook = loadSimulationBrokerConfig({
      ...environment,
      HOSTINGER_WEBHOOK_MAILBOX_KEY_FILE: '/run/secrets/hostinger-webhook-mailbox-key',
      HOSTINGER_WEBHOOK_BEARER_FILE: '/run/secrets/hostinger-webhook-bearer',
    })
    assert.deepEqual(withWebhook.hostingerWebhookSecretFiles, {
      mailboxKey: '/run/secrets/hostinger-webhook-mailbox-key',
      bearer: '/run/secrets/hostinger-webhook-bearer',
    })
  })

  it('accepts only root:broker-group 0440 secrets for the broker group', () => {
    assert.doesNotThrow(() => assertBrokerServiceIdentity(10001))
    assert.throws(() => assertBrokerServiceIdentity(10000), /SERVICE_PRIMARY_GID_INVALID/)
    assert.throws(() => assertBrokerServiceIdentity(10011), /SERVICE_PRIMARY_GID_INVALID/)
    assert.doesNotThrow(() =>
      validateGroupSecretFileMetadata(
        { isFile: true, isSymbolicLink: false, uid: 0, gid: 10001, mode: 0o100440, size: 64, nlink: 1 },
        BROKER_SERVICE_GID,
        { uid: 10001, gid: 10001, groups: [10001, 11000] },
      ),
    )
    assert.throws(
      () => validateGroupSecretFileMetadata(
        { isFile: true, isSymbolicLink: false, uid: 0, gid: 10011, mode: 0o100440, size: 64, nlink: 1 },
        BROKER_SERVICE_GID,
        { uid: 10001, gid: 10001, groups: [10001, 10011] },
      ),
      /UNSAFE_SECRET_FILE/,
    )
  })

  it('denies mail before any external transport can exist', async () => {
    await assert.rejects(
      new DisabledExternalMailTransport().send({} as never),
      /EXTERNAL_ACTIONS_DISABLED/,
    )
  })

  it('refuses to start simulation when the authoritative global switch is false', async () => {
    await assert.rejects(
      assertSimulationKillSwitchActive({
        isKillSwitchActive: async () => false,
      }),
      /SIMULATION_KILL_SWITCH_NOT_ACTIVE/,
    )
  })

  it('allows A0-A2 dispatch only while every external channel remains blocked', async () => {
    await assert.doesNotReject(
      assertSimulationSafetyBoundary(
        { externalActionsBlocked: async () => true },
        false,
      ),
    )
    await assert.rejects(
      assertSimulationSafetyBoundary(
        { externalActionsBlocked: async () => false },
        false,
      ),
      /SIMULATION_EXTERNAL_ACTIONS_NOT_BLOCKED/,
    )
    await assert.rejects(
      assertSimulationSafetyBoundary(
        { externalActionsBlocked: async () => true },
        true,
      ),
      /SIMULATION_A3_MUST_BE_DISABLED/,
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
        instructionInbox: 'g'.repeat(32),
        salesCommands: 'h'.repeat(32),
        shadowReview: 'i'.repeat(32),
        approvalHmac: 'j'.repeat(32),
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
          instructionInbox: 'g'.repeat(32),
          salesCommands: 'h'.repeat(32),
          shadowReview: 'i'.repeat(32),
          approvalHmac: 'a'.repeat(32),
        }),
      /APPLICATION_SECRETS_NOT_DISTINCT/,
    )
  })

  it('validates opaque, distinct Hostinger webhook routing secrets', () => {
    const applicationSecrets = {
      workOrderHmac: 'a'.repeat(32), controlPlane: 'b'.repeat(32),
      approvalSalesGateway: 'c'.repeat(32), approvalTelegramGateway: 'd'.repeat(32),
      connector: 'e'.repeat(32), internal: 'f'.repeat(32),
      instructionInbox: 'g'.repeat(32), salesCommands: 'h'.repeat(32),
      shadowReview: 'i'.repeat(32), approvalHmac: 'j'.repeat(32),
    }
    assert.doesNotThrow(() => assertHostingerWebhookSecrets({
      mailboxKey: 'mailbox_key_'.padEnd(32, 'k'),
      bearer: 'webhook_bearer_'.padEnd(32, 'z'),
    }, applicationSecrets))
    assert.throws(() => assertHostingerWebhookSecrets({
      mailboxKey: 'short', bearer: 'webhook_bearer_'.padEnd(32, 'z'),
    }, applicationSecrets), /HOSTINGER_WEBHOOK_SECRET_FORMAT_INVALID/)
    assert.throws(() => assertHostingerWebhookSecrets({
      mailboxKey: 'a'.repeat(32), bearer: 'webhook_bearer_'.padEnd(32, 'z'),
    }, applicationSecrets), /HOSTINGER_WEBHOOK_SECRET_REUSE/)
  })
})
