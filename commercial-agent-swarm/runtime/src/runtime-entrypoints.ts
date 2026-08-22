import {
  DeterministicDispatcher,
  PostgresDispatchQueue,
} from './dispatch-queue.js'
import { HermesExecutor } from './hermes-executor.js'
import {
  loadBrokerRuntimeConfig,
  loadExecutorRuntimeConfig,
} from './runtime-config.js'
import { PosixSocketSecurity } from './socket-security.js'
import { UnixExecutorClient } from './unix-executor-client.js'
import { UnixExecutorServer } from './unix-executor-server.js'
import { createOpenCodeUsageProbeFromEnvironment } from './integration-factories.js'
import type { DispatchQueuePort } from './dispatch-queue.js'
import type { DispatchPhaseEvent } from './dispatch-queue.js'
import type {
  ExecutorPort,
  HomeOwnershipPreparer,
  ProcessRunner,
} from './hermes-executor.js'
import type { OpenCodeUsageExportReadPort } from './opencode-usage-api.js'
import type { Pool } from 'pg'

export interface BrokerDispatcherDependencies {
  queue?: DispatchQueuePort
  executor?: ExecutorPort
  usage?: {
    reader?: OpenCodeUsageExportReadPort
    readToken?: (path: string, expectedGid: number) => Promise<string>
  }
  onPhase?: (event: DispatchPhaseEvent) => void
}

export function createBrokerDispatcher(
  env: Record<string, string | undefined>,
  pool: Pool | undefined,
  workerId: string,
  dependencies: BrokerDispatcherDependencies = {},
) {
  const config = loadBrokerRuntimeConfig(env)
  const usage = createOpenCodeUsageProbeFromEnvironment(
    env,
    dependencies.usage,
  )
  const queue = dependencies.queue ?? (pool ? new PostgresDispatchQueue(pool) : undefined)
  if (!queue) throw new Error('DISPATCH_QUEUE_REQUIRED')
  return new DeterministicDispatcher({
    queue,
    executor:
      dependencies.executor ??
      new UnixExecutorClient({
        socketPath: config.socketPath,
        timeoutMs: config.clientTimeoutMs,
        onPhase: (phase, input) => dependencies.onPhase?.({
          phase,
          jobId: input.assignment_id,
          missionId: input.mission_id,
          profileId: input.profile_id,
        }),
      }),
    workerId,
    leaseSeconds: config.leaseSeconds,
    childTimeoutSeconds: config.childTimeoutSeconds,
    hermesTimeoutMs: config.hermesTimeoutMs,
    onPhase: dependencies.onPhase,
    ...(usage.enabled
      ? {
          usageProbe: usage.probe,
          serviceAccountId: usage.serviceAccountId,
        }
      : {}),
  })
}
export function createExecutorServer(
  env: Record<string, string | undefined>,
  runner: ProcessRunner,
  ownership: HomeOwnershipPreparer,
) {
  const config = loadExecutorRuntimeConfig(env)
  const executor = new HermesExecutor({
    runner,
    ownership,
    profileSeed: config.profileSeed,
    expectedSeedSha256: config.seedSha256,
    temporaryRoot: config.temporaryRoot,
    expectedTemporaryRoot: '/run/hermes-executor',
    expectedOwnerUid: config.executorUid,
    expectedOwnerGid: config.executorGid,
    expectedUsageUid: config.childUid,
    childUid: config.childUid,
    childGid: config.childGid,
    customApiKeyFile: config.customApiKeyFile,
    expectedSecretGid: config.executorGid,
    safePath: '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin',
    modelProxyUrl: config.modelProxyUrl,
    noProxy: config.noProxy,
    timeoutMs: config.hermesTimeoutMs,
  })
  return new UnixExecutorServer({
    socketPath: config.socketPath,
    executor,
    frameTimeoutMs: 30_000,
    security: new PosixSocketSecurity(
      config.socketDirectory,
      config.ipcGid,
      config.executorUid,
      config.executorGid,
    ),
  })
}
