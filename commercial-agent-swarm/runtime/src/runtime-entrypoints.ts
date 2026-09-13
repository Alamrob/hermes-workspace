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
import {PostgresExecutionPermitReader} from './postgres-execution-permit.js'

// Deliberately exports only the injected, inert A0 capability. Runtime startup
// does not construct it and no production runner or automatic trigger exists.
export {
  createA0BehaviorBatchAdmission,
  type A0BehaviorBatchAdmissionDependencies,
} from './a0-behavior-batch-admission.js'
export {
  createA0BehaviorAuthorityAdapters,
  type A0BehaviorAuthorityAdapterOptions,
} from './a0-behavior-authority-factory.js'
export {
  PostgresA0BehaviorLedger,
  PostgresA0BehaviorLedgerError,
} from './postgres-a0-behavior-ledger.js'
export {
  A0_SEALED_ARTIFACT_ROOT,
  PosixA0ArtifactSnapshotVerifier,
} from './posix-a0-artifact-snapshot-verifier.js'
export {
  A0_EXECUTOR_CREDENTIAL_HANDLE,
  A0_MANUAL_RUNNER_WORKER_ID,
  PosixA0FixtureReader,
  ProtectedA0BehaviorBatchRunner,
  StaticA0ExecutorCredentialProvider,
} from './a0-behavior-manual-runner.js'
export {
  canonicalA0BatchAuthorizationBytes,
  Ed25519A0BatchAuthorizationVerifier,
  type A0BatchAuthorizationAuthority,
  type Ed25519A0BatchAuthorizationVerifierOptions,
} from './a0-batch-authorization.js'
export {
  A0BatchSealingError,
  prepareA0BatchSigningCandidate,
  signAuthorizedA0Batch,
  type A0ArtifactMaterial,
  type A0BatchSigningCandidate,
  type A0BatchSigningGate,
  type A0PreparedBatchSigningCandidate,
  type A0SignedBatchRequest,
} from './a0-batch-sealer.js'
export {
  A0BehaviorOneShotError,
  prepareA0BehaviorOneShotInvocation,
  runA0BehaviorOneShot,
  type A0BehaviorOneShotDependencies,
  type A0BehaviorOneShotPreparedInvocation,
  type A0BehaviorOneShotResult,
} from './a0-behavior-one-shot-main.js'

export interface BrokerDispatcherDependencies {
  queue?: DispatchQueuePort
  executionPermitReader?: Pick<PostgresExecutionPermitReader, 'read'>
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
  const permits = dependencies.executionPermitReader ??
    (pool ? new PostgresExecutionPermitReader(pool) : undefined)
  if (!permits) throw Error('EXECUTION_PERMIT_DATABASE_REQUIRED')
  return new DeterministicDispatcher({
    queue,
    readExecutionPermit: job =>
      permits.read(job.job_id, job.mission_id, workerId, job.usageBudget.version),
    executor:
      dependencies.executor ??
      new UnixExecutorClient({
        requireExecutionLease:true,
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
  guardian: import('./executor-guardian-client.js').ExecutorGuardianPort,
) {
  if(!guardian)throw Error('EXECUTOR_GUARDIAN_REQUIRED')
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
    externalResearchEnabled: config.externalResearchEnabled,
    timeoutMs: config.hermesTimeoutMs,
  })
  return new UnixExecutorServer({
    guardian,
    requireExecutionLease:true,
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
