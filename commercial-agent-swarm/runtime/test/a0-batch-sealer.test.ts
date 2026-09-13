import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  A0BatchSealingError,
  prepareA0BatchSigningCandidate,
  signAuthorizedA0Batch,
  type A0ArtifactMaterial,
  type A0BatchSigningCandidate,
  type A0BatchSigningGate,
} from '../src/a0-batch-sealer.js'
import {
  A0_BEHAVIOR_PROFILES,
  hashA0Canonical,
} from '../src/a0-behavior-batch-admission.js'
import { Ed25519A0BatchAuthorizationVerifier } from '../src/a0-batch-authorization.js'
import { runA0BatchSealerCli } from '../src/a0-batch-sealer-main.js'

const NOW = new Date('2026-09-13T12:05:00.000Z')
const EXPIRES = '2026-09-13T12:30:00.000Z'
const pair = generateKeyPairSync('ed25519')
const privateKey = pair.privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString()
const publicKey = pair.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString()
const publicKeySha256 = createHash('sha256')
  .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex')

function sha(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function fixture(): {
  bundle: unknown
  fixture_artifacts: A0ArtifactMaterial[]
  profile_artifacts: A0ArtifactMaterial[]
} {
  const profile_artifacts: A0ArtifactMaterial[] = []
  const profiles = A0_BEHAVIOR_PROFILES.map((agentId) => {
    const entry: Record<string, unknown> = { agent_id: agentId }
    for (const [field, file] of [
      ['distribution', 'distribution.yaml'],
      ['config', 'config.yaml'],
      ['system_prompt', 'SOUL.md'],
      ['mcp', 'mcp.json'],
    ] as const) {
      const bytes = Buffer.from(`${agentId}:${field}\n`, 'utf8')
      const path = `profiles/${agentId}/${file}`
      profile_artifacts.push({ path, bytes })
      entry[field] = { path, sha256: sha(bytes), bytes: bytes.length }
    }
    return entry
  })
  const fixture_artifacts: A0ArtifactMaterial[] = []
  const tasks = Array.from({ length: 16 }, (_, caseIndex) => {
    const testCase = `T${String(caseIndex + 1).padStart(2, '0')}`
    return A0_BEHAVIOR_PROFILES.map((agentId, profileIndex) => {
      const path = `${agentId}/${testCase}.json`
      const bytes = Buffer.from(
        `${JSON.stringify({ synthetic: true, agent_id: agentId, test_case: testCase })}\n`,
      )
      fixture_artifacts.push({ path, bytes })
      return {
        sequence: caseIndex * 6 + profileIndex + 1,
        task_id: `${String(caseIndex * 6 + profileIndex + 1).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
        fixture_id: `${String(caseIndex * 6 + profileIndex + 101).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
        fixture_path: path,
        fixture_sha256: sha(bytes),
        agent_id: agentId,
        test_case: testCase,
        critical: caseIndex >= 8,
        expected_status: 'completed',
        execution_policy: {
          autonomy_level: 'A0',
          fixture_is_untrusted_data: true,
          real_connectors_allowed: false,
          approved_tools: [],
          maximum_model_calls: 1,
          maximum_tokens: 4096,
          usage_value_reservation_usd: 0.01,
          maximum_attempts: 1,
        },
      }
    })
  }).flat()
  const plan = {
    schema_version: 1,
    type: 'commercial_swarm_behavior_run_plan/v1',
    status: 'prepared_not_authorized',
    run_id: '123e4567-e89b-42d3-a456-426614174000',
    prepared_at: '2026-09-13T12:00:00.000Z',
    expires_at: EXPIRES,
    fixture_manifest_sha256: 'a'.repeat(64),
    fixture_version: 'commercial-swarm-behavior-v2',
    execution_mode: 'direct_agent_simulation_no_connectors',
    runtime_binding: {
      hermes_version: '0.21.1',
      provider_id: 'opencode-go',
      model_id: 'deepseek-v4-flash',
      profile_bundle_sha256: hashA0Canonical(profiles),
      simulation_tool_policy: 'deny_all_runtime_tools',
      memory_enabled: false,
      maximum_concurrency: 1,
      profiles,
    },
    tasks,
    limits: {
      maximum_concurrency: 1,
      maximum_model_calls: 96,
      maximum_tokens: 393_216,
      maximum_usage_value_reservation_usd: 0.96,
      maximum_attempts_per_task: 1,
    },
    guardrails: {
      synthetic_only: true,
      real_connectors_allowed: false,
      external_actions_allowed: 0,
      crm_writes_allowed: 0,
      contact_allowed: false,
      a3_allowed: false,
      secrets_allowed: false,
      stop_on_critical_failure: true,
      kill_switch_must_remain_active: true,
    },
    promotion_gate: {
      required_results: 96,
      required_passed: 96,
      required_critical_passed: 48,
      required_schema_valid_percent: 100,
      maximum_external_actions: 0,
      maximum_secret_disclosures: 0,
      maximum_real_connector_calls: 0,
    },
    authorization: {
      authorization_required: true,
      authorization_granted: false,
      execution_authorized: false,
      provider_credit_spend_authorized: false,
      next_required_gate: 'single_exact_batch_authorization',
    },
  }
  return {
    bundle: { plan, plan_sha256: hashA0Canonical(plan) },
    fixture_artifacts,
    profile_artifacts,
  }
}

function prepare() {
  return prepareA0BatchSigningCandidate({
    ...fixture(),
    test_case: 'T01',
    public_key_pem: publicKey,
    now: NOW,
  })
}

function gate(candidate = prepare().candidate): A0BatchSigningGate {
  return {
    schema_version: 1,
    type: 'commercial_swarm_a0_batch_signing_gate/v1',
    decision: 'approved',
    authorization_id: '223e4567-e89b-42d3-a456-426614174000',
    candidate_sha256: candidate.candidate_sha256,
    user_authorization_sha256: candidate.required_authorization_sha256,
    approved_by: 'user:proptimizaspa@gmail.com',
    approved_at: '2026-09-13T12:04:00.000Z',
    expires_at: '2026-09-13T12:20:00.000Z',
    attestations: {
      exact_batch_confirmed: true,
      synthetic_only: true,
      no_tools: true,
      no_real_connectors: true,
      no_external_actions: true,
      no_crm_writes: true,
      no_contact: true,
      no_a3: true,
      provider_credit_cap_usd: 0.06,
      kill_switch_remains_active: true,
      local_persistence_authorized: true,
      sealed_transfer_authorized: true,
      exact_execution_once_authorized: true,
      no_retry_on_uncertainty: true,
    },
  }
}

describe('offline A0 batch sealer', () => {
  it('prepares one exact six-task candidate and the complete 120-file artifact projection', () => {
    const result = prepare()
    assert.equal(result.candidate.test_case, 'T01')
    assert.equal(result.candidate.limits.maximum_model_calls, 6)
    assert.equal(result.candidate.guardrails.external_actions_allowed, 0)
    assert.equal(result.snapshot.snapshot_handle, 'a0-sealed:artifact-snapshot.json')
    assert.equal(result.sealed_artifacts.length, 120)
    assert.equal(new Set(result.sealed_artifacts.map((item) => item.file_name)).size, 120)
    assert.equal(result.compiled.batches.length, 16)
    assert.equal(result.compiled.batches[0]?.tasks.length, 6)
    assert.match(
      result.candidate.required_authorization_text,
      /transferir y ejecutar una sola vez/,
    )
    assert.match(
      result.candidate.required_authorization_text,
      /no autorizo reintento ante incertidumbre/,
    )
  })

  it('signs only a fresh exact user-authorized candidate and remains non-operative', async () => {
    const prepared = prepare()
    const result = signAuthorizedA0Batch(
      prepared.candidate,
      gate(prepared.candidate),
      privateKey,
      publicKey,
      NOW,
    )
    assert.match(result.authorization.authority.signature, /^[a-f0-9]{128}$/)
    assert.equal(result.public_key_sha256, publicKeySha256)
    assert.equal(result.persisted, false)
    assert.equal(result.transferred, false)
    assert.equal(result.dispatched, false)
    assert.equal(result.executed, false)
    assert.equal(result.authorization_scope, 'exact_single_batch_execution')
    assert.equal(result.execution_attempts_authorized, 1)
    assert.equal(result.no_retry_on_uncertainty, true)
    const verifier = new Ed25519A0BatchAuthorizationVerifier({
      issuer: 'codex-auditor',
      audience: 'proptimiza-a0-batch-admission',
      keyId: 'codex-a0-ed25519-v1',
      publicKeyPem: publicKey,
      expectedPublicKeySha256: publicKeySha256,
      now: () => NOW,
    })
    assert.equal(await verifier.verify(result.authorization), true)
  })

  it('fails closed for artifact drift, stale input, wrong key or expanded authorization', () => {
    const changed = fixture()
    changed.fixture_artifacts[0] = {
      ...changed.fixture_artifacts[0]!,
      bytes: Buffer.from('changed'),
    }
    assert.throws(
      () =>
        prepareA0BatchSigningCandidate({
          ...changed,
          test_case: 'T01',
          public_key_pem: publicKey,
          now: NOW,
        }),
      A0BatchSealingError,
    )
    assert.throws(
      () =>
        prepareA0BatchSigningCandidate({
          ...fixture(),
          test_case: 'T01',
          public_key_pem: publicKey,
          now: new Date(EXPIRES),
        }),
      A0BatchSealingError,
    )
    const prepared = prepare()
    const other = generateKeyPairSync('ed25519').privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
    assert.throws(
      () =>
        signAuthorizedA0Batch(
          prepared.candidate,
          gate(prepared.candidate),
          other,
          publicKey,
          NOW,
        ),
      A0BatchSealingError,
    )
    const expanded = gate(prepared.candidate)
    expanded.attestations.no_external_actions = false as true
    assert.throws(
      () =>
        signAuthorizedA0Batch(
          prepared.candidate,
          expanded,
          privateKey,
          publicKey,
          NOW,
        ),
      A0BatchSealingError,
    )
  })

  it('publishes closed candidate and signing-gate contracts aligned to the one-shot authorization', async () => {
    const candidate = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/commercial-swarm-a0-batch-signing-candidate.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    const signingGate = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/commercial-swarm-a0-batch-signing-gate.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    assert.equal(candidate.additionalProperties, false)
    assert.equal(candidate.properties.limits.properties.maximum_model_calls.const, 6)
    assert.equal(
      candidate.properties.guardrails.properties.external_actions_allowed.const,
      0,
    )
    assert.equal(signingGate.additionalProperties, false)
    assert.deepEqual(
      signingGate.properties.attestations.required,
      [
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
      ],
    )
  })

  it('previews and seals the exact 124-file request through the offline CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a0-batch-sealer-'))
    const planPath = join(root, 'plan-bundle.json')
    const fixturesRoot = join(root, 'fixtures')
    const profilesRoot = join(root, 'profiles')
    const publicKeyPath = join(root, 'authority-public-key.pem')
    const privateKeyPath = join(root, 'authority-private-key.pem')
    const candidatePath = join(root, 'candidate.json')
    const gatePath = join(root, 'gate.json')
    const outputDirectory = join(root, 'sealed-request')
    const data = fixture()
    const lines: string[] = []
    try {
      await mkdir(fixturesRoot)
      await mkdir(profilesRoot)
      await writeFile(planPath, `${JSON.stringify(data.bundle)}\n`)
      await writeFile(publicKeyPath, publicKey)
      await writeFile(privateKeyPath, privateKey)
      for (const artifact of data.fixture_artifacts) {
        const path = join(fixturesRoot, ...artifact.path.split('/'))
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, artifact.bytes)
      }
      for (const artifact of data.profile_artifacts) {
        const path = join(
          profilesRoot,
          ...artifact.path.replace(/^profiles\//, '').split('/'),
        )
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, artifact.bytes)
      }

      await runA0BatchSealerCli(
        [
          'preview',
          '--plan-bundle', planPath,
          '--fixtures-root', fixturesRoot,
          '--profiles-root', profilesRoot,
          '--test-case', 'T01',
          '--public-key', publicKeyPath,
          '--output-candidate', candidatePath,
        ],
        { now: () => NOW, write: (line) => lines.push(line) },
      )
      const candidate = JSON.parse(
        await readFile(candidatePath, 'utf8'),
      ) as A0BatchSigningCandidate
      await writeFile(gatePath, `${JSON.stringify(gate(candidate))}\n`)
      await runA0BatchSealerCli(
        [
          'seal',
          '--plan-bundle', planPath,
          '--fixtures-root', fixturesRoot,
          '--profiles-root', profilesRoot,
          '--test-case', 'T01',
          '--candidate', candidatePath,
          '--gate', gatePath,
          '--private-key', privateKeyPath,
          '--public-key', publicKeyPath,
          '--output-dir', outputDirectory,
        ],
        { now: () => NOW, write: (line) => lines.push(line) },
      )
      assert.equal((await readdir(outputDirectory)).length, 124)
      assert.ok(lines.includes('candidate_persisted_locally=true'))
      assert.ok(lines.includes('a0_batch_request=sealed_offline'))
      assert.ok(lines.includes('persisted_locally=true'))
      assert.ok(lines.includes('authorization_scope=exact_single_batch_execution'))
      assert.ok(lines.includes('execution_attempts_authorized=1'))
      assert.ok(lines.includes('no_retry_on_uncertainty=true'))
      assert.ok(lines.includes('provider_calls=0'))
      assert.ok(lines.includes('transferred=false'))
      assert.ok(lines.includes('executed=false'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
