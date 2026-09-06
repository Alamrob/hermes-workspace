import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { createA1SingleApprovalBrokerAdapter } from './a1-single-approval-broker-adapter.js'
import { A1SingleApprovalBrokerApplicationPort } from './a1-single-approval-broker-application-port.js'
import {
  validateA1SingleApprovalChainAuthorization,
  validateA1SingleApprovalChainRequest,
  type A1SingleApprovalChainAuthorization,
  type A1SingleApprovalChainRequest,
} from './a1-single-approval-chain.js'
import {
  runA1SingleApprovalCoordinator,
  type A1SingleApprovalChainResult,
} from './a1-single-approval-coordinator.js'
import { FileA1HostTimerAttestation } from './a1-host-timer-attestation.js'
import {
  createBrokerApplicationRuntime,
  type BrokerApplicationRuntime,
} from './broker-main.js'
import { PostgresA1SingleApprovalControlCapability } from './postgres-a1-single-approval-control.js'
import { readSealedInputFile } from './sealed-input-file.js'
import { readGroupSecretFile } from './secret-file.js'
import { BROKER_SERVICE_GID } from './simulation-entrypoint.js'

const SEALED_ROOT = '/run/a1-single-approval'
const EXPECTED_PRINCIPAL = 'proptimiza_a1_chain_runner_login'

interface DatabasePort {
  query: Pool['query']
  end(): Promise<void>
}

interface OneShotConfig {
  requestFile: string
  envelopeFile: string
  authorizationFile: string
  timerAttestationFile: string
  databaseUrlFile: string
}

export interface A1SingleApprovalOneShotDependencies {
  readSealed?: (path: string, maximumBytes: number) => Promise<Buffer>
  readDatabaseUrl?: (path: string) => Promise<string>
  createDatabase?: (connectionString: string) => DatabasePort
  createRuntime?: (
    environment: Record<string, string | undefined>,
  ) => Promise<BrokerApplicationRuntime>
  now?: () => Date
}

export class A1SingleApprovalOneShotError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'A1SingleApprovalOneShotError'
  }
}

export async function runA1SingleApprovalOneShot(
  environment: Record<string, string | undefined> = process.env,
  dependencies: A1SingleApprovalOneShotDependencies = {},
  argv: readonly string[] = process.argv.slice(2),
): Promise<A1SingleApprovalChainResult> {
  const config = loadOneShotConfig(environment, argv)
  const readSealed = dependencies.readSealed ?? ((path, maximumBytes) =>
    readSealedInputFile(path, {
      root: SEALED_ROOT,
      expectedGid: BROKER_SERVICE_GID,
      maximumBytes,
    }))
  const now = dependencies.now ?? (() => new Date())
  const [requestBytes, envelopeBytes, authorizationBytes] = await Promise.all([
    readSealed(config.requestFile, 1_048_576),
    readSealed(config.envelopeFile, 262_144),
    readSealed(config.authorizationFile, 16_384),
  ])
  const invocation = validateInvocation(
    requestBytes,
    envelopeBytes,
    authorizationBytes,
    now(),
  )
  const databaseUrl = await (dependencies.readDatabaseUrl ?? ((path) =>
    readGroupSecretFile(path, BROKER_SERVICE_GID)))(config.databaseUrlFile)
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl) || databaseUrl.includes('\n'))
    throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_DATABASE_URL_INVALID')
  const database = (dependencies.createDatabase ?? ((connectionString) => new Pool({
    connectionString,
    application_name: 'proptimiza-a1-single-approval-chain',
    max: 1,
    connectionTimeoutMillis: 1_500,
    idleTimeoutMillis: 1_000,
  })))(databaseUrl)
  let runtime: BrokerApplicationRuntime | undefined
  let completed = false
  try {
    runtime = await (dependencies.createRuntime ?? createBrokerApplicationRuntime)(environment)
    const timer = new FileA1HostTimerAttestation({
      read: () => readSealed(config.timerAttestationFile, 4096),
      binding: {
        requestId: invocation.request.request_id,
        missionId: invocation.request.mission_id,
        authorizationDigestSha256: invocation.request.authorization_digest_sha256,
        requestExpiresAt: invocation.request.expires_at,
      },
      now,
    })
    const control = new PostgresA1SingleApprovalControlCapability({
      database,
      expectedPrincipal: EXPECTED_PRINCIPAL,
      timer,
      dispatcher: {
        runOnce: async () => {
          const processed = await runtime!.dispatcher.runOnce()
          return {
            status: processed ? 'processed' : 'idle',
            processed,
            external_actions: 0,
          }
        },
      },
    })
    await control.ready()
    const port = new A1SingleApprovalBrokerApplicationPort({
      application: runtime.application,
      control,
      shadowReviewBearer: runtime.bearers.shadowReview,
      controlPlaneBearer: runtime.bearers.controlPlane,
      internalBearer: runtime.bearers.internal,
    })
    const adapter = createA1SingleApprovalBrokerAdapter({
      request: invocation.request,
      envelope: invocation.envelope,
      authorizationBytes,
      port,
      now: invocation.startedAt,
    })
    const result = await runA1SingleApprovalCoordinator({
      request: invocation.request,
      envelope: invocation.envelope,
      authorizationBytes,
      adapter,
      now: invocation.startedAt,
    })
    completed = true
    return result
  } finally {
    const closures = await Promise.allSettled([
      runtime?.close() ?? Promise.resolve(),
      database.end(),
    ])
    if (completed && closures.some((item) => item.status === 'rejected'))
      throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_CLOSE_FAILED')
  }
}

function loadOneShotConfig(
  environment: Record<string, string | undefined>,
  argv: readonly string[],
): OneShotConfig {
  if (argv.length !== 0)
    throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_ARGUMENTS_FORBIDDEN')
  const exact = {
    NODE_ENV: 'production',
    COMMERCIAL_MODE: 'simulation',
    A3_ENABLED: 'false',
    HOSTINGER_MAIL_ENABLED: 'false',
    TELEGRAM_APPROVAL_ENABLED: 'false',
    EXTERNAL_RESEARCH_ENABLED: 'false',
    EXTERNAL_ACTION_KILL_SWITCH: 'true',
    DISPATCH_LOOP_MODE: 'manual',
    A1_SINGLE_APPROVAL_RUN_MODE: 'one_shot',
  } as const
  for (const [name, expected] of Object.entries(exact))
    if (environment[name] !== expected)
      throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_BOUNDARY_INVALID')
  if (environment.A1_CHAIN_DATABASE_URL?.trim())
    throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_RAW_SECRET_FORBIDDEN')
  const config = {
    requestFile: sealedPath(environment, 'A1_CHAIN_REQUEST_FILE'),
    envelopeFile: sealedPath(environment, 'A1_CHAIN_ENVELOPE_FILE'),
    authorizationFile: sealedPath(environment, 'A1_CHAIN_AUTHORIZATION_FILE'),
    timerAttestationFile: sealedPath(environment, 'A1_CHAIN_TIMER_ATTESTATION_FILE'),
    databaseUrlFile: secretPath(environment, 'A1_CHAIN_DATABASE_URL_FILE'),
  }
  if (new Set(Object.values(config)).size !== Object.values(config).length)
    throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_FILE_REUSE_FORBIDDEN')
  return config
}

function validateInvocation(
  requestBytes: Buffer,
  envelopeBytes: Buffer,
  authorizationBytes: Buffer,
  startedAt: Date,
): {
  request: A1SingleApprovalChainRequest
  envelope: A1SingleApprovalChainAuthorization
  startedAt: Date
} {
  try {
    const request = validateA1SingleApprovalChainRequest(
      JSON.parse(requestBytes.toString('utf8')),
      startedAt,
    )
    const envelope = validateA1SingleApprovalChainAuthorization(
      JSON.parse(envelopeBytes.toString('utf8')),
      request,
      authorizationBytes,
      startedAt,
    )
    return { request, envelope, startedAt }
  } catch {
    throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_INVOCATION_INVALID')
  }
}

function sealedPath(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const path = required(environment, name)
  if (!path.startsWith(`${SEALED_ROOT}/`) || path.includes('..'))
    throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_SEALED_PATH_INVALID')
  return path
}

function secretPath(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const path = required(environment, name)
  if (!path.startsWith('/run/secrets/') || path.includes('..'))
    throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_SECRET_PATH_INVALID')
  return path
}

function required(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name]?.trim()
  if (!value) throw new A1SingleApprovalOneShotError('A1_ONE_SHOT_CONFIGURATION_INVALID')
  return value
}

function publicFailure(error: unknown): { error_code: string; stage?: string } {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_:-]{2,128}$/.test(error.message)
    ? error.message
    : 'A1_ONE_SHOT_FAILED'
  const stage = error && typeof error === 'object' &&
    typeof (error as Record<string, unknown>).stage === 'string' &&
    /^[a-z_]{3,64}$/.test(String((error as Record<string, unknown>).stage))
    ? String((error as Record<string, unknown>).stage)
    : undefined
  return stage ? { error_code: code, stage } : { error_code: code }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runA1SingleApprovalOneShot())}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema_version: 1,
      type: 'a1_single_approval_chain_failure_r307',
      status: 'failed',
      ...publicFailure(error),
      retry_attempted: false,
      external_actions: 0,
      crm_writes: 0,
    })}\n`)
    process.exitCode = 1
  }
}
