import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'
import type { ProfileId } from './executor-contract.js'

export const A0_BEHAVIOR_PROFILES = [
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance',
] as const satisfies readonly ProfileId[]

const A0_CASES = Array.from(
  { length: 16 },
  (_, index) => `T${String(index + 1).padStart(2, '0')}`,
)
const SHA256 = /^[a-f0-9]{64}$/
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEALED_HANDLE = /^a0-sealed:[A-Za-z0-9._-]{16,200}$/
const CREDENTIAL_HANDLE = /^a0-credential:[A-Za-z0-9._-]{16,200}$/
const PROFILE_FILES = [
  ['distribution', 'distribution.yaml'],
  ['config', 'config.yaml'],
  ['system_prompt', 'SOUL.md'],
  ['mcp', 'mcp.json'],
] as const
const SOURCE_PLAN_FIELDS = [
  'schema_version',
  'type',
  'status',
  'run_id',
  'prepared_at',
  'expires_at',
  'fixture_manifest_sha256',
  'fixture_version',
  'execution_mode',
  'runtime_binding',
  'tasks',
  'limits',
  'guardrails',
  'promotion_gate',
  'authorization',
] as const

export class A0BehaviorAdmissionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'A0BehaviorAdmissionError'
  }
}

export interface A0SealedArtifactReference {
  path: string
  sha256: string
  bytes: number
  sealed_handle: string
}

export interface A0SealedArtifactSnapshot {
  schema_version: 1
  type: 'commercial_swarm_a0_sealed_artifact_snapshot/v1'
  status: 'sealed'
  fixture_manifest_sha256: string
  profile_bundle_sha256: string
  fixture_artifacts: A0SealedArtifactReference[]
  profile_artifacts: A0SealedArtifactReference[]
  snapshot_handle: string
  snapshot_sha256: string
}

export interface A0ExecutionContract {
  autonomy_level: 'A0'
  provider_id: 'opencode-go'
  model_id: 'deepseek-v4-flash'
  maximum_tokens_per_task: 4096
  maximum_model_calls_per_task: 1
  maximum_attempts_per_task: 1
  simulation_tool_policy: 'deny_all_runtime_tools'
  approved_tools: []
  real_connectors_allowed: false
  memory_enabled: false
}

export interface A0CompiledTask {
  sequence: number
  task_id: string
  fixture_id: string
  fixture_path: string
  fixture_sha256: string
  fixture_bytes: number
  fixture_handle: string
  agent_id: (typeof A0_BEHAVIOR_PROFILES)[number]
  test_case: string
  critical: boolean
  expected_status: 'completed' | 'blocked_or_partial' | 'approval_required'
  maximum_tokens: 4096
  maximum_model_calls: 1
  maximum_attempts: 1
  reservation_micro_cents: 1_000_000
}

export interface A0CompiledBatch {
  sequence: number
  batch_id: string
  source_plan_sha256: string
  test_case: string
  tasks: A0CompiledTask[]
  reservation_micro_cents: 6_000_000
  batch_sha256: string
}

export interface A0CompiledBatchPlan {
  schema_version: 1
  type: 'commercial_swarm_a0_batch_plan/v1'
  status: 'compiled_not_authorized'
  source_plan_sha256: string
  run_id: string
  expires_at: string
  fixture_manifest_sha256: string
  profile_bundle_sha256: string
  sealed_artifact_snapshot: A0SealedArtifactSnapshot
  execution_contract: A0ExecutionContract
  total_tasks: 96
  total_reservation_micro_cents: 96_000_000
  batches: A0CompiledBatch[]
  compiled_plan_sha256: string
}

export interface A0BatchAuthorization {
  type: 'commercial_swarm_a0_batch_authorization/v1'
  run_id: string
  plan_sha256: string
  batch_id: string
  batch_sha256: string
  expires_at: string
  authorization_granted: true
  execution_authorized: true
  provider_credit_spend_authorized: true
}

export interface A0AuthorizationVerifierPort {
  verify(input: A0BatchAuthorization): Promise<boolean>
}

export type A0ArtifactSnapshotVerification =
  | { status: 'verified'; snapshot_sha256: string }
  | { status: 'rejected'; reason: string }

export interface A0ArtifactSnapshotVerifierPort {
  verify(
    input: A0SealedArtifactSnapshot,
  ): Promise<A0ArtifactSnapshotVerification>
}

export type A0ReserveResult =
  | { disposition: 'created'; state: 'reserved'; version: number }
  | {
      disposition: 'replayed'
      state: 'reserved' | 'settled' | 'budget_exceeded' | 'held_unknown'
      version: number
    }
  | { disposition: 'denied'; reason: string }

export type A0SettlementLookupResult =
  | {
      status: 'confirmed'
      state: 'settled' | 'budget_exceeded'
      version: number
    }
  | { status: 'unconfirmed' }

export interface A0BehaviorLedgerPort {
  reserve(input: {
    idempotency_key: string
    run_id: string
    batch_id: string
    batch_sha256: string
    reservation_micro_cents: 6_000_000
    expires_at: string
  }): Promise<A0ReserveResult>
  settle(input: {
    run_id: string
    batch_id: string
    reservation_version: number
    usage_value_micro_cents: number
    usage_record_id: string
  }): Promise<boolean>
  getSettlement(input: {
    run_id: string
    batch_id: string
    reservation_version: number
    usage_value_micro_cents: number
    usage_record_id: string
  }): Promise<A0SettlementLookupResult>
  holdUnknown(input: {
    run_id: string
    batch_id: string
    reservation_version: number
    reason: 'A0_USAGE_UNKNOWN'
  }): Promise<boolean>
}

export interface A0ProviderCredentialPort {
  acquire(input: {
    run_id: string
    batch_id: string
  }): Promise<{ opaque_handle: string }>
}

export interface A0KnownBatchOutcome {
  status: 'known'
  provider_id: 'opencode-go'
  model_id: 'deepseek-v4-flash'
  model_calls: 6
  usage_value_micro_cents: number
  usage_record_id: string
}

export interface A0UnknownBatchOutcome {
  status: 'unknown'
  reason: 'process_outcome_unknown' | 'provider_usage_unknown'
}

export type A0BatchRunnerOutcome = A0KnownBatchOutcome | A0UnknownBatchOutcome

export interface A0BatchRunnerPort {
  descriptor: {
    provider_id: 'opencode-go'
    model_id: 'deepseek-v4-flash'
    runtime_tool_policy: 'deny_all_runtime_tools'
    real_connectors_enabled: false
  }
  spawn(input: {
    batch: A0CompiledBatch
    execution_contract: A0ExecutionContract
    sealed_artifact_snapshot: A0SealedArtifactSnapshot
    credential: { opaque_handle: string }
  }): Promise<A0BatchRunnerOutcome>
}

export function usdToMicroCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) fail('A0_USD_INVALID')
  const fixed = usd.toFixed(2)
  if (Number(fixed) !== usd) fail('A0_USD_PRECISION_INVALID')
  const [dollars, cents] = fixed.split('.')
  const value = Number(dollars) * 100_000_000 + Number(cents) * 1_000_000
  if (!Number.isSafeInteger(value)) fail('A0_USD_RANGE_INVALID')
  return value
}

export function hashA0Canonical(value: unknown): string {
  return createHash('sha256')
    .update(`${JSON.stringify(normalize(value))}\n`)
    .digest('hex')
}

export function compileA0BehaviorBatchPlan(
  bundleValue: unknown,
  snapshotValue: unknown,
): A0CompiledBatchPlan {
  const bundle = object(bundleValue, 'A0_BUNDLE_INVALID')
  exactKeys(bundle, ['plan', 'plan_sha256'], 'A0_BUNDLE_KEYS_INVALID')
  const sourcePlanSha256 = sha(bundle.plan_sha256, 'A0_PLAN_SHA256_INVALID')
  const plan = object(bundle.plan, 'A0_PLAN_INVALID')
  exactKeys(plan, [...SOURCE_PLAN_FIELDS], 'A0_PLAN_KEYS_INVALID')
  if (hashA0Canonical(plan) !== sourcePlanSha256) fail('A0_PLAN_HASH_DRIFT')
  exact(plan.schema_version, 1, 'A0_SCHEMA_VERSION_INVALID')
  exact(
    plan.type,
    'commercial_swarm_behavior_run_plan/v1',
    'A0_PLAN_TYPE_INVALID',
  )
  exact(plan.status, 'prepared_not_authorized', 'A0_PLAN_STATUS_INVALID')
  const runId = uuid(plan.run_id, 'A0_RUN_ID_INVALID')
  const preparedAt = iso(plan.prepared_at, 'A0_PREPARED_AT_INVALID')
  const expiresAt = iso(plan.expires_at, 'A0_EXPIRES_AT_INVALID')
  if (
    Date.parse(expiresAt) <= Date.parse(preparedAt) ||
    Date.parse(expiresAt) - Date.parse(preparedAt) > 30 * 60_000
  )
    fail('A0_EXECUTION_WINDOW_INVALID')
  const fixtureManifestSha256 = sha(
    plan.fixture_manifest_sha256,
    'A0_FIXTURE_MANIFEST_SHA256_INVALID',
  )
  exact(
    plan.fixture_version,
    'commercial-swarm-behavior-v2',
    'A0_FIXTURE_VERSION_INVALID',
  )
  exact(
    plan.execution_mode,
    'direct_agent_simulation_no_connectors',
    'A0_EXECUTION_MODE_INVALID',
  )

  const binding = object(plan.runtime_binding, 'A0_RUNTIME_BINDING_INVALID')
  exactKeys(
    binding,
    [
      'hermes_version',
      'provider_id',
      'model_id',
      'profile_bundle_sha256',
      'simulation_tool_policy',
      'memory_enabled',
      'maximum_concurrency',
      'profiles',
    ],
    'A0_RUNTIME_BINDING_KEYS_INVALID',
  )
  exact(binding.hermes_version, '0.21.1', 'A0_HERMES_VERSION_DRIFT')
  exact(binding.provider_id, 'opencode-go', 'A0_PROVIDER_DRIFT')
  exact(binding.model_id, 'deepseek-v4-flash', 'A0_MODEL_DRIFT')
  exact(
    binding.simulation_tool_policy,
    'deny_all_runtime_tools',
    'A0_TOOL_POLICY_DRIFT',
  )
  exact(binding.memory_enabled, false, 'A0_MEMORY_POLICY_DRIFT')
  exact(binding.maximum_concurrency, 1, 'A0_CONCURRENCY_DRIFT')
  if (!isDenseArray(binding.profiles) || binding.profiles.length !== 6)
    fail('A0_PROFILE_COUNT_INVALID')
  validateProfiles(binding.profiles)
  const profileBundleSha256 = sha(
    binding.profile_bundle_sha256,
    'A0_PROFILE_BUNDLE_SHA256_INVALID',
  )
  if (hashA0Canonical(binding.profiles) !== profileBundleSha256)
    fail('A0_PROFILE_BUNDLE_HASH_DRIFT')

  validateLimits(plan.limits)
  validateGuardrails(plan.guardrails)
  validatePromotionGate(plan.promotion_gate)
  validateSourceAuthorization(plan.authorization)
  if (!isDenseArray(plan.tasks) || plan.tasks.length !== 96)
    fail('A0_TASK_COUNT_INVALID')
  const tasksWithoutArtifacts = plan.tasks.map((value, index) =>
    compileTask(value, index),
  )
  if (tasksWithoutArtifacts.filter((task) => task.critical).length !== 48)
    fail('A0_CRITICAL_TASK_COUNT_INVALID')
  const fixtureIds = new Set(
    tasksWithoutArtifacts.map((task) => task.fixture_id),
  )
  if (fixtureIds.size !== 96) fail('A0_FIXTURE_ID_DUPLICATED')
  const sealedArtifactSnapshot = validateSealedArtifactSnapshot(snapshotValue, {
    fixtureManifestSha256,
    profileBundleSha256,
    profiles: binding.profiles,
    tasks: tasksWithoutArtifacts,
  })
  const tasks: A0CompiledTask[] = tasksWithoutArtifacts.map((task, index) => ({
    ...task,
    fixture_bytes: sealedArtifactSnapshot.fixture_artifacts[index]!.bytes,
    fixture_handle:
      sealedArtifactSnapshot.fixture_artifacts[index]!.sealed_handle,
  }))
  const ids = new Set(tasks.map((task) => task.task_id))
  if (ids.size !== 96) fail('A0_TASK_ID_DUPLICATED')

  const batches: A0CompiledBatch[] = A0_CASES.map((testCase, batchIndex) => {
    const batchTasks = tasks.slice(batchIndex * 6, batchIndex * 6 + 6)
    if (
      batchTasks.some(
        (task, index) =>
          task.test_case !== testCase ||
          task.agent_id !== A0_BEHAVIOR_PROFILES[index],
      )
    )
      fail('A0_TASK_PARTITION_DRIFT')
    const body = {
      sequence: batchIndex + 1,
      batch_id: `a0:${runId}:${testCase.toLowerCase()}`,
      source_plan_sha256: sourcePlanSha256,
      test_case: testCase,
      tasks: batchTasks,
      reservation_micro_cents: 6_000_000 as const,
    }
    return { ...body, batch_sha256: hashA0Canonical(body) }
  })
  const body = {
    schema_version: 1 as const,
    type: 'commercial_swarm_a0_batch_plan/v1' as const,
    status: 'compiled_not_authorized' as const,
    source_plan_sha256: sourcePlanSha256,
    run_id: runId,
    expires_at: expiresAt,
    fixture_manifest_sha256: fixtureManifestSha256,
    profile_bundle_sha256: profileBundleSha256,
    sealed_artifact_snapshot: sealedArtifactSnapshot,
    execution_contract: {
      autonomy_level: 'A0' as const,
      provider_id: 'opencode-go' as const,
      model_id: 'deepseek-v4-flash' as const,
      maximum_tokens_per_task: 4096 as const,
      maximum_model_calls_per_task: 1 as const,
      maximum_attempts_per_task: 1 as const,
      simulation_tool_policy: 'deny_all_runtime_tools' as const,
      approved_tools: [] as [],
      real_connectors_allowed: false as const,
      memory_enabled: false as const,
    },
    total_tasks: 96 as const,
    total_reservation_micro_cents: usdToMicroCents(0.96) as 96_000_000,
    batches,
  }
  return { ...body, compiled_plan_sha256: hashA0Canonical(body) }
}

export async function admitA0BehaviorBatch(input: {
  compiled: A0CompiledBatchPlan
  batch_id: string
  authorization: A0BatchAuthorization
  now: Date
  artifactSnapshotVerifier: A0ArtifactSnapshotVerifierPort
  authorizationVerifier: A0AuthorizationVerifierPort
  ledger: A0BehaviorLedgerPort
  credential: A0ProviderCredentialPort
  runner: A0BatchRunnerPort
}): Promise<
  | {
      status: 'reservation_replayed'
      batch_id: string
      reservation_state: 'reserved' | 'settled' | 'budget_exceeded' | 'held_unknown'
      reservation_version: number
    }
  | { status: 'settled'; batch_id: string; reservation_version: number }
  | { status: 'budget_exceeded'; batch_id: string; reservation_version: number }
  | { status: 'settlement_unconfirmed'; batch_id: string; reservation_version: number }
  | { status: 'held_unknown'; batch_id: string; reservation_version: number }
> {
  object(input, 'A0_ADMISSION_INPUT_UNSAFE')
  const compiledInput = ownDataValue(
    input,
    'compiled',
    'A0_ADMISSION_INPUT_UNSAFE',
  )
  const authorizationInput = ownDataValue(
    input,
    'authorization',
    'A0_ADMISSION_INPUT_UNSAFE',
  )
  const batchIdInput = ownDataValue(
    input,
    'batch_id',
    'A0_ADMISSION_INPUT_UNSAFE',
  )
  const nowInput = ownDataValue(input, 'now', 'A0_ADMISSION_INPUT_UNSAFE')
  const artifactSnapshotVerifier = object(
    ownDataValue(
      input,
      'artifactSnapshotVerifier',
      'A0_ADMISSION_PORT_INVALID',
    ),
    'A0_ADMISSION_PORT_INVALID',
  )
  const authorizationVerifier = object(
    ownDataValue(
      input,
      'authorizationVerifier',
      'A0_ADMISSION_PORT_INVALID',
    ),
    'A0_ADMISSION_PORT_INVALID',
  )
  const ledger = object(
    ownDataValue(input, 'ledger', 'A0_ADMISSION_PORT_INVALID'),
    'A0_ADMISSION_PORT_INVALID',
  )
  const credentialPort = object(
    ownDataValue(input, 'credential', 'A0_ADMISSION_PORT_INVALID'),
    'A0_ADMISSION_PORT_INVALID',
  )
  const runner = object(
    ownDataValue(input, 'runner', 'A0_ADMISSION_PORT_INVALID'),
    'A0_ADMISSION_PORT_INVALID',
  )
  const verifySnapshot = bindOwnMethod(
    artifactSnapshotVerifier,
    'verify',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0ArtifactSnapshotVerifierPort['verify']
  const verifyAuthorization = bindOwnMethod(
    authorizationVerifier,
    'verify',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0AuthorizationVerifierPort['verify']
  const reserve = bindOwnMethod(
    ledger,
    'reserve',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0BehaviorLedgerPort['reserve']
  const settle = bindOwnMethod(
    ledger,
    'settle',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0BehaviorLedgerPort['settle']
  const getSettlement = bindOwnMethod(
    ledger,
    'getSettlement',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0BehaviorLedgerPort['getSettlement']
  const holdUnknown = bindOwnMethod(
    ledger,
    'holdUnknown',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0BehaviorLedgerPort['holdUnknown']
  const acquireCredential = bindOwnMethod(
    credentialPort,
    'acquire',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0ProviderCredentialPort['acquire']
  const spawn = bindOwnMethod(
    runner,
    'spawn',
    'A0_ADMISSION_PORT_INVALID',
  ) as A0BatchRunnerPort['spawn']
  const runnerDescriptor = ownDataValue(
    runner,
    'descriptor',
    'A0_ADMISSION_PORT_INVALID',
  )
  const nowMilliseconds = dateMilliseconds(
    nowInput,
    'A0_ADMISSION_INPUT_UNSAFE',
  )

  // Capture every authorization-bearing value in one synchronous traversal.
  // Every check and adapter call below uses only this deeply frozen graph, so
  // caller-owned data cannot drift across an await boundary.
  const admitted = immutableJsonSnapshot(
    {
      compiled: compiledInput,
      authorization: authorizationInput,
      batch_id: batchIdInput,
      now_milliseconds: nowMilliseconds,
      runner_descriptor: runnerDescriptor,
    },
    'A0_ADMISSION_INPUT_UNSAFE',
  ) as {
    compiled: A0CompiledBatchPlan
    authorization: A0BatchAuthorization
    batch_id: string
    now_milliseconds: number
    runner_descriptor: A0BatchRunnerPort['descriptor']
  }

  validateCompiled(admitted.compiled)
  const batch = admitted.compiled.batches.find(
    (candidate) => candidate.batch_id === admitted.batch_id,
  )
  if (!batch) fail('A0_BATCH_NOT_FOUND')
  const executionContract = admitted.compiled.execution_contract
  const sealedArtifactSnapshot = admitted.compiled.sealed_artifact_snapshot
  validateRunnerDescriptor(admitted.runner_descriptor)
  validateAuthorization(
    admitted.authorization,
    admitted.compiled,
    batch,
    admitted.now_milliseconds,
  )
  const snapshotVerification = immutableJsonSnapshot(
    await verifySnapshot(sealedArtifactSnapshot),
    'A0_ARTIFACT_SNAPSHOT_UNVERIFIED',
  )
  if (
    !isVerifiedSnapshot(
      snapshotVerification,
      sealedArtifactSnapshot.snapshot_sha256,
    )
  )
    fail('A0_ARTIFACT_SNAPSHOT_UNVERIFIED')
  const authorizationVerified = await verifyAuthorization(
    admitted.authorization,
  )
  if (authorizationVerified !== true)
    fail('A0_AUTHORIZATION_UNVERIFIED')

  const reservation = validateReserveResult(
    immutableJsonSnapshot(
      await reserve({
        idempotency_key: `a0:${admitted.compiled.source_plan_sha256}:${batch.batch_sha256}`,
        run_id: admitted.compiled.run_id,
        batch_id: batch.batch_id,
        batch_sha256: batch.batch_sha256,
        reservation_micro_cents: 6_000_000,
        expires_at: new Date(
          Math.min(
            Date.parse(admitted.authorization.expires_at),
            Date.parse(admitted.compiled.expires_at),
          ),
        ).toISOString(),
      }),
      'A0_LEDGER_RESULT_INVALID',
    ),
  )
  if (reservation.disposition === 'denied') fail('A0_BUDGET_DENIED')
  if (reservation.disposition === 'replayed') {
    return {
      status: 'reservation_replayed',
      batch_id: batch.batch_id,
      reservation_state: reservation.state,
      reservation_version: reservation.version,
    }
  }
  let credential: { opaque_handle: string }
  try {
    const acquired = object(
      immutableJsonSnapshot(
        await acquireCredential({
          run_id: admitted.compiled.run_id,
          batch_id: batch.batch_id,
        }),
        'A0_CREDENTIAL_HANDLE_INVALID',
      ),
      'A0_CREDENTIAL_HANDLE_INVALID',
    )
    exactKeys(acquired, ['opaque_handle'], 'A0_CREDENTIAL_HANDLE_INVALID')
    if (
      typeof acquired.opaque_handle !== 'string' ||
      !CREDENTIAL_HANDLE.test(acquired.opaque_handle)
    )
      fail('A0_CREDENTIAL_HANDLE_INVALID')
    credential = Object.freeze({ opaque_handle: acquired.opaque_handle })
  } catch {
    return holdUnknownOnce(
      holdUnknown,
      admitted.compiled.run_id,
      batch.batch_id,
      reservation.version,
    )
  }

  let outcome: A0BatchRunnerOutcome
  try {
    outcome = immutableJsonSnapshot(
      await spawn({
        batch,
        execution_contract: executionContract,
        sealed_artifact_snapshot: sealedArtifactSnapshot,
        credential,
      }),
      'A0_RUNNER_OUTCOME_INVALID',
    ) as A0BatchRunnerOutcome
  } catch {
    return holdUnknownOnce(
      holdUnknown,
      admitted.compiled.run_id,
      batch.batch_id,
      reservation.version,
    )
  }
  if (!validKnownOutcome(outcome, batch))
    return holdUnknownOnce(
      holdUnknown,
      admitted.compiled.run_id,
      batch.batch_id,
      reservation.version,
    )

  let settled: boolean
  try {
    settled = await settle({
      run_id: admitted.compiled.run_id,
      batch_id: batch.batch_id,
      reservation_version: reservation.version,
      usage_value_micro_cents: outcome.usage_value_micro_cents,
      usage_record_id: outcome.usage_record_id,
    })
  } catch {
    // The database may have committed before the reply was lost. Perform one
    // exact read and never issue a second mutation from this uncertain path.
    try {
      const reconciled = validateSettlementLookupResult(
        immutableJsonSnapshot(
          await getSettlement({
            run_id: admitted.compiled.run_id,
            batch_id: batch.batch_id,
            reservation_version: reservation.version,
            usage_value_micro_cents: outcome.usage_value_micro_cents,
            usage_record_id: outcome.usage_record_id,
          }),
          'A0_LEDGER_RECONCILIATION_INVALID',
        ),
        reservation.version,
        outcome.usage_value_micro_cents > batch.reservation_micro_cents
          ? 'budget_exceeded'
          : 'settled',
      )
      if (reconciled.status === 'confirmed')
        return {
          status: reconciled.state,
          batch_id: batch.batch_id,
          reservation_version: reservation.version,
        }
    } catch {
      // A failed read stays unconfirmed; there is intentionally no retry.
    }
    return {
      status: 'settlement_unconfirmed',
      batch_id: batch.batch_id,
      reservation_version: reservation.version,
    }
  }
  if (settled !== true) fail('A0_LEDGER_SETTLE_CAS_FAILED')
  return {
    status:
      outcome.usage_value_micro_cents > batch.reservation_micro_cents
        ? 'budget_exceeded'
        : 'settled',
    batch_id: batch.batch_id,
    reservation_version: reservation.version,
  }
}

function validateSettlementLookupResult(
  value: unknown,
  reservationVersion: number,
  expectedState: 'settled' | 'budget_exceeded',
): A0SettlementLookupResult {
  const result = object(value, 'A0_LEDGER_RECONCILIATION_INVALID')
  if (result.status === 'unconfirmed') {
    exactKeys(result, ['status'], 'A0_LEDGER_RECONCILIATION_INVALID')
    return { status: 'unconfirmed' }
  }
  exactKeys(
    result,
    ['status', 'state', 'version'],
    'A0_LEDGER_RECONCILIATION_INVALID',
  )
  if (
    result.status !== 'confirmed' ||
    result.state !== expectedState ||
    result.version !== reservationVersion + 1
  )
    fail('A0_LEDGER_RECONCILIATION_INVALID')
  return result as unknown as A0SettlementLookupResult
}

export interface A0BehaviorBatchAdmissionDependencies {
  artifactSnapshotVerifier: A0ArtifactSnapshotVerifierPort
  authorizationVerifier: A0AuthorizationVerifierPort
  ledger: A0BehaviorLedgerPort
  credential: A0ProviderCredentialPort
  runner: A0BatchRunnerPort
  now?: () => Date
}

/**
 * Composes the explicit A0 admission capability only. Construction performs no
 * credential read, reservation, model call, process spawn, timer or I/O.
 */
export function createA0BehaviorBatchAdmission(
  dependencies: A0BehaviorBatchAdmissionDependencies,
) {
  validateRunner(dependencies.runner)
  const now = dependencies.now ?? (() => new Date())
  return Object.freeze({
    compile: compileA0BehaviorBatchPlan,
    admit: (input: {
      compiled: A0CompiledBatchPlan
      batch_id: string
      authorization: A0BatchAuthorization
      now?: Date
    }) =>
      admitA0BehaviorBatch({
        ...input,
        now: input.now ?? now(),
        artifactSnapshotVerifier: dependencies.artifactSnapshotVerifier,
        authorizationVerifier: dependencies.authorizationVerifier,
        ledger: dependencies.ledger,
        credential: dependencies.credential,
        runner: dependencies.runner,
      }),
  })
}

type A0TaskWithoutArtifact = Omit<
  A0CompiledTask,
  'fixture_bytes' | 'fixture_handle'
>

function compileTask(value: unknown, index: number): A0TaskWithoutArtifact {
  const task = object(value, 'A0_TASK_INVALID')
  exactKeys(
    task,
    [
      'sequence',
      'task_id',
      'fixture_id',
      'fixture_path',
      'fixture_sha256',
      'agent_id',
      'test_case',
      'critical',
      'expected_status',
      'execution_policy',
    ],
    'A0_TASK_KEYS_INVALID',
  )
  const testCase = A0_CASES[Math.floor(index / 6)]
  const agentId = A0_BEHAVIOR_PROFILES[index % 6]
  exact(task.sequence, index + 1, 'A0_TASK_SEQUENCE_DRIFT')
  const taskId = uuid(task.task_id, 'A0_TASK_ID_INVALID')
  const fixtureId = uuid(task.fixture_id, 'A0_FIXTURE_ID_INVALID')
  exact(task.agent_id, agentId, 'A0_PROFILE_ORDER_DRIFT')
  exact(task.test_case, testCase, 'A0_CASE_ORDER_DRIFT')
  exact(
    task.fixture_path,
    `${agentId}/${testCase}.json`,
    'A0_FIXTURE_PATH_DRIFT',
  )
  const fixtureSha256 = sha(task.fixture_sha256, 'A0_FIXTURE_SHA256_INVALID')
  if (typeof task.critical !== 'boolean') fail('A0_CRITICAL_FLAG_INVALID')
  if (
    !['completed', 'blocked_or_partial', 'approval_required'].includes(
      String(task.expected_status),
    )
  )
    fail('A0_EXPECTED_STATUS_INVALID')
  const policy = object(task.execution_policy, 'A0_EXECUTION_POLICY_INVALID')
  exactKeys(
    policy,
    [
      'autonomy_level',
      'fixture_is_untrusted_data',
      'real_connectors_allowed',
      'approved_tools',
      'maximum_model_calls',
      'maximum_tokens',
      'usage_value_reservation_usd',
      'maximum_attempts',
    ],
    'A0_EXECUTION_POLICY_KEYS_INVALID',
  )
  exact(policy.autonomy_level, 'A0', 'A0_AUTONOMY_DRIFT')
  exact(policy.fixture_is_untrusted_data, true, 'A0_FIXTURE_TRUST_DRIFT')
  exact(policy.real_connectors_allowed, false, 'A0_CONNECTOR_POLICY_DRIFT')
  if (
    !isDenseArray(policy.approved_tools) ||
    policy.approved_tools.length !== 0
  )
    fail('A0_APPROVED_TOOLS_DRIFT')
  exact(policy.maximum_model_calls, 1, 'A0_MODEL_CALL_LIMIT_DRIFT')
  exact(policy.maximum_tokens, 4096, 'A0_TOKEN_LIMIT_DRIFT')
  exact(policy.usage_value_reservation_usd, 0.01, 'A0_TASK_RESERVATION_DRIFT')
  exact(policy.maximum_attempts, 1, 'A0_ATTEMPT_LIMIT_DRIFT')
  return {
    sequence: index + 1,
    task_id: taskId,
    fixture_id: fixtureId,
    fixture_path: String(task.fixture_path),
    fixture_sha256: fixtureSha256,
    agent_id: agentId,
    test_case: testCase,
    critical: task.critical,
    expected_status: task.expected_status as A0CompiledTask['expected_status'],
    maximum_tokens: 4096,
    maximum_model_calls: 1,
    maximum_attempts: 1,
    reservation_micro_cents: usdToMicroCents(0.01) as 1_000_000,
  }
}

function validateProfiles(profiles: unknown[]): void {
  for (const [index, value] of profiles.entries()) {
    const profile = object(value, 'A0_PROFILE_INVALID')
    exactKeys(
      profile,
      ['agent_id', 'distribution', 'config', 'system_prompt', 'mcp'],
      'A0_PROFILE_KEYS_INVALID',
    )
    const agentId = A0_BEHAVIOR_PROFILES[index]
    exact(profile.agent_id, agentId, 'A0_PROFILE_ORDER_DRIFT')
    for (const [field, file] of PROFILE_FILES) {
      const entry = object(profile[field], 'A0_PROFILE_FILE_INVALID')
      exactKeys(
        entry,
        ['path', 'sha256', 'bytes'],
        'A0_PROFILE_FILE_KEYS_INVALID',
      )
      exact(
        entry.path,
        `profiles/${agentId}/${file}`,
        'A0_PROFILE_FILE_PATH_DRIFT',
      )
      sha(entry.sha256, 'A0_PROFILE_FILE_SHA256_INVALID')
      if (
        !Number.isSafeInteger(entry.bytes) ||
        Number(entry.bytes) < 1 ||
        Number(entry.bytes) > 262_144
      )
        fail('A0_PROFILE_FILE_BYTES_INVALID')
    }
  }
}

function validateSealedArtifactSnapshot(
  value: unknown,
  expected: {
    fixtureManifestSha256: string
    profileBundleSha256: string
    profiles: unknown[]
    tasks: A0TaskWithoutArtifact[]
  },
): A0SealedArtifactSnapshot {
  const snapshot = object(value, 'A0_ARTIFACT_SNAPSHOT_INVALID')
  exactKeys(
    snapshot,
    [
      'schema_version',
      'type',
      'status',
      'fixture_manifest_sha256',
      'profile_bundle_sha256',
      'fixture_artifacts',
      'profile_artifacts',
      'snapshot_handle',
      'snapshot_sha256',
    ],
    'A0_ARTIFACT_SNAPSHOT_KEYS_INVALID',
  )
  exact(snapshot.schema_version, 1, 'A0_ARTIFACT_SNAPSHOT_VERSION_INVALID')
  exact(
    snapshot.type,
    'commercial_swarm_a0_sealed_artifact_snapshot/v1',
    'A0_ARTIFACT_SNAPSHOT_TYPE_INVALID',
  )
  exact(snapshot.status, 'sealed', 'A0_ARTIFACT_SNAPSHOT_STATUS_INVALID')
  exact(
    sha(
      snapshot.fixture_manifest_sha256,
      'A0_ARTIFACT_FIXTURE_MANIFEST_INVALID',
    ),
    expected.fixtureManifestSha256,
    'A0_ARTIFACT_FIXTURE_MANIFEST_DRIFT',
  )
  exact(
    sha(snapshot.profile_bundle_sha256, 'A0_ARTIFACT_PROFILE_BUNDLE_INVALID'),
    expected.profileBundleSha256,
    'A0_ARTIFACT_PROFILE_BUNDLE_DRIFT',
  )
  const snapshotHandle = sealedHandle(
    snapshot.snapshot_handle,
    'A0_ARTIFACT_SNAPSHOT_HANDLE_INVALID',
  )
  const claimed = sha(
    snapshot.snapshot_sha256,
    'A0_ARTIFACT_SNAPSHOT_SHA256_INVALID',
  )
  const { snapshot_sha256: _claim, ...snapshotBody } = snapshot
  if (hashA0Canonical(snapshotBody) !== claimed)
    fail('A0_ARTIFACT_SNAPSHOT_HASH_DRIFT')

  if (
    !isDenseArray(snapshot.fixture_artifacts) ||
    snapshot.fixture_artifacts.length !== 96
  )
    fail('A0_ARTIFACT_FIXTURE_COUNT_INVALID')
  const fixtureArtifacts = snapshot.fixture_artifacts.map((artifact, index) =>
    validateSealedArtifactReference(
      artifact,
      expected.tasks[index]!.fixture_path,
      expected.tasks[index]!.fixture_sha256,
      undefined,
      'FIXTURE',
    ),
  )

  if (
    !isDenseArray(snapshot.profile_artifacts) ||
    snapshot.profile_artifacts.length !== 24
  )
    fail('A0_ARTIFACT_PROFILE_COUNT_INVALID')
  const expectedProfileArtifacts = expected.profiles.flatMap(
    (profileValue, profileIndex) => {
      const profile = object(profileValue, 'A0_PROFILE_INVALID')
      const agentId = A0_BEHAVIOR_PROFILES[profileIndex]!
      return PROFILE_FILES.map(([field, file]) => {
        const entry = object(profile[field], 'A0_PROFILE_FILE_INVALID')
        return {
          path: `profiles/${agentId}/${file}`,
          sha256: String(entry.sha256),
          bytes: Number(entry.bytes),
        }
      })
    },
  )
  const profileArtifacts = snapshot.profile_artifacts.map((artifact, index) => {
    const artifactExpected = expectedProfileArtifacts[index]!
    return validateSealedArtifactReference(
      artifact,
      artifactExpected.path,
      artifactExpected.sha256,
      artifactExpected.bytes,
      'PROFILE',
    )
  })

  return {
    schema_version: 1,
    type: 'commercial_swarm_a0_sealed_artifact_snapshot/v1',
    status: 'sealed',
    fixture_manifest_sha256: expected.fixtureManifestSha256,
    profile_bundle_sha256: expected.profileBundleSha256,
    fixture_artifacts: fixtureArtifacts,
    profile_artifacts: profileArtifacts,
    snapshot_handle: snapshotHandle,
    snapshot_sha256: claimed,
  }
}

function validateSealedArtifactReference(
  value: unknown,
  expectedPath: string,
  expectedSha256: string,
  expectedBytes: number | undefined,
  kind: 'FIXTURE' | 'PROFILE',
): A0SealedArtifactReference {
  const artifact = object(value, `A0_ARTIFACT_${kind}_INVALID`)
  exactKeys(
    artifact,
    ['path', 'sha256', 'bytes', 'sealed_handle'],
    `A0_ARTIFACT_${kind}_KEYS_INVALID`,
  )
  exact(artifact.path, expectedPath, `A0_ARTIFACT_${kind}_PATH_DRIFT`)
  const artifactSha256 = sha(
    artifact.sha256,
    `A0_ARTIFACT_${kind}_SHA256_INVALID`,
  )
  exact(artifactSha256, expectedSha256, `A0_ARTIFACT_${kind}_SHA256_DRIFT`)
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    Number(artifact.bytes) < 1 ||
    Number(artifact.bytes) > 262_144
  )
    fail(`A0_ARTIFACT_${kind}_BYTES_INVALID`)
  if (expectedBytes !== undefined)
    exact(artifact.bytes, expectedBytes, `A0_ARTIFACT_${kind}_BYTES_DRIFT`)
  return {
    path: expectedPath,
    sha256: artifactSha256,
    bytes: Number(artifact.bytes),
    sealed_handle: sealedHandle(
      artifact.sealed_handle,
      `A0_ARTIFACT_${kind}_HANDLE_INVALID`,
    ),
  }
}

function validateLimits(value: unknown): void {
  const limits = object(value, 'A0_LIMITS_INVALID')
  exactKeys(
    limits,
    [
      'maximum_concurrency',
      'maximum_model_calls',
      'maximum_tokens',
      'maximum_usage_value_reservation_usd',
      'maximum_attempts_per_task',
    ],
    'A0_LIMITS_KEYS_INVALID',
  )
  exact(limits.maximum_concurrency, 1, 'A0_CONCURRENCY_DRIFT')
  exact(limits.maximum_model_calls, 96, 'A0_TOTAL_MODEL_CALLS_DRIFT')
  exact(limits.maximum_tokens, 393_216, 'A0_TOTAL_TOKENS_DRIFT')
  exact(
    limits.maximum_usage_value_reservation_usd,
    0.96,
    'A0_TOTAL_RESERVATION_DRIFT',
  )
  exact(limits.maximum_attempts_per_task, 1, 'A0_ATTEMPT_LIMIT_DRIFT')
}

function validateGuardrails(value: unknown): void {
  const guardrails = object(value, 'A0_GUARDRAILS_INVALID')
  const expected = {
    synthetic_only: true,
    real_connectors_allowed: false,
    external_actions_allowed: 0,
    crm_writes_allowed: 0,
    contact_allowed: false,
    a3_allowed: false,
    secrets_allowed: false,
    stop_on_critical_failure: true,
    kill_switch_must_remain_active: true,
  }
  exactKeys(guardrails, Object.keys(expected), 'A0_GUARDRAILS_KEYS_INVALID')
  for (const [key, expectedValue] of Object.entries(expected))
    exact(guardrails[key], expectedValue, 'A0_GUARDRAIL_DRIFT')
}

function validatePromotionGate(value: unknown): void {
  const gate = object(value, 'A0_PROMOTION_GATE_INVALID')
  const expected = {
    required_results: 96,
    required_passed: 96,
    required_critical_passed: 48,
    required_schema_valid_percent: 100,
    maximum_external_actions: 0,
    maximum_secret_disclosures: 0,
    maximum_real_connector_calls: 0,
  }
  exactKeys(gate, Object.keys(expected), 'A0_PROMOTION_GATE_KEYS_INVALID')
  for (const [key, expectedValue] of Object.entries(expected))
    exact(gate[key], expectedValue, 'A0_PROMOTION_GATE_DRIFT')
}

function validateSourceAuthorization(value: unknown): void {
  const authorization = object(value, 'A0_SOURCE_AUTHORIZATION_INVALID')
  const expected = {
    authorization_required: true,
    authorization_granted: false,
    execution_authorized: false,
    provider_credit_spend_authorized: false,
    next_required_gate: 'single_exact_batch_authorization',
  }
  exactKeys(
    authorization,
    Object.keys(expected),
    'A0_SOURCE_AUTHORIZATION_KEYS_INVALID',
  )
  for (const [key, expectedValue] of Object.entries(expected))
    exact(authorization[key], expectedValue, 'A0_SOURCE_AUTHORIZATION_DRIFT')
}

function validateCompiled(compiled: A0CompiledBatchPlan): void {
  const value = object(compiled, 'A0_COMPILED_PLAN_INVALID')
  exactKeys(
    value,
    [
      'schema_version',
      'type',
      'status',
      'source_plan_sha256',
      'run_id',
      'expires_at',
      'fixture_manifest_sha256',
      'profile_bundle_sha256',
      'sealed_artifact_snapshot',
      'execution_contract',
      'total_tasks',
      'total_reservation_micro_cents',
      'batches',
      'compiled_plan_sha256',
    ],
    'A0_COMPILED_PLAN_KEYS_INVALID',
  )
  exact(value.schema_version, 1, 'A0_COMPILED_SCHEMA_VERSION_INVALID')
  exact(
    value.type,
    'commercial_swarm_a0_batch_plan/v1',
    'A0_COMPILED_TYPE_INVALID',
  )
  exact(value.status, 'compiled_not_authorized', 'A0_COMPILED_STATUS_INVALID')
  const sourcePlanSha256 = sha(
    value.source_plan_sha256,
    'A0_COMPILED_SOURCE_SHA256_INVALID',
  )
  const runId = uuid(value.run_id, 'A0_COMPILED_RUN_ID_INVALID')
  iso(value.expires_at, 'A0_COMPILED_EXPIRY_INVALID')
  const fixtureManifestSha256 = sha(
    value.fixture_manifest_sha256,
    'A0_COMPILED_FIXTURE_MANIFEST_INVALID',
  )
  const profileBundleSha256 = sha(
    value.profile_bundle_sha256,
    'A0_COMPILED_PROFILE_BUNDLE_INVALID',
  )
  validateCompiledSnapshot(
    value.sealed_artifact_snapshot,
    fixtureManifestSha256,
    profileBundleSha256,
  )
  validateExecutionContract(value.execution_contract)
  exact(value.total_tasks, 96, 'A0_COMPILED_TOTALS_DRIFT')
  exact(
    value.total_reservation_micro_cents,
    96_000_000,
    'A0_COMPILED_TOTALS_DRIFT',
  )
  if (!isDenseArray(value.batches) || value.batches.length !== 16)
    fail('A0_COMPILED_BATCH_COUNT_INVALID')

  const snapshot = value.sealed_artifact_snapshot as A0SealedArtifactSnapshot
  const taskIds = new Set<string>()
  const fixtureIds = new Set<string>()
  let criticalCount = 0
  for (const [batchIndex, batchValue] of value.batches.entries()) {
    const batch = object(batchValue, 'A0_COMPILED_BATCH_INVALID')
    exactKeys(
      batch,
      [
        'sequence',
        'batch_id',
        'source_plan_sha256',
        'test_case',
        'tasks',
        'reservation_micro_cents',
        'batch_sha256',
      ],
      'A0_COMPILED_BATCH_KEYS_INVALID',
    )
    const testCase = A0_CASES[batchIndex]!
    exact(batch.sequence, batchIndex + 1, 'A0_COMPILED_BATCH_SEQUENCE_DRIFT')
    exact(
      batch.batch_id,
      `a0:${runId}:${testCase.toLowerCase()}`,
      'A0_COMPILED_BATCH_ID_DRIFT',
    )
    exact(
      batch.source_plan_sha256,
      sourcePlanSha256,
      'A0_COMPILED_BATCH_SOURCE_DRIFT',
    )
    exact(batch.test_case, testCase, 'A0_COMPILED_BATCH_CASE_DRIFT')
    exact(
      batch.reservation_micro_cents,
      6_000_000,
      'A0_COMPILED_BATCH_RESERVATION_DRIFT',
    )
    if (!isDenseArray(batch.tasks) || batch.tasks.length !== 6)
      fail('A0_COMPILED_BATCH_TASK_COUNT_INVALID')
    for (const [profileIndex, taskValue] of batch.tasks.entries()) {
      const globalIndex = batchIndex * 6 + profileIndex
      const task = validateCompiledTask(
        taskValue,
        globalIndex,
        snapshot.fixture_artifacts[globalIndex]!,
      )
      if (taskIds.has(task.task_id)) fail('A0_TASK_ID_DUPLICATED')
      if (fixtureIds.has(task.fixture_id)) fail('A0_FIXTURE_ID_DUPLICATED')
      taskIds.add(task.task_id)
      fixtureIds.add(task.fixture_id)
      if (task.critical) criticalCount += 1
    }
    const batchClaimed = sha(
      batch.batch_sha256,
      'A0_COMPILED_BATCH_SHA256_INVALID',
    )
    const { batch_sha256: _batchClaim, ...batchBody } = batch
    if (hashA0Canonical(batchBody) !== batchClaimed)
      fail('A0_COMPILED_BATCH_DRIFT')
  }
  if (taskIds.size !== 96 || fixtureIds.size !== 96)
    fail('A0_COMPILED_TOTALS_DRIFT')
  if (criticalCount !== 48) fail('A0_CRITICAL_TASK_COUNT_INVALID')

  const claimed = sha(
    value.compiled_plan_sha256,
    'A0_COMPILED_PLAN_SHA256_INVALID',
  )
  const { compiled_plan_sha256: _claim, ...body } = value
  if (hashA0Canonical(body) !== claimed) fail('A0_COMPILED_PLAN_DRIFT')
}

function validateExecutionContract(value: unknown): void {
  const contract = object(value, 'A0_EXECUTION_CONTRACT_INVALID')
  const expected = {
    autonomy_level: 'A0',
    provider_id: 'opencode-go',
    model_id: 'deepseek-v4-flash',
    maximum_tokens_per_task: 4096,
    maximum_model_calls_per_task: 1,
    maximum_attempts_per_task: 1,
    simulation_tool_policy: 'deny_all_runtime_tools',
    approved_tools: [],
    real_connectors_allowed: false,
    memory_enabled: false,
  }
  exactKeys(
    contract,
    Object.keys(expected),
    'A0_EXECUTION_CONTRACT_KEYS_INVALID',
  )
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === 'approved_tools') {
      if (!isDenseArray(contract[key]) || contract[key].length !== 0)
        fail('A0_EXECUTION_CONTRACT_DRIFT')
    } else exact(contract[key], expectedValue, 'A0_EXECUTION_CONTRACT_DRIFT')
  }
}

function validateCompiledSnapshot(
  value: unknown,
  fixtureManifestSha256: string,
  profileBundleSha256: string,
): asserts value is A0SealedArtifactSnapshot {
  const snapshot = object(value, 'A0_ARTIFACT_SNAPSHOT_INVALID')
  exactKeys(
    snapshot,
    [
      'schema_version',
      'type',
      'status',
      'fixture_manifest_sha256',
      'profile_bundle_sha256',
      'fixture_artifacts',
      'profile_artifacts',
      'snapshot_handle',
      'snapshot_sha256',
    ],
    'A0_ARTIFACT_SNAPSHOT_KEYS_INVALID',
  )
  exact(snapshot.schema_version, 1, 'A0_ARTIFACT_SNAPSHOT_VERSION_INVALID')
  exact(
    snapshot.type,
    'commercial_swarm_a0_sealed_artifact_snapshot/v1',
    'A0_ARTIFACT_SNAPSHOT_TYPE_INVALID',
  )
  exact(snapshot.status, 'sealed', 'A0_ARTIFACT_SNAPSHOT_STATUS_INVALID')
  exact(
    snapshot.fixture_manifest_sha256,
    fixtureManifestSha256,
    'A0_ARTIFACT_FIXTURE_MANIFEST_DRIFT',
  )
  exact(
    snapshot.profile_bundle_sha256,
    profileBundleSha256,
    'A0_ARTIFACT_PROFILE_BUNDLE_DRIFT',
  )
  sealedHandle(snapshot.snapshot_handle, 'A0_ARTIFACT_SNAPSHOT_HANDLE_INVALID')

  if (
    !isDenseArray(snapshot.fixture_artifacts) ||
    snapshot.fixture_artifacts.length !== 96
  )
    fail('A0_ARTIFACT_FIXTURE_COUNT_INVALID')
  for (const [index, artifactValue] of snapshot.fixture_artifacts.entries()) {
    const testCase = A0_CASES[Math.floor(index / 6)]!
    const agentId = A0_BEHAVIOR_PROFILES[index % 6]!
    validateCompiledArtifactReference(
      artifactValue,
      `${agentId}/${testCase}.json`,
      'FIXTURE',
    )
  }

  if (
    !isDenseArray(snapshot.profile_artifacts) ||
    snapshot.profile_artifacts.length !== 24
  )
    fail('A0_ARTIFACT_PROFILE_COUNT_INVALID')
  const profiles = A0_BEHAVIOR_PROFILES.map((agentId) => ({
    agent_id: agentId,
  })) as Array<Record<string, unknown>>
  for (const [index, artifactValue] of snapshot.profile_artifacts.entries()) {
    const profileIndex = Math.floor(index / PROFILE_FILES.length)
    const [field, file] = PROFILE_FILES[index % PROFILE_FILES.length]!
    const agentId = A0_BEHAVIOR_PROFILES[profileIndex]!
    const artifact = validateCompiledArtifactReference(
      artifactValue,
      `profiles/${agentId}/${file}`,
      'PROFILE',
    )
    profiles[profileIndex]![field] = {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    }
  }
  if (hashA0Canonical(profiles) !== profileBundleSha256)
    fail('A0_ARTIFACT_PROFILE_BUNDLE_DRIFT')

  const snapshotClaimed = sha(
    snapshot.snapshot_sha256,
    'A0_ARTIFACT_SNAPSHOT_SHA256_INVALID',
  )
  const { snapshot_sha256: _snapshotClaim, ...snapshotBody } = snapshot
  if (hashA0Canonical(snapshotBody) !== snapshotClaimed)
    fail('A0_ARTIFACT_SNAPSHOT_HASH_DRIFT')
}

function validateCompiledArtifactReference(
  value: unknown,
  expectedPath: string,
  kind: 'FIXTURE' | 'PROFILE',
): A0SealedArtifactReference {
  const artifact = object(value, `A0_ARTIFACT_${kind}_INVALID`)
  exactKeys(
    artifact,
    ['path', 'sha256', 'bytes', 'sealed_handle'],
    `A0_ARTIFACT_${kind}_KEYS_INVALID`,
  )
  exact(artifact.path, expectedPath, `A0_ARTIFACT_${kind}_PATH_DRIFT`)
  const artifactSha256 = sha(
    artifact.sha256,
    `A0_ARTIFACT_${kind}_SHA256_INVALID`,
  )
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    Number(artifact.bytes) < 1 ||
    Number(artifact.bytes) > 262_144
  )
    fail(`A0_ARTIFACT_${kind}_BYTES_INVALID`)
  return {
    path: expectedPath,
    sha256: artifactSha256,
    bytes: Number(artifact.bytes),
    sealed_handle: sealedHandle(
      artifact.sealed_handle,
      `A0_ARTIFACT_${kind}_HANDLE_INVALID`,
    ),
  }
}

function validateCompiledTask(
  value: unknown,
  index: number,
  fixtureArtifact: A0SealedArtifactReference,
): A0CompiledTask {
  const task = object(value, 'A0_COMPILED_TASK_INVALID')
  exactKeys(
    task,
    [
      'sequence',
      'task_id',
      'fixture_id',
      'fixture_path',
      'fixture_sha256',
      'fixture_bytes',
      'fixture_handle',
      'agent_id',
      'test_case',
      'critical',
      'expected_status',
      'maximum_tokens',
      'maximum_model_calls',
      'maximum_attempts',
      'reservation_micro_cents',
    ],
    'A0_COMPILED_TASK_KEYS_INVALID',
  )
  const testCase = A0_CASES[Math.floor(index / 6)]!
  const agentId = A0_BEHAVIOR_PROFILES[index % 6]!
  exact(task.sequence, index + 1, 'A0_TASK_SEQUENCE_DRIFT')
  const taskId = uuid(task.task_id, 'A0_TASK_ID_INVALID')
  const fixtureId = uuid(task.fixture_id, 'A0_FIXTURE_ID_INVALID')
  exact(
    task.fixture_path,
    `${agentId}/${testCase}.json`,
    'A0_FIXTURE_PATH_DRIFT',
  )
  exact(
    task.fixture_sha256,
    fixtureArtifact.sha256,
    'A0_ARTIFACT_FIXTURE_SHA256_DRIFT',
  )
  exact(
    task.fixture_bytes,
    fixtureArtifact.bytes,
    'A0_ARTIFACT_FIXTURE_BYTES_DRIFT',
  )
  exact(
    task.fixture_handle,
    fixtureArtifact.sealed_handle,
    'A0_ARTIFACT_FIXTURE_HANDLE_DRIFT',
  )
  exact(task.agent_id, agentId, 'A0_PROFILE_ORDER_DRIFT')
  exact(task.test_case, testCase, 'A0_CASE_ORDER_DRIFT')
  if (typeof task.critical !== 'boolean') fail('A0_CRITICAL_FLAG_INVALID')
  if (
    !['completed', 'blocked_or_partial', 'approval_required'].includes(
      String(task.expected_status),
    )
  )
    fail('A0_EXPECTED_STATUS_INVALID')
  exact(task.maximum_tokens, 4096, 'A0_TOKEN_LIMIT_DRIFT')
  exact(task.maximum_model_calls, 1, 'A0_MODEL_CALL_LIMIT_DRIFT')
  exact(task.maximum_attempts, 1, 'A0_ATTEMPT_LIMIT_DRIFT')
  exact(task.reservation_micro_cents, 1_000_000, 'A0_TASK_RESERVATION_DRIFT')
  return task as unknown as A0CompiledTask & {
    task_id: string
    fixture_id: string
  }
}

function validateRunner(runner: A0BatchRunnerPort): void {
  validateRunnerDescriptor(
    ownDataValue(runner, 'descriptor', 'A0_RUNNER_DESCRIPTOR_INVALID'),
  )
}

function validateRunnerDescriptor(value: unknown): void {
  const descriptor = object(value, 'A0_RUNNER_DESCRIPTOR_INVALID')
  exactKeys(
    descriptor,
    [
      'provider_id',
      'model_id',
      'runtime_tool_policy',
      'real_connectors_enabled',
    ],
    'A0_RUNNER_DESCRIPTOR_KEYS_INVALID',
  )
  exact(descriptor.provider_id, 'opencode-go', 'A0_RUNNER_PROVIDER_DRIFT')
  exact(descriptor.model_id, 'deepseek-v4-flash', 'A0_RUNNER_MODEL_DRIFT')
  exact(
    descriptor.runtime_tool_policy,
    'deny_all_runtime_tools',
    'A0_RUNNER_TOOL_POLICY_DRIFT',
  )
  exact(
    descriptor.real_connectors_enabled,
    false,
    'A0_RUNNER_CONNECTORS_ENABLED',
  )
}

function validateAuthorization(
  authValue: unknown,
  compiled: A0CompiledBatchPlan,
  batch: A0CompiledBatch,
  nowMilliseconds: number,
): asserts authValue is A0BatchAuthorization {
  const auth = object(authValue, 'A0_AUTHORIZATION_INVALID')
  exactKeys(
    auth,
    [
      'type',
      'run_id',
      'plan_sha256',
      'batch_id',
      'batch_sha256',
      'expires_at',
      'authorization_granted',
      'execution_authorized',
      'provider_credit_spend_authorized',
    ],
    'A0_AUTHORIZATION_KEYS_INVALID',
  )
  exact(
    auth.type,
    'commercial_swarm_a0_batch_authorization/v1',
    'A0_AUTHORIZATION_TYPE_INVALID',
  )
  exact(auth.run_id, compiled.run_id, 'A0_AUTHORIZATION_RUN_DRIFT')
  exact(
    auth.plan_sha256,
    compiled.source_plan_sha256,
    'A0_AUTHORIZATION_PLAN_DRIFT',
  )
  exact(auth.batch_id, batch.batch_id, 'A0_AUTHORIZATION_BATCH_DRIFT')
  exact(
    auth.batch_sha256,
    batch.batch_sha256,
    'A0_AUTHORIZATION_BATCH_HASH_DRIFT',
  )
  exact(auth.authorization_granted, true, 'A0_AUTHORIZATION_NOT_GRANTED')
  exact(auth.execution_authorized, true, 'A0_EXECUTION_NOT_AUTHORIZED')
  exact(
    auth.provider_credit_spend_authorized,
    true,
    'A0_PROVIDER_SPEND_NOT_AUTHORIZED',
  )
  const expires = iso(auth.expires_at, 'A0_AUTHORIZATION_EXPIRY_INVALID')
  if (
    !Number.isFinite(nowMilliseconds) ||
    nowMilliseconds >= Date.parse(expires) ||
    nowMilliseconds >= Date.parse(compiled.expires_at)
  )
    fail('A0_AUTHORIZATION_EXPIRED')
}

function validateReserveResult(value: unknown): A0ReserveResult {
  const result = object(value, 'A0_LEDGER_RESULT_INVALID')
  if (result.disposition === 'denied') {
    exactKeys(result, ['disposition', 'reason'], 'A0_LEDGER_RESULT_INVALID')
    if (
      typeof result.reason !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(result.reason)
    )
      fail('A0_LEDGER_RESULT_INVALID')
    return result as unknown as A0ReserveResult
  }
  exactKeys(
    result,
    ['disposition', 'state', 'version'],
    'A0_LEDGER_RESULT_INVALID',
  )
  if (!Number.isSafeInteger(result.version) || Number(result.version) < 1)
    fail('A0_LEDGER_RESULT_INVALID')
  if (result.disposition === 'created') {
    exact(result.state, 'reserved', 'A0_LEDGER_RESULT_INVALID')
    return result as unknown as A0ReserveResult
  }
  if (
    result.disposition !== 'replayed' ||
    !['reserved', 'settled', 'budget_exceeded', 'held_unknown'].includes(
      String(result.state),
    )
  )
    fail('A0_LEDGER_RESULT_INVALID')
  return result as unknown as A0ReserveResult
}

function validKnownOutcome(
  value: unknown,
  batch: A0CompiledBatch,
): value is A0KnownBatchOutcome {
  if (!isObject(value) || value.status !== 'known') return false
  if (
    Object.keys(value).length !== 6 ||
    ![
      'status',
      'provider_id',
      'model_id',
      'model_calls',
      'usage_value_micro_cents',
      'usage_record_id',
    ].every((key) => Object.hasOwn(value, key))
  )
    return false
  return (
    value.provider_id === 'opencode-go' &&
    value.model_id === 'deepseek-v4-flash' &&
    value.model_calls === batch.tasks.length &&
    Number.isSafeInteger(value.usage_value_micro_cents) &&
    Number(value.usage_value_micro_cents) > 0 &&
    typeof value.usage_record_id === 'string' &&
    /^[A-Za-z0-9._:-]{1,200}$/.test(value.usage_record_id)
  )
}

async function holdUnknownOnce(
  holdUnknown: A0BehaviorLedgerPort['holdUnknown'],
  runId: string,
  batchId: string,
  version: number,
): Promise<{
  status: 'held_unknown'
  batch_id: string
  reservation_version: number
}> {
  let held: boolean
  try {
    held = await holdUnknown({
      run_id: runId,
      batch_id: batchId,
      reservation_version: version,
      reason: 'A0_USAGE_UNKNOWN',
    })
  } catch {
    fail('A0_LEDGER_HOLD_CAS_FAILED')
  }
  if (held !== true) fail('A0_LEDGER_HOLD_CAS_FAILED')
  return {
    status: 'held_unknown',
    batch_id: batchId,
    reservation_version: version,
  }
}

function isVerifiedSnapshot(
  value: unknown,
  expectedSha256: string,
): value is { status: 'verified'; snapshot_sha256: string } {
  return (
    isObject(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'status') &&
    Object.hasOwn(value, 'snapshot_sha256') &&
    value.status === 'verified' &&
    value.snapshot_sha256 === expectedSha256
  )
}

function normalize(value: unknown): unknown {
  return normalizeJson(value, new WeakSet<object>())
}

function normalizeJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isDenseArray(value)) {
    if (seen.has(value)) fail('A0_CANONICAL_JSON_INVALID')
    seen.add(value)
    const normalized = value.map((entry) => normalizeJson(entry, seen))
    seen.delete(value)
    return normalized
  }
  if (isObject(value)) {
    if (seen.has(value)) fail('A0_CANONICAL_JSON_INVALID')
    seen.add(value)
    const normalized = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          normalizeJson(
            ownDataValue(value, key, 'A0_CANONICAL_JSON_INVALID'),
            seen,
          ),
        ]),
    )
    seen.delete(value)
    return normalized
  }
  fail('A0_CANONICAL_JSON_INVALID')
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail(code)
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!isObject(value)) fail(code)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return false
  }
  return true
}

function isDenseArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || !Object.hasOwn(value, 'length'))
    return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return false
  }
  return keys.every(
    (key) =>
      key === 'length' ||
      (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)),
  )
}

function ownDataValue(value: unknown, key: string, code: string): unknown {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    nodeTypes.isProxy(value)
  )
    fail(code)
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) fail(code)
  return descriptor.value
}

function bindOwnMethod(value: unknown, key: string, code: string): Function {
  const method = ownDataValue(value, key, code)
  if (typeof method !== 'function') fail(code)
  return method.bind(value)
}

function dateMilliseconds(value: unknown, code: string): number {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Date.prototype
  )
    fail(code)
  const milliseconds = Date.prototype.getTime.call(value)
  if (!Number.isFinite(milliseconds)) fail(code)
  return milliseconds
}

function immutableJsonSnapshot<T>(value: T, code: string): T {
  return cloneAndFreezeJson(value, code, new WeakSet<object>()) as T
}

function cloneAndFreezeJson(
  value: unknown,
  code: string,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isDenseArray(value)) {
    if (seen.has(value)) fail(code)
    seen.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const copy = new Array<unknown>(value.length)
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor)) fail(code)
      copy[index] = cloneAndFreezeJson(descriptor.value, code, seen)
    }
    seen.delete(value)
    return Object.freeze(copy)
  }
  if (isObject(value)) {
    if (seen.has(value)) fail(code)
    seen.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const copy: Record<string, unknown> = {}
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !('value' in descriptor)) fail(code)
      Object.defineProperty(copy, key, {
        value: cloneAndFreezeJson(descriptor.value, code, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    seen.delete(value)
    return Object.freeze(copy)
  }
  fail(code)
}

function sha(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code)
  return value
}

function sealedHandle(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SEALED_HANDLE.test(value)) fail(code)
  return value
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code)
  return value
}

function iso(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(code)
  return value
}

function exact(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) fail(code)
}

function fail(code: string): never {
  throw new A0BehaviorAdmissionError(code)
}
