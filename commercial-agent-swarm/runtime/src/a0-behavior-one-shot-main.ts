import { createHash, createPublicKey } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import {
  compileA0BehaviorBatchPlan,
  createA0BehaviorBatchAdmission,
  validateA0BatchAuthorizationForPlan,
  type A0ArtifactSnapshotVerifierPort,
  type A0AuthorizationVerifierPort,
  type A0BatchAuthorization,
  type A0CompiledBatchPlan,
} from './a0-behavior-batch-admission.js'
import {
  A0_EXECUTOR_CREDENTIAL_HANDLE,
  PosixA0FixtureReader,
  ProtectedA0BehaviorBatchRunner,
  StaticA0ExecutorCredentialProvider,
} from './a0-behavior-manual-runner.js'
import { Ed25519A0BatchAuthorizationVerifier } from './a0-batch-authorization.js'
import {
  createOpenCodeUsageProbeFromEnvironment,
  type OpenCodeUsageProbeFactoryResult,
} from './integration-factories.js'
import {
  A0_SEALED_ARTIFACT_ROOT,
  PosixA0ArtifactSnapshotVerifier,
} from './posix-a0-artifact-snapshot-verifier.js'
import { PostgresA0BehaviorLedger } from './postgres-a0-behavior-ledger.js'
import { EXECUTOR_SOCKET_PATH } from './runtime-config.js'
import { readSealedInputFile } from './sealed-input-file.js'
import { readGroupSecretFile } from './secret-file.js'
import { BROKER_SERVICE_GID } from './simulation-entrypoint.js'
import { UnixExecutorClient } from './unix-executor-client.js'

const EXPECTED_PRINCIPAL = 'proptimiza_a0_behavior_ledger_login'
const AUTHORIZATION_ISSUER = 'codex-auditor'
const AUTHORIZATION_AUDIENCE = 'proptimiza-a0-batch-admission'
const AUTHORIZATION_KEY_ID = 'codex-a0-ed25519-v1'
const EXECUTION_TIMEOUT_MS = 180_000
const CLIENT_TIMEOUT_MS = 210_000
const SHA256 = /^[a-f0-9]{64}$/
const ALLOWED_SECRET_FILE_ENVIRONMENT = new Set([
  'A0_BEHAVIOR_LEDGER_DATABASE_URL_FILE',
  'OPENCODE_USAGE_TOKEN_FILE',
])

interface DatabasePort {
  query: Pool['query']
  end(): Promise<void>
}

interface OneShotConfig {
  planBundleFile: string
  artifactSnapshotFile: string
  authorizationFile: string
  publicKeyFile: string
  databaseUrlFile: string
  expectedPublicKeySha256: string
}

type Admission = ReturnType<typeof createA0BehaviorBatchAdmission>
type AdmissionOutcome = Awaited<ReturnType<Admission['admit']>>

export interface A0BehaviorOneShotPreparedInvocation {
  compiled: A0CompiledBatchPlan
  authorization: A0BatchAuthorization
  authorizationVerifier: A0AuthorizationVerifierPort
  artifactSnapshotVerifier: A0ArtifactSnapshotVerifierPort
}

export type A0BehaviorOneShotResult = {
  schema_version: 1
  type: 'commercial_swarm_a0_batch_one_shot_result/v1'
  status:
    | 'settled'
    | 'budget_exceeded'
    | 'settlement_unconfirmed'
    | 'held_unknown'
    | 'reservation_replayed'
  reservation_state?: 'reserved' | 'settled' | 'budget_exceeded' | 'held_unknown'
  run_id: string
  batch_id: string
  reservation_version: number
  retry_attempted: false
  external_actions: 0
  real_connector_calls: 0
  crm_writes: 0
}

export interface A0BehaviorOneShotDependencies {
  readSealed?: (path: string, maximumBytes: number) => Promise<Buffer>
  readDatabaseUrl?: (path: string) => Promise<string>
  createDatabase?: (connectionString: string) => DatabasePort
  createUsage?: (
    environment: Record<string, string | undefined>,
  ) => OpenCodeUsageProbeFactoryResult
  prepareInvocation?: (input: {
    config: OneShotConfig
    readSealed: (path: string, maximumBytes: number) => Promise<Buffer>
    now: Date
    clock: () => Date
  }) => Promise<A0BehaviorOneShotPreparedInvocation>
  runPrepared?: (input: {
    database: DatabasePort
    environment: Record<string, string | undefined>
    usage: Extract<OpenCodeUsageProbeFactoryResult, { enabled: true }>
    prepared: A0BehaviorOneShotPreparedInvocation
    clock: () => Date
  }) => Promise<AdmissionOutcome>
  now?: () => Date
}

export class A0BehaviorOneShotError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'A0BehaviorOneShotError'
  }
}

export async function runA0BehaviorOneShot(
  environment: Record<string, string | undefined> = process.env,
  dependencies: A0BehaviorOneShotDependencies = {},
  argv: readonly string[] = process.argv.slice(2),
): Promise<A0BehaviorOneShotResult> {
  const config = loadOneShotConfig(environment, argv)
  const usage = (dependencies.createUsage ??
    createOpenCodeUsageProbeFromEnvironment)(environment)
  if (!usage.enabled)
    throw new A0BehaviorOneShotError(
      'A0_ONE_SHOT_USAGE_RECONCILIATION_REQUIRED',
    )
  const clock = dependencies.now ?? (() => new Date())
  const now = clock()
  if (!Number.isFinite(now.getTime()))
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_TIME_INVALID')
  const readSealed =
    dependencies.readSealed ??
    ((path, maximumBytes) =>
      readSealedInputFile(path, {
        root: A0_SEALED_ARTIFACT_ROOT,
        expectedGid: BROKER_SERVICE_GID,
        maximumBytes,
      }))
  const prepared = await (
    dependencies.prepareInvocation ?? prepareA0BehaviorOneShotInvocation
  )({ config, readSealed, now, clock })

  const databaseUrl = await (
    dependencies.readDatabaseUrl ??
    ((path) => readGroupSecretFile(path, BROKER_SERVICE_GID))
  )(config.databaseUrlFile)
  if (
    !/^postgres(?:ql)?:\/\//.test(databaseUrl) ||
    /[\r\n\0]/.test(databaseUrl)
  )
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_DATABASE_URL_INVALID')
  const database = (
    dependencies.createDatabase ??
    ((connectionString) =>
      new Pool({
        connectionString,
        application_name: 'proptimiza-a0-behavior-one-shot',
        max: 1,
        connectionTimeoutMillis: 1_500,
        idleTimeoutMillis: 1_000,
      }))
  )(databaseUrl)
  let completed = false
  try {
    const outcome = validateOutcome(
      await (dependencies.runPrepared ?? runPreparedInvocation)({
        database,
        environment,
        usage,
        prepared,
        clock,
      }),
      prepared,
    )
    completed = true
    return {
      schema_version: 1,
      type: 'commercial_swarm_a0_batch_one_shot_result/v1',
      status: outcome.status,
      ...(outcome.status === 'reservation_replayed'
        ? { reservation_state: outcome.reservation_state }
        : {}),
      run_id: prepared.compiled.run_id,
      batch_id: outcome.batch_id,
      reservation_version: outcome.reservation_version,
      retry_attempted: false,
      external_actions: 0,
      real_connector_calls: 0,
      crm_writes: 0,
    }
  } finally {
    const closure = await Promise.allSettled([database.end()])
    if (completed && closure[0]?.status === 'rejected')
      throw new A0BehaviorOneShotError('A0_ONE_SHOT_CLOSE_FAILED')
  }
}

export async function prepareA0BehaviorOneShotInvocation(input: {
  config: OneShotConfig
  readSealed: (path: string, maximumBytes: number) => Promise<Buffer>
  now: Date
  clock: () => Date
}): Promise<A0BehaviorOneShotPreparedInvocation> {
  const [bundleBytes, snapshotBytes, authorizationBytes, publicKeyBytes] =
    await Promise.all([
      input.readSealed(input.config.planBundleFile, 2_097_152),
      input.readSealed(input.config.artifactSnapshotFile, 1_048_576),
      input.readSealed(input.config.authorizationFile, 16_384),
      input.readSealed(input.config.publicKeyFile, 16_384),
    ])
  const compiled = compileA0BehaviorBatchPlan(
    parseJson(bundleBytes),
    parseJson(snapshotBytes),
  )
  if (
    input.config.artifactSnapshotFile !==
    sealedHandlePath(compiled.sealed_artifact_snapshot.snapshot_handle)
  )
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_SNAPSHOT_PATH_DRIFT')
  const authorization = validateA0BatchAuthorizationForPlan(
    parseJson(authorizationBytes),
    compiled,
    input.now,
  )
  const publicKeyPem = decodeUtf8(publicKeyBytes)
  if (
    !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(publicKeyPem) ||
    !/\r?\n-----END PUBLIC KEY-----\s*$/.test(publicKeyPem) ||
    publicKeyPem.includes('PRIVATE KEY')
  )
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_PUBLIC_KEY_INVALID')
  assertPublicKeyFingerprint(
    publicKeyPem,
    input.config.expectedPublicKeySha256,
  )
  const authorizationVerifier = new Ed25519A0BatchAuthorizationVerifier({
    issuer: AUTHORIZATION_ISSUER,
    audience: AUTHORIZATION_AUDIENCE,
    keyId: AUTHORIZATION_KEY_ID,
    publicKeyPem,
    expectedPublicKeySha256: input.config.expectedPublicKeySha256,
    now: input.clock,
  })
  if (!(await authorizationVerifier.verify(authorization)))
    throw new A0BehaviorOneShotError(
      'A0_ONE_SHOT_AUTHORIZATION_UNVERIFIED',
    )
  const artifactSnapshotVerifier = new PosixA0ArtifactSnapshotVerifier({
    expectedGid: BROKER_SERVICE_GID,
    readSealed: (path, options) =>
      input.readSealed(path, options.maximumBytes),
  })
  const snapshot = await artifactSnapshotVerifier.verify(
    compiled.sealed_artifact_snapshot,
  )
  if (snapshot.status !== 'verified')
    throw new A0BehaviorOneShotError(
      'A0_ONE_SHOT_ARTIFACT_SNAPSHOT_UNVERIFIED',
    )
  return {
    compiled,
    authorization,
    authorizationVerifier,
    artifactSnapshotVerifier,
  }
}

async function runPreparedInvocation(input: {
  database: DatabasePort
  environment: Record<string, string | undefined>
  usage: Extract<OpenCodeUsageProbeFactoryResult, { enabled: true }>
  prepared: A0BehaviorOneShotPreparedInvocation
  clock: () => Date
}): Promise<AdmissionOutcome> {
  const ledger = new PostgresA0BehaviorLedger({
    database: input.database,
    expectedPrincipal: EXPECTED_PRINCIPAL,
  })
  await ledger.ready()
  const runner = new ProtectedA0BehaviorBatchRunner({
    executor: new UnixExecutorClient({
      socketPath: EXECUTOR_SOCKET_PATH,
      timeoutMs: CLIENT_TIMEOUT_MS,
      requireExecutionLease: true,
    }),
    usageProbe: input.usage.probe,
    usageServiceAccountId: input.usage.serviceAccountId,
    executionAuthority: ledger,
    fixtureReader: new PosixA0FixtureReader({
      expectedGid: BROKER_SERVICE_GID,
    }),
    executionTimeoutMs: EXECUTION_TIMEOUT_MS,
    expectedProfileBundleSha256:
      input.prepared.compiled.profile_bundle_sha256,
  })
  if (
    A0_EXECUTOR_CREDENTIAL_HANDLE !==
    'a0-credential:executor-managed-opencode-go-v1'
  )
    throw new A0BehaviorOneShotError(
      'A0_ONE_SHOT_CREDENTIAL_HANDLE_DRIFT',
    )
  return createA0BehaviorBatchAdmission({
    artifactSnapshotVerifier: input.prepared.artifactSnapshotVerifier,
    authorizationVerifier: input.prepared.authorizationVerifier,
    ledger,
    credential: new StaticA0ExecutorCredentialProvider(),
    runner,
    now: input.clock,
  }).admit({
    compiled: input.prepared.compiled,
    batch_id: input.prepared.authorization.batch_id,
    authorization: input.prepared.authorization,
    now: input.clock(),
  })
}

function loadOneShotConfig(
  environment: Record<string, string | undefined>,
  argv: readonly string[],
): OneShotConfig {
  if (argv.length !== 0)
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_ARGUMENTS_FORBIDDEN')
  const exact = {
    NODE_ENV: 'production',
    COMMERCIAL_MODE: 'simulation',
    A3_ENABLED: 'false',
    HOSTINGER_MAIL_ENABLED: 'false',
    TELEGRAM_APPROVAL_ENABLED: 'false',
    EXTERNAL_RESEARCH_ENABLED: 'false',
    EXTERNAL_ACTION_KILL_SWITCH: 'true',
    DISPATCH_LOOP_MODE: 'manual',
    A0_BEHAVIOR_RUN_MODE: 'one_shot',
    A0_REAL_CONNECTORS_ENABLED: 'false',
    EXECUTOR_SOCKET_PATH,
    OPENCODE_USAGE_RECONCILIATION_ENABLED: 'true',
  } as const
  for (const [name, expected] of Object.entries(exact))
    if (environment[name] !== expected)
      throw new A0BehaviorOneShotError('A0_ONE_SHOT_BOUNDARY_INVALID')
  if (
    environment.A0_BEHAVIOR_LEDGER_DATABASE_URL?.trim() ||
    environment.OPENCODE_USAGE_TOKEN?.trim() ||
    environment.CUSTOM_API_KEY?.trim() ||
    environment.CUSTOM_API_KEY_FILE?.trim() ||
    environment.DATABASE_URL?.trim() ||
    Object.entries(environment).some(
      ([name, value]) =>
        Boolean(value?.trim()) &&
        !ALLOWED_SECRET_FILE_ENVIRONMENT.has(name) &&
        (/(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|COOKIE|PRIVATE_KEY|API_KEY|ACCESS_KEY|CLIENT_SECRET)(?:$|_)/i.test(
          name,
        ) ||
          /^(?:PGPASSWORD|PGPASSFILE)$/i.test(name)),
    ) ||
    Object.entries(environment).some(
      ([name, value]) =>
        Boolean(value?.trim()) && /^A0_.*PRIVATE.*KEY/i.test(name),
    )
  )
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_RAW_SECRET_FORBIDDEN')
  const config = {
    planBundleFile: sealedPath(
      environment,
      'A0_BEHAVIOR_PLAN_BUNDLE_FILE',
    ),
    artifactSnapshotFile: sealedPath(
      environment,
      'A0_BEHAVIOR_ARTIFACT_SNAPSHOT_FILE',
    ),
    authorizationFile: sealedPath(
      environment,
      'A0_BEHAVIOR_BATCH_AUTHORIZATION_FILE',
    ),
    publicKeyFile: sealedPath(
      environment,
      'A0_BEHAVIOR_AUTHORITY_PUBLIC_KEY_FILE',
    ),
    databaseUrlFile: secretPath(
      environment,
      'A0_BEHAVIOR_LEDGER_DATABASE_URL_FILE',
    ),
    expectedPublicKeySha256: required(
      environment,
      'A0_BEHAVIOR_AUTHORITY_PUBLIC_KEY_SHA256',
    ),
  }
  if (!SHA256.test(config.expectedPublicKeySha256))
    throw new A0BehaviorOneShotError(
      'A0_ONE_SHOT_PUBLIC_KEY_SHA256_INVALID',
    )
  const paths = [
    config.planBundleFile,
    config.artifactSnapshotFile,
    config.authorizationFile,
    config.publicKeyFile,
    config.databaseUrlFile,
  ]
  if (new Set(paths).size !== paths.length)
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_FILE_REUSE_FORBIDDEN')
  return config
}

function validateOutcome(
  value: AdmissionOutcome,
  prepared: A0BehaviorOneShotPreparedInvocation,
): AdmissionOutcome {
  if (
    !value ||
    typeof value !== 'object' ||
    value.batch_id !== prepared.authorization.batch_id ||
    !Number.isSafeInteger(value.reservation_version) ||
    value.reservation_version < 1 ||
    ![
      'settled',
      'budget_exceeded',
      'settlement_unconfirmed',
      'held_unknown',
      'reservation_replayed',
    ].includes(value.status) ||
    (value.status === 'reservation_replayed' &&
      !['reserved', 'settled', 'budget_exceeded', 'held_unknown'].includes(
        value.reservation_state,
      ))
  )
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_OUTCOME_INVALID')
  return value
}

function sealedPath(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const path = required(environment, name)
  if (
    !path.startsWith(`${A0_SEALED_ARTIFACT_ROOT}/`) ||
    path.includes('..')
  )
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_SEALED_PATH_INVALID')
  return path
}

function secretPath(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const path = required(environment, name)
  if (!path.startsWith('/run/secrets/') || path.includes('..'))
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_SECRET_PATH_INVALID')
  return path
}

function required(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name]?.trim()
  if (!value)
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_CONFIGURATION_INVALID')
  return value
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes))
  } catch (error) {
    if (error instanceof A0BehaviorOneShotError) throw error
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_JSON_INVALID')
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_UTF8_INVALID')
  }
}

function sealedHandlePath(handle: string): string {
  const match = /^a0-sealed:([A-Za-z0-9._-]{16,200})$/.exec(handle)
  if (!match)
    throw new A0BehaviorOneShotError(
      'A0_ONE_SHOT_SNAPSHOT_HANDLE_INVALID',
    )
  return `${A0_SEALED_ARTIFACT_ROOT}/${match[1]}`
}

function assertPublicKeyFingerprint(
  publicKeyPem: string,
  expected: string,
): void {
  try {
    const key = createPublicKey(publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type')
    const actual = createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex')
    if (actual !== expected) throw new Error('fingerprint')
  } catch {
    throw new A0BehaviorOneShotError('A0_ONE_SHOT_PUBLIC_KEY_INVALID')
  }
}

function publicFailure(error: unknown): { error_code: string } {
  const code =
    error instanceof Error &&
    /^[A-Z][A-Z0-9_:-]{2,128}$/.test(error.message)
      ? error.message
      : 'A0_ONE_SHOT_FAILED'
  return { error_code: code }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await runA0BehaviorOneShot()
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (
      result.status !== 'settled' &&
      !(
        result.status === 'reservation_replayed' &&
        result.reservation_state === 'settled'
      )
    )
      process.exitCode = 2
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schema_version: 1,
        type: 'commercial_swarm_a0_batch_one_shot_failure/v1',
        status: 'failed',
        ...publicFailure(error),
        retry_attempted: false,
        external_actions: 0,
        real_connector_calls: 0,
        crm_writes: 0,
      })}\n`,
    )
    process.exitCode = 1
  }
}
