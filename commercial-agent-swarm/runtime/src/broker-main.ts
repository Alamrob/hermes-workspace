import { pathToFileURL } from 'node:url'
import { ApprovalBroker } from './approvals.js'
import { ApprovalModeCoordinator } from './approval-mode.js'
import { BrokerApplication } from './application.js'
import { MailService } from './mail.js'
import {
  createBrokerExternalTransports,
  createExternalActionBrokerClientFromEnvironment,
} from './integration-factories.js'
import { createRuntimePersistence } from './production.js'
import { createBrokerHttpServer } from './server.js'
import { createBrokerDispatcher } from './runtime-entrypoints.js'
import {
  expandDatabaseSecretFiles,
  loadSimulationBrokerConfig,
  readApplicationSecrets,
  assertBrokerServiceIdentity,
} from './simulation-entrypoint.js'
import { WebhookService } from './webhook.js'
import type {
  DeterministicDispatcher,
  DispatchPhaseEvent,
} from './dispatch-queue.js'
import type { RuntimeRepository } from './repository.js'

const DISPATCH_POLL_INTERVAL_MS = 1_000

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
    await assertSimulationSafetyBoundary(
      persistence.repository,
      config.a3AdmissionEnabled,
    )

    const externalClient = createExternalActionBrokerClientFromEnvironment(environment)
    const externalTransports = createBrokerExternalTransports(environment, {
      killSwitch: {
        isActive: (input) => persistence.repository.isKillSwitchActive(input),
      },
      hostinger: externalClient,
      telegram: externalClient,
    })
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
      dispatchQueue: persistence.dispatchQueue,
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
        instructionInbox: secrets.instructionInbox,
        shadowReview: secrets.shadowReview,
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
    const dispatcher = await configureDispatcherBeforeListen(
      () =>
        createBrokerDispatcher(
          brokerDispatcherEnvironment(environment),
          undefined,
          'broker-dispatcher-1',
          {
            queue: persistence.dispatchQueue,
            onPhase: recordDispatchPhase,
          },
        ),
      () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(config.port, config.host, () => {
            server.off('error', reject)
            resolve()
          })
        }),
    )
    let dispatcherLoop: ReturnType<typeof startDispatcherLoop> | undefined
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        await dispatcherLoop?.close()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await persistence.close()
      })())
    dispatcherLoop = startDispatcherLoop(dispatcher, () => {
      void close()
    })
    return { close }
  } catch (error) {
    await persistence.close()
    throw error
  }
}

export async function assertSimulationKillSwitchActive(
  repository: Pick<RuntimeRepository, 'isKillSwitchActive'>,
): Promise<void> {
  if (
    !(await repository.isKillSwitchActive({
      missionId: '*',
      channel: '*',
    }))
  )
    throw new Error('SIMULATION_KILL_SWITCH_NOT_ACTIVE')
}

export function recordDispatchPhase(event: DispatchPhaseEvent): void {
  console.info(JSON.stringify({
    event: 'commercial_dispatch_phase',
    phase: event.phase,
    job_id: event.jobId,
    mission_id: event.missionId,
    profile_id: event.profileId,
    recorded_at: new Date().toISOString(),
  }))
}

export async function assertSimulationSafetyBoundary(
  repository: Pick<RuntimeRepository, 'externalActionsBlocked'>,
  a3AdmissionEnabled: boolean,
): Promise<void> {
  if (a3AdmissionEnabled) throw new Error('SIMULATION_A3_MUST_BE_DISABLED')
  if (!(await repository.externalActionsBlocked()))
    throw new Error('SIMULATION_EXTERNAL_ACTIONS_NOT_BLOCKED')
}

export async function configureDispatcherBeforeListen<T>(
  configureDispatcher: () => T,
  listen: () => Promise<void>,
): Promise<T> {
  const dispatcher = configureDispatcher()
  await listen()
  return dispatcher
}

export function startDispatcherLoop(
  dispatcher: Pick<DeterministicDispatcher, 'runOnce'>,
  onFatal: () => void,
  intervalMs = DISPATCH_POLL_INTERVAL_MS,
): { close: () => Promise<void> } {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000)
    throw new Error('DISPATCH_POLL_INTERVAL_INVALID')
  let stopped = false
  let inFlight: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    if (stopped) return
    inFlight = dispatcher.runOnce().then(
      () => undefined,
      () => {
        stopped = true
        clearInterval(timer)
        onFatal()
      },
    )
  }, intervalMs)
  timer.unref()
  return {
    close: async () => {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}

export function brokerDispatcherEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    [
      'NODE_ENV',
      'EXECUTOR_SOCKET_PATH',
      'EXECUTOR_CLIENT_TIMEOUT_MS',
      'HERMES_TIMEOUT_MS',
      'DISPATCH_LEASE_SECONDS',
      'OPENCODE_USAGE_RECONCILIATION_ENABLED',
      'OPENCODE_USAGE_SERVICE_ACCOUNT_ID',
      'OPENCODE_USAGE_TOKEN_FILE',
      'OPENCODE_USAGE_PROXY_URL',
    ].map((name) => [name, environment[name]]),
  )
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
