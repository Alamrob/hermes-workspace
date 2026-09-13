import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as createSignature,
  verify as verifySignature,
} from 'node:crypto'
import {
  A0_BEHAVIOR_PROFILES,
  compileA0BehaviorBatchPlan,
  hashA0Canonical,
  type A0BatchAuthorization,
  type A0CompiledBatchPlan,
  type A0SealedArtifactReference,
  type A0SealedArtifactSnapshot,
} from './a0-behavior-batch-admission.js'
import { canonicalA0BatchAuthorizationBytes } from './a0-batch-authorization.js'

const PROFILE_FILES = [
  ['distribution', 'distribution.yaml'],
  ['config', 'config.yaml'],
  ['system_prompt', 'SOUL.md'],
  ['mcp', 'mcp.json'],
] as const
const SHA256 = /^[a-f0-9]{64}$/
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TEST_CASE = /^T(?:0[1-9]|1[0-6])$/
const MAX_WINDOW_MS = 30 * 60_000
const MAX_FUTURE_SKEW_MS = 30_000
const APPROVER = 'user:proptimizaspa@gmail.com'
const AUTHORITY = Object.freeze({
  issuer: 'codex-auditor',
  audience: 'proptimiza-a0-batch-admission',
  key_id: 'codex-a0-ed25519-v1',
  algorithm: 'Ed25519' as const,
})

export interface A0ArtifactMaterial {
  path: string
  bytes: Uint8Array
}

export interface A0BatchSigningCandidate {
  schema_version: 1
  type: 'commercial_swarm_a0_batch_signing_candidate/v1'
  status: 'authorization_required'
  run_id: string
  plan_sha256: string
  compiled_plan_sha256: string
  batch_id: string
  batch_sha256: string
  test_case: string
  snapshot_sha256: string
  authority: {
    issuer: 'codex-auditor'
    audience: 'proptimiza-a0-batch-admission'
    key_id: 'codex-a0-ed25519-v1'
    algorithm: 'Ed25519'
    public_key_sha256: string
  }
  limits: {
    maximum_model_calls: 6
    maximum_tokens: 24_576
    maximum_provider_credit_spend_usd: 0.06
    maximum_attempts_per_task: 1
  }
  guardrails: {
    autonomy_level: 'A0'
    synthetic_only: true
    approved_tools: []
    real_connectors_allowed: false
    external_actions_allowed: 0
    crm_writes_allowed: 0
    contact_allowed: false
    a3_allowed: false
    kill_switch_must_remain_active: true
  }
  required_authorization_text: string
  required_authorization_sha256: string
  expires_at: string
  candidate_sha256: string
}

export interface A0BatchSigningGate {
  schema_version: 1
  type: 'commercial_swarm_a0_batch_signing_gate/v1'
  decision: 'approved'
  authorization_id: string
  candidate_sha256: string
  user_authorization_sha256: string
  approved_by: 'user:proptimizaspa@gmail.com'
  approved_at: string
  expires_at: string
  attestations: {
    exact_batch_confirmed: true
    synthetic_only: true
    no_tools: true
    no_real_connectors: true
    no_external_actions: true
    no_crm_writes: true
    no_contact: true
    no_a3: true
    provider_credit_cap_usd: 0.06
    kill_switch_remains_active: true
    local_persistence_authorized: true
    sealed_transfer_authorized: true
    exact_execution_once_authorized: true
    no_retry_on_uncertainty: true
  }
}

export interface A0PreparedBatchSigningCandidate {
  candidate: A0BatchSigningCandidate
  snapshot: A0SealedArtifactSnapshot
  compiled: A0CompiledBatchPlan
  sealed_artifacts: ReadonlyArray<{
    logical_path: string
    file_name: string
    bytes: Uint8Array
  }>
}

export interface A0SignedBatchRequest {
  authorization: A0BatchAuthorization
  authorization_sha256: string
  public_key_sha256: string
  persisted: false
  transferred: false
  dispatched: false
  executed: false
  authorization_scope: 'exact_single_batch_execution'
  execution_attempts_authorized: 1
  no_retry_on_uncertainty: true
}

export class A0BatchSealingError extends Error {
  constructor() {
    super('A0_BATCH_SEALING_GATE_CLOSED')
    this.name = 'A0BatchSealingError'
  }
}

/**
 * Pure preparation boundary. It accepts already prepared synthetic artifacts,
 * derives opaque handles and compiles the exact Runtime plan. It has no file,
 * network, database, provider, transfer, dispatch or execution capability.
 */
export function prepareA0BatchSigningCandidate(input: {
  bundle: unknown
  fixture_artifacts: readonly A0ArtifactMaterial[]
  profile_artifacts: readonly A0ArtifactMaterial[]
  test_case: string
  public_key_pem: string
  now: Date
}): A0PreparedBatchSigningCandidate {
  if (!TEST_CASE.test(input.test_case)) closed()
  const bundle = record(input.bundle)
  const plan = record(bundle.plan)
  const preparedAt = exactIso(plan.prepared_at)
  const expiresAt = exactIso(plan.expires_at)
  const now = exactDate(input.now)
  if (
    now.getTime() < Date.parse(preparedAt) - MAX_FUTURE_SKEW_MS ||
    now.getTime() >= Date.parse(expiresAt)
  )
    closed()

  const publicKeySha256 = publicKeyFingerprint(input.public_key_pem)
  const fixtureInputs = exactMaterials(input.fixture_artifacts, 96, 131_072)
  const profileInputs = exactMaterials(input.profile_artifacts, 24, 262_144)
  const tasks = denseArray(plan.tasks)
  const runtimeBinding = record(plan.runtime_binding)
  const profiles = denseArray(runtimeBinding.profiles)

  const fixtureReferences = tasks.map((value, index) => {
    const task = record(value)
    const path = exactString(task.fixture_path)
    const material = takeExactMaterial(fixtureInputs, path)
    const sha256 = digest(material.bytes)
    if (sha256 !== task.fixture_sha256) closed()
    return reference(path, material.bytes, `fixture-${String(index + 1).padStart(3, '0')}-${sha256.slice(0, 32)}.json`)
  })
  if (fixtureInputs.size !== 0) closed()

  const profileReferences: A0SealedArtifactReference[] = []
  for (const [profileIndex, profileValue] of profiles.entries()) {
    const profile = record(profileValue)
    const agentId = exactString(profile.agent_id)
    if (agentId !== A0_BEHAVIOR_PROFILES[profileIndex]) closed()
    for (const [field, file] of PROFILE_FILES) {
      const binding = record(profile[field])
      const path = `profiles/${agentId}/${file}`
      if (binding.path !== path) closed()
      const material = takeExactMaterial(profileInputs, path)
      const sha256 = digest(material.bytes)
      if (sha256 !== binding.sha256 || material.bytes.byteLength !== binding.bytes)
        closed()
      profileReferences.push(
        reference(
          path,
          material.bytes,
          `profile-${String(profileReferences.length + 1).padStart(3, '0')}-${sha256.slice(0, 32)}.bin`,
        ),
      )
    }
  }
  if (profileInputs.size !== 0) closed()

  const snapshotBody = {
    schema_version: 1 as const,
    type: 'commercial_swarm_a0_sealed_artifact_snapshot/v1' as const,
    status: 'sealed' as const,
    fixture_manifest_sha256: exactSha(plan.fixture_manifest_sha256),
    profile_bundle_sha256: exactSha(runtimeBinding.profile_bundle_sha256),
    fixture_artifacts: fixtureReferences,
    profile_artifacts: profileReferences,
    snapshot_handle: 'a0-sealed:artifact-snapshot.json',
  }
  const snapshot: A0SealedArtifactSnapshot = {
    ...snapshotBody,
    snapshot_sha256: hashA0Canonical(snapshotBody),
  }
  const compiled = compileA0BehaviorBatchPlan(input.bundle, snapshot)
  const batch = compiled.batches.find(
    (candidate) => candidate.test_case === input.test_case,
  )
  if (!batch) closed()

  const requiredAuthorizationText = requiredAuthorization({
    runId: compiled.run_id,
    planSha256: compiled.source_plan_sha256,
    batchId: batch.batch_id,
    batchSha256: batch.batch_sha256,
    snapshotSha256: snapshot.snapshot_sha256,
    expiresAt: compiled.expires_at,
  })
  const candidateBody = {
    schema_version: 1 as const,
    type: 'commercial_swarm_a0_batch_signing_candidate/v1' as const,
    status: 'authorization_required' as const,
    run_id: compiled.run_id,
    plan_sha256: compiled.source_plan_sha256,
    compiled_plan_sha256: compiled.compiled_plan_sha256,
    batch_id: batch.batch_id,
    batch_sha256: batch.batch_sha256,
    test_case: batch.test_case,
    snapshot_sha256: snapshot.snapshot_sha256,
    authority: {
      ...AUTHORITY,
      public_key_sha256: publicKeySha256,
    },
    limits: {
      maximum_model_calls: 6 as const,
      maximum_tokens: 24_576 as const,
      maximum_provider_credit_spend_usd: 0.06 as const,
      maximum_attempts_per_task: 1 as const,
    },
    guardrails: {
      autonomy_level: 'A0' as const,
      synthetic_only: true as const,
      approved_tools: [] as [],
      real_connectors_allowed: false as const,
      external_actions_allowed: 0 as const,
      crm_writes_allowed: 0 as const,
      contact_allowed: false as const,
      a3_allowed: false as const,
      kill_switch_must_remain_active: true as const,
    },
    required_authorization_text: requiredAuthorizationText,
    required_authorization_sha256: digest(
      Buffer.from(`${requiredAuthorizationText}\n`, 'utf8'),
    ),
    expires_at: compiled.expires_at,
  }
  const candidate: A0BatchSigningCandidate = {
    ...candidateBody,
    candidate_sha256: hashA0Canonical(candidateBody),
  }
  const allMaterials = [...input.fixture_artifacts, ...input.profile_artifacts]
  const sealedArtifacts = [
    ...fixtureReferences,
    ...profileReferences,
  ].map((item) => {
    const material = allMaterials.find((candidate) => candidate.path === item.path)
    if (!material) closed()
    return Object.freeze({
      logical_path: item.path,
      file_name: item.sealed_handle.slice('a0-sealed:'.length),
      bytes: Uint8Array.from(material.bytes),
    })
  })
  return Object.freeze({
    candidate: structuredClone(candidate),
    snapshot: structuredClone(snapshot),
    compiled: structuredClone(compiled),
    sealed_artifacts: Object.freeze(sealedArtifacts),
  })
}

/**
 * Pure offline signer. The caller must reconstruct the candidate from current
 * inputs before calling it. The result cannot persist, transfer, dispatch or
 * execute the sealed request.
 */
export function signAuthorizedA0Batch(
  candidate: A0BatchSigningCandidate,
  gate: A0BatchSigningGate,
  privateKeyPem: string,
  publicKeyPem: string,
  nowValue: Date,
): A0SignedBatchRequest {
  validateCandidate(candidate)
  validateGate(gate, candidate, nowValue)
  const fingerprint = assertKeyPair(privateKeyPem, publicKeyPem)
  if (fingerprint !== candidate.authority.public_key_sha256) closed()
  const signedAt = exactDate(nowValue).toISOString()
  const authorization: A0BatchAuthorization = {
    type: 'commercial_swarm_a0_batch_authorization/v1',
    run_id: candidate.run_id,
    plan_sha256: candidate.plan_sha256,
    batch_id: candidate.batch_id,
    batch_sha256: candidate.batch_sha256,
    expires_at: gate.expires_at,
    authorization_granted: true,
    execution_authorized: true,
    provider_credit_spend_authorized: true,
    authority: {
      issuer: AUTHORITY.issuer,
      audience: AUTHORITY.audience,
      key_id: AUTHORITY.key_id,
      algorithm: AUTHORITY.algorithm,
      signed_at: signedAt,
      signature: '0'.repeat(128),
    },
  }
  authorization.authority.signature = createSignature(
    null,
    canonicalA0BatchAuthorizationBytes(authorization),
    createPrivateKey(privateKeyPem),
  ).toString('hex')
  if (
    !verifySignature(
      null,
      canonicalA0BatchAuthorizationBytes(authorization),
      createPublicKey(publicKeyPem),
      Buffer.from(authorization.authority.signature, 'hex'),
    )
  )
    closed()
  return {
    authorization,
    authorization_sha256: hashA0Canonical(authorization),
    public_key_sha256: fingerprint,
    persisted: false,
    transferred: false,
    dispatched: false,
    executed: false,
    authorization_scope: 'exact_single_batch_execution',
    execution_attempts_authorized: 1,
    no_retry_on_uncertainty: true,
  }
}

function validateCandidate(candidate: A0BatchSigningCandidate): void {
  exactKeys(candidate, [
    'schema_version',
    'type',
    'status',
    'run_id',
    'plan_sha256',
    'compiled_plan_sha256',
    'batch_id',
    'batch_sha256',
    'test_case',
    'snapshot_sha256',
    'authority',
    'limits',
    'guardrails',
    'required_authorization_text',
    'required_authorization_sha256',
    'expires_at',
    'candidate_sha256',
  ])
  exactKeys(candidate.authority, [
    'issuer',
    'audience',
    'key_id',
    'algorithm',
    'public_key_sha256',
  ])
  exactKeys(candidate.limits, [
    'maximum_model_calls',
    'maximum_tokens',
    'maximum_provider_credit_spend_usd',
    'maximum_attempts_per_task',
  ])
  exactKeys(candidate.guardrails, [
    'autonomy_level',
    'synthetic_only',
    'approved_tools',
    'real_connectors_allowed',
    'external_actions_allowed',
    'crm_writes_allowed',
    'contact_allowed',
    'a3_allowed',
    'kill_switch_must_remain_active',
  ])
  const { candidate_sha256: claim, ...body } = candidate
  const requiredText = requiredAuthorization({
    runId: candidate.run_id,
    planSha256: candidate.plan_sha256,
    batchId: candidate.batch_id,
    batchSha256: candidate.batch_sha256,
    snapshotSha256: candidate.snapshot_sha256,
    expiresAt: exactIso(candidate.expires_at),
  })
  if (
    !SHA256.test(claim) ||
    hashA0Canonical(body) !== claim ||
    candidate.schema_version !== 1 ||
    candidate.type !== 'commercial_swarm_a0_batch_signing_candidate/v1' ||
    candidate.status !== 'authorization_required' ||
    !UUID.test(candidate.run_id) ||
    !SHA256.test(candidate.plan_sha256) ||
    !SHA256.test(candidate.compiled_plan_sha256) ||
    !SHA256.test(candidate.batch_sha256) ||
    !SHA256.test(candidate.snapshot_sha256) ||
    !TEST_CASE.test(candidate.test_case) ||
    candidate.batch_id !==
      `a0:${candidate.run_id}:${candidate.test_case.toLowerCase()}` ||
    candidate.authority.issuer !== AUTHORITY.issuer ||
    candidate.authority.audience !== AUTHORITY.audience ||
    candidate.authority.key_id !== AUTHORITY.key_id ||
    candidate.authority.algorithm !== AUTHORITY.algorithm ||
    !SHA256.test(candidate.authority.public_key_sha256) ||
    candidate.required_authorization_text !== requiredText ||
    candidate.required_authorization_sha256 !==
      digest(Buffer.from(`${candidate.required_authorization_text}\n`, 'utf8')) ||
    candidate.limits.maximum_model_calls !== 6 ||
    candidate.limits.maximum_tokens !== 24_576 ||
    candidate.limits.maximum_provider_credit_spend_usd !== 0.06 ||
    candidate.limits.maximum_attempts_per_task !== 1 ||
    candidate.guardrails.autonomy_level !== 'A0' ||
    candidate.guardrails.synthetic_only !== true ||
    candidate.guardrails.approved_tools.length !== 0 ||
    candidate.guardrails.real_connectors_allowed !== false ||
    candidate.guardrails.external_actions_allowed !== 0 ||
    candidate.guardrails.crm_writes_allowed !== 0 ||
    candidate.guardrails.contact_allowed !== false ||
    candidate.guardrails.a3_allowed !== false ||
    candidate.guardrails.kill_switch_must_remain_active !== true
  )
    closed()
}

function validateGate(
  gate: A0BatchSigningGate,
  candidate: A0BatchSigningCandidate,
  nowValue: Date,
): void {
  exactKeys(gate, [
    'schema_version',
    'type',
    'decision',
    'authorization_id',
    'candidate_sha256',
    'user_authorization_sha256',
    'approved_by',
    'approved_at',
    'expires_at',
    'attestations',
  ])
  exactKeys(gate.attestations, [
    'exact_batch_confirmed',
    'synthetic_only',
    'no_tools',
    'no_real_connectors',
    'no_external_actions',
    'no_crm_writes',
    'no_contact',
    'no_a3',
    'provider_credit_cap_usd',
    'kill_switch_remains_active',
    'local_persistence_authorized',
    'sealed_transfer_authorized',
    'exact_execution_once_authorized',
    'no_retry_on_uncertainty',
  ])
  const now = exactDate(nowValue)
  const approvedAt = Date.parse(exactIso(gate.approved_at))
  const expiresAt = Date.parse(exactIso(gate.expires_at))
  const attestation = gate.attestations
  if (
    gate.schema_version !== 1 ||
    gate.type !== 'commercial_swarm_a0_batch_signing_gate/v1' ||
    gate.decision !== 'approved' ||
    !UUID.test(gate.authorization_id) ||
    gate.candidate_sha256 !== candidate.candidate_sha256 ||
    gate.user_authorization_sha256 !==
      candidate.required_authorization_sha256 ||
    gate.approved_by !== APPROVER ||
    approvedAt > now.getTime() + MAX_FUTURE_SKEW_MS ||
    expiresAt <= now.getTime() ||
    expiresAt <= approvedAt ||
    expiresAt - approvedAt > MAX_WINDOW_MS ||
    expiresAt > Date.parse(candidate.expires_at) ||
    attestation.exact_batch_confirmed !== true ||
    attestation.synthetic_only !== true ||
    attestation.no_tools !== true ||
    attestation.no_real_connectors !== true ||
    attestation.no_external_actions !== true ||
    attestation.no_crm_writes !== true ||
    attestation.no_contact !== true ||
    attestation.no_a3 !== true ||
    attestation.provider_credit_cap_usd !== 0.06 ||
    attestation.kill_switch_remains_active !== true ||
    attestation.local_persistence_authorized !== true ||
    attestation.sealed_transfer_authorized !== true ||
    attestation.exact_execution_once_authorized !== true ||
    attestation.no_retry_on_uncertainty !== true
  )
    closed()
}

function requiredAuthorization(input: {
  runId: string
  planSha256: string
  batchId: string
  batchSha256: string
  snapshotSha256: string
  expiresAt: string
}): string {
  return `Autorizo firmar, persistir localmente, transferir y ejecutar una sola vez exclusivamente el lote A0 sintetico ${input.batchId}, run ${input.runId}, plan ${input.planSha256}, batch ${input.batchSha256}, snapshot ${input.snapshotSha256}, vigente como maximo hasta ${input.expiresAt}. Autorizo hasta 6 llamadas al modelo, 24576 tokens y USD 0.06 de reserva. No autorizo herramientas, conectores reales, contacto, CRM, correo, Telegram, A3 ni acciones externas. El kill switch permanece activo. La autorizacion se consume en el primer intento y no autorizo reintento ante incertidumbre.`
}

function reference(
  path: string,
  bytes: Uint8Array,
  fileName: string,
): A0SealedArtifactReference {
  return {
    path,
    sha256: digest(bytes),
    bytes: bytes.byteLength,
    sealed_handle: `a0-sealed:${fileName}`,
  }
}

function exactMaterials(
  values: readonly A0ArtifactMaterial[],
  count: number,
  maximumBytes: number,
): Map<string, A0ArtifactMaterial> {
  if (!Array.isArray(values) || values.length !== count) closed()
  const result = new Map<string, A0ArtifactMaterial>()
  for (const value of values) {
    if (
      !value ||
      typeof value.path !== 'string' ||
      !(value.bytes instanceof Uint8Array) ||
      value.bytes.byteLength < 1 ||
      value.bytes.byteLength > maximumBytes ||
      result.has(value.path)
    )
      closed()
    result.set(value.path, value)
  }
  return result
}

function takeExactMaterial(
  values: Map<string, A0ArtifactMaterial>,
  path: string,
): A0ArtifactMaterial {
  const result = values.get(path)
  if (!result) closed()
  values.delete(path)
  return result
}

function assertKeyPair(privatePem: string, publicPem: string): string {
  try {
    const privateKey = createPrivateKey(privatePem)
    const expectedPublic = createPublicKey(publicPem)
    if (
      privateKey.asymmetricKeyType !== 'ed25519' ||
      expectedPublic.asymmetricKeyType !== 'ed25519'
    )
      closed()
    const derived = createPublicKey(privateKey).export({
      type: 'spki',
      format: 'der',
    })
    const expected = expectedPublic.export({ type: 'spki', format: 'der' })
    if (!Buffer.from(derived).equals(Buffer.from(expected))) closed()
    return digest(expected)
  } catch (error) {
    if (error instanceof A0BatchSealingError) throw error
    closed()
  }
}

function publicKeyFingerprint(publicPem: string): string {
  try {
    const key = createPublicKey(publicPem)
    if (key.asymmetricKeyType !== 'ed25519') closed()
    return digest(key.export({ type: 'spki', format: 'der' }))
  } catch (error) {
    if (error instanceof A0BatchSealingError) throw error
    closed()
  }
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function exactSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) closed()
  return value
}

function exactString(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1) closed()
  return value
}

function exactIso(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    closed()
  return value
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) closed()
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) closed()
  return value as Record<string, unknown>
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) closed()
  for (let index = 0; index < value.length; index += 1)
    if (!Object.prototype.hasOwnProperty.call(value, index)) closed()
  return value
}

function exactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  )
    closed()
}

function closed(): never {
  throw new A0BatchSealingError()
}
