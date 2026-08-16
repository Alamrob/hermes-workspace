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
import type { HomeOwnershipPreparer, ProcessRunner } from './hermes-executor.js'
import type { Pool } from 'pg'

export function createBrokerDispatcher(
  env: Record<string, string | undefined>,
  pool: Pool,
  workerId: string,
) {
  const config = loadBrokerRuntimeConfig(env)
  return new DeterministicDispatcher({
    queue: new PostgresDispatchQueue(pool),
    executor: new UnixExecutorClient({
      socketPath: config.socketPath,
      timeoutMs: config.clientTimeoutMs,
    }),
    workerId,
    leaseSeconds: config.leaseSeconds,
    childTimeoutSeconds: config.childTimeoutSeconds,
    hermesTimeoutMs: config.hermesTimeoutMs,
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
    expectedTemporaryRoot: '/run/commercial-swarm/hermes-executor',
    expectedOwnerUid: 0,
    expectedUsageUid: 10000,
    childUid: 10000,
    childGid: 10000,
    customApiKeyFile: config.customApiKeyFile,
    safePath: '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin',
    timeoutMs: config.hermesTimeoutMs,
  })
  return new UnixExecutorServer({
    socketPath: config.socketPath,
    executor,
    frameTimeoutMs: 30_000,
    security: new PosixSocketSecurity(config.socketDirectory, config.ipcGid),
  })
}
