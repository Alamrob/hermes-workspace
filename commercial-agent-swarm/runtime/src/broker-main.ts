import { pathToFileURL } from 'node:url'
import { ApprovalBroker } from './approvals.js'
import { ApprovalModeCoordinator } from './approval-mode.js'
import { BrokerApplication } from './application.js'
import { MailService } from './mail.js'
import { createBrokerExternalTransports } from './integration-factories.js'
import { createRuntimePersistence } from './production.js'
import { createBrokerHttpServer } from './server.js'
import {
  expandDatabaseSecretFiles,
  loadSimulationBrokerConfig,
  readApplicationSecrets,
  assertBrokerServiceIdentity,
} from './simulation-entrypoint.js'
import { WebhookService } from './webhook.js'

export async function startSimulationBroker(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ close: () => Promise<void> }> {
  assertBrokerServiceIdentity()
  const config = loadSimulationBrokerConfig(environment)
  const [databaseEnvironment, secrets] = await Promise.all([
    expandDatabaseSecretFiles(config, environment),
    readApplicationSecrets(config),
  ])
  const persistence = await createRuntimePersistence(databaseEnvironment)
  try {
    if (
      !(await persistence.repository.isKillSwitchActive({
        missionId: '*',
        channel: '*',
      }))
    )
      throw new Error('SIMULATION_KILL_SWITCH_NOT_ACTIVE')

    const externalTransports = createBrokerExternalTransports(environment)
    const approvals = new ApprovalBroker({
      repository: persistence.repository,
      hmacSecret: secrets.approvalHmac,
      telegram: externalTransports.telegram,
    })
    const approvalCoordinator = new ApprovalModeCoordinator({
      mode: config.approvalMode,
      store: persistence.approvalEvidenceStore,
      grants: approvals,
    })
    const app = new BrokerApplication({
      repository: persistence.repository,
      approvals,
      approvalCoordinator,
      mail: new MailService({
        repository: persistence.repository,
        approvals,
        transport: externalTransports.mail,
      }),
      webhook: new WebhookService({
        repository: persistence.repository,
        mailboxSecrets: {},
        maxPayloadBytes: 262_144,
      }),
      audit: persistence.audit,
      deployedVersion: config.deployedVersion,
      a3AdmissionEnabled: config.a3AdmissionEnabled,
      authentication: {
        workOrders: {
          issuer: config.workOrderAuthority.issuer,
          audience: config.workOrderAuthority.audience,
          keys: { [config.workOrderAuthority.keyId]: secrets.workOrderHmac },
        },
        controlPlane: secrets.controlPlane,
        connector: secrets.connector,
        internal: secrets.internal,
        approvalGateways: {
          sales: {
            bearer: secrets.approvalSalesGateway,
            actors: config.approvalActors.sales,
          },
          telegram: {
            bearer: secrets.approvalTelegramGateway,
            actors: config.approvalActors.telegram,
          },
        },
      },
    })
    const server = createBrokerHttpServer(app, { maxBodyBytes: 262_144 })
    server.requestTimeout = 10_000
    server.headersTimeout = 5_000
    server.keepAliveTimeout = 2_000
    server.maxHeadersCount = 64
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await persistence.close()
      })())
    return { close }
  } catch (error) {
    await persistence.close()
    throw error
  }
}

async function main(): Promise<void> {
  const broker = await startSimulationBroker()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void broker.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
