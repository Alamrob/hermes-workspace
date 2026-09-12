import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  A0BehaviorAdmissionError,
  A0_BEHAVIOR_PROFILES,
  admitA0BehaviorBatch,
  compileA0BehaviorBatchPlan,
  hashA0Canonical,
  usdToMicroCents,
  type A0ArtifactSnapshotVerifierPort,
  type A0BehaviorLedgerPort,
  type A0BatchRunnerPort,
  type A0CompiledBatch,
  type A0CompiledBatchPlan,
  type A0SealedArtifactSnapshot,
} from '../src/a0-behavior-batch-admission.js'
import { createA0BehaviorBatchAdmission } from '../src/runtime-entrypoints.js'

const SHA = 'a'.repeat(64)
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'

function validBundle(): any {
  const profiles = A0_BEHAVIOR_PROFILES.map((agentId) => ({
    agent_id: agentId,
    distribution: {
      path: `profiles/${agentId}/distribution.yaml`,
      sha256: hashA0Canonical([agentId, 'distribution']),
      bytes: 10,
    },
    config: {
      path: `profiles/${agentId}/config.yaml`,
      sha256: hashA0Canonical([agentId, 'config']),
      bytes: 10,
    },
    system_prompt: {
      path: `profiles/${agentId}/SOUL.md`,
      sha256: hashA0Canonical([agentId, 'soul']),
      bytes: 10,
    },
    mcp: {
      path: `profiles/${agentId}/mcp.json`,
      sha256: hashA0Canonical([agentId, 'mcp']),
      bytes: 10,
    },
  }))
  const tasks = Array.from({ length: 16 }, (_, caseIndex) => {
    const testCase = `T${String(caseIndex + 1).padStart(2, '0')}`
    return A0_BEHAVIOR_PROFILES.map((agentId, profileIndex) => ({
      sequence: caseIndex * 6 + profileIndex + 1,
      task_id: `${String(caseIndex * 6 + profileIndex + 1).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
      fixture_id: `${String(caseIndex * 6 + profileIndex + 101).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
      fixture_path: `${agentId}/${testCase}.json`,
      fixture_sha256: hashA0Canonical([agentId, testCase]),
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
    }))
  }).flat()
  const plan = {
    schema_version: 1,
    type: 'commercial_swarm_behavior_run_plan/v1',
    status: 'prepared_not_authorized',
    run_id: RUN_ID,
    prepared_at: '2026-09-12T12:00:00.000Z',
    expires_at: '2026-09-12T12:30:00.000Z',
    fixture_manifest_sha256: SHA,
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
      maximum_tokens: 393216,
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
  return { plan, plan_sha256: hashA0Canonical(plan) }
}

function sealedSnapshot(bundle: any): A0SealedArtifactSnapshot {
  const fixture_artifacts = bundle.plan.tasks.map(
    (task: any, index: number) => ({
      path: task.fixture_path,
      sha256: task.fixture_sha256,
      bytes: 100 + index,
      sealed_handle: `a0-sealed:fixture-${String(index + 1).padStart(3, '0')}-0000000000000000`,
    }),
  )
  const profile_artifacts = bundle.plan.runtime_binding.profiles.flatMap(
    (profile: any) =>
      ['distribution', 'config', 'system_prompt', 'mcp'].map(
        (field, index) => ({
          ...profile[field],
          sealed_handle: `a0-sealed:${profile.agent_id}-${field}-${index}-0000000000000000`,
        }),
      ),
  )
  const body = {
    schema_version: 1 as const,
    type: 'commercial_swarm_a0_sealed_artifact_snapshot/v1' as const,
    status: 'sealed' as const,
    fixture_manifest_sha256: bundle.plan.fixture_manifest_sha256,
    profile_bundle_sha256: bundle.plan.runtime_binding.profile_bundle_sha256,
    fixture_artifacts,
    profile_artifacts,
    snapshot_handle: 'a0-sealed:snapshot-00000000000000000000000000000000',
  }
  return { ...body, snapshot_sha256: hashA0Canonical(body) }
}

function compileValid(): A0CompiledBatchPlan {
  const bundle = validBundle()
  return compileA0BehaviorBatchPlan(bundle, sealedSnapshot(bundle))
}

function rehashSnapshot(snapshot: A0SealedArtifactSnapshot): void {
  const { snapshot_sha256: _claimed, ...body } = snapshot
  snapshot.snapshot_sha256 = hashA0Canonical(body)
}

function rehashCompiled(compiled: A0CompiledBatchPlan): void {
  for (const batch of compiled.batches) {
    const { batch_sha256: _batchClaim, ...batchBody } = batch
    batch.batch_sha256 = hashA0Canonical(batchBody)
  }
  const { compiled_plan_sha256: _planClaim, ...planBody } = compiled
  compiled.compiled_plan_sha256 = hashA0Canonical(planBody)
}

function authorization(batch: A0CompiledBatch) {
  return {
    type: 'commercial_swarm_a0_batch_authorization/v1' as const,
    run_id: RUN_ID,
    plan_sha256: batch.source_plan_sha256,
    batch_id: batch.batch_id,
    batch_sha256: batch.batch_sha256,
    expires_at: '2026-09-12T12:20:00.000Z',
    authorization_granted: true as const,
    execution_authorized: true as const,
    provider_credit_spend_authorized: true as const,
  }
}

function ports(
  events: string[],
  reserveResult: any = {
    disposition: 'created',
    state: 'reserved',
    version: 7,
  },
) {
  const ledger: A0BehaviorLedgerPort = {
    reserve: async () => {
      events.push('reserve')
      return reserveResult
    },
    settle: async () => {
      events.push('settle')
      return true
    },
    holdUnknown: async () => {
      events.push('hold')
      return true
    },
  }
  const runner: A0BatchRunnerPort = {
    descriptor: {
      provider_id: 'opencode-go',
      model_id: 'deepseek-v4-flash',
      runtime_tool_policy: 'deny_all_runtime_tools',
      real_connectors_enabled: false,
    },
    spawn: async () => {
      events.push('spawn')
      return {
        status: 'known',
        provider_id: 'opencode-go',
        model_id: 'deepseek-v4-flash',
        model_calls: 6,
        usage_value_micro_cents: 1_000_000,
        usage_record_id: 'usage-1',
      }
    },
  }
  const artifactSnapshotVerifier: A0ArtifactSnapshotVerifierPort = {
    verify: async (snapshot) => {
      events.push('snapshot')
      return { status: 'verified', snapshot_sha256: snapshot.snapshot_sha256 }
    },
  }
  return {
    artifactSnapshotVerifier,
    authorizationVerifier: {
      verify: async () => {
        events.push('authorize')
        return true
      },
    },
    ledger,
    credential: {
      acquire: async () => {
        events.push('credential')
        return { opaque_handle: 'a0-credential:test-handle-0000000000000000' }
      },
    },
    runner,
  }
}

describe('A0 6x16 behavior compiler', () => {
  it('converts USD to integer microcents without the former 100x undercount', () => {
    assert.equal(usdToMicroCents(0.01), 1_000_000)
    assert.equal(usdToMicroCents(0.06), 6_000_000)
    assert.equal(usdToMicroCents(0.96), 96_000_000)
    assert.throws(() => usdToMicroCents(0.001), /A0_USD_PRECISION_INVALID/)
  })

  it('compiles a deterministic 16 by 6 plan with a dedicated exact A0 contract', () => {
    const firstBundle = validBundle()
    const secondBundle = validBundle()
    const first = compileA0BehaviorBatchPlan(
      firstBundle,
      sealedSnapshot(firstBundle),
    )
    const second = compileA0BehaviorBatchPlan(
      secondBundle,
      sealedSnapshot(secondBundle),
    )
    assert.deepEqual(second, first)
    assert.equal(first.batches.length, 16)
    assert.equal(first.total_tasks, 96)
    assert.equal(first.total_reservation_micro_cents, 96_000_000)
    assert.equal(
      first.batches
        .flatMap((batch) => batch.tasks)
        .filter((task) => task.critical).length,
      48,
    )
    assert.equal(first.sealed_artifact_snapshot.fixture_artifacts.length, 96)
    assert.equal(first.sealed_artifact_snapshot.profile_artifacts.length, 24)
    for (const [index, batch] of first.batches.entries()) {
      assert.equal(batch.sequence, index + 1)
      assert.equal(batch.test_case, `T${String(index + 1).padStart(2, '0')}`)
      assert.deepEqual(
        batch.tasks.map((task) => task.agent_id),
        A0_BEHAVIOR_PROFILES,
      )
      assert.equal(batch.tasks.length, 6)
      assert.equal(batch.reservation_micro_cents, 6_000_000)
      assert.match(batch.batch_sha256, /^[a-f0-9]{64}$/)
    }
    assert.deepEqual(first.execution_contract, {
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
    })
  })

  it('fails closed on source, profile, order, policy and connector drift', () => {
    const mutations: Array<(bundle: any) => void> = [
      (bundle) => {
        bundle.plan_sha256 = SHA
      },
      (bundle) => {
        bundle.plan.runtime_binding.profile_bundle_sha256 = SHA
        bundle.plan_sha256 = hashA0Canonical(bundle.plan)
      },
      (bundle) => {
        ;[bundle.plan.tasks[0], bundle.plan.tasks[1]] = [
          bundle.plan.tasks[1],
          bundle.plan.tasks[0],
        ]
        bundle.plan_sha256 = hashA0Canonical(bundle.plan)
      },
      (bundle) => {
        bundle.plan.tasks[0].execution_policy.maximum_tokens = 6144
        bundle.plan_sha256 = hashA0Canonical(bundle.plan)
      },
      (bundle) => {
        bundle.plan.tasks[0].execution_policy.real_connectors_allowed = true
        bundle.plan_sha256 = hashA0Canonical(bundle.plan)
      },
      (bundle) => {
        bundle.plan.runtime_binding.profiles[0].config.extra = true
        bundle.plan.runtime_binding.profile_bundle_sha256 = hashA0Canonical(
          bundle.plan.runtime_binding.profiles,
        )
        bundle.plan_sha256 = hashA0Canonical(bundle.plan)
      },
    ]
    for (const mutate of mutations) {
      const bundle = validBundle()
      mutate(bundle)
      assert.throws(
        () => compileA0BehaviorBatchPlan(bundle, sealedSnapshot(bundle)),
        A0BehaviorAdmissionError,
      )
    }
  })

  it('requires an exact sealed snapshot with attested bytes, digests and opaque handles', () => {
    const bundle = validBundle()
    assert.throws(
      () => compileA0BehaviorBatchPlan(bundle, undefined),
      /A0_ARTIFACT_SNAPSHOT_INVALID/,
    )

    const cases: Array<(snapshot: A0SealedArtifactSnapshot) => void> = [
      (snapshot) => {
        snapshot.fixture_artifacts[0]!.sha256 = SHA
      },
      (snapshot) => {
        snapshot.fixture_artifacts[0]!.bytes = 0
      },
      (snapshot) => {
        snapshot.fixture_artifacts[0]!.sealed_handle = 'C:\\raw\\fixture.json'
      },
      (snapshot) => {
        snapshot.profile_artifacts[0]!.bytes += 1
      },
      (snapshot) => {
        snapshot.profile_artifacts.reverse()
      },
    ]
    for (const mutate of cases) {
      const snapshot = sealedSnapshot(bundle)
      mutate(snapshot)
      rehashSnapshot(snapshot)
      assert.throws(
        () => compileA0BehaviorBatchPlan(bundle, snapshot),
        A0BehaviorAdmissionError,
      )
    }
  })

  it('requires exactly 48 critical tasks even when the source and snapshot are re-sealed', () => {
    const bundle = validBundle()
    bundle.plan.tasks[0].critical = true
    bundle.plan_sha256 = hashA0Canonical(bundle.plan)
    assert.throws(
      () => compileA0BehaviorBatchPlan(bundle, sealedSnapshot(bundle)),
      /A0_CRITICAL_TASK_COUNT_INVALID/,
    )
  })
})

describe('A0 exact-batch admission', () => {
  it('reserves idempotently before credential acquisition and spawn, then settles with CAS', async () => {
    const compiled = compileValid()
    const batch = compiled.batches[0]
    const events: string[] = []
    const result = await admitA0BehaviorBatch({
      compiled,
      batch_id: batch.batch_id,
      authorization: authorization(batch),
      now: new Date('2026-09-12T12:10:00.000Z'),
      ...ports(events),
    })
    assert.deepEqual(events, [
      'snapshot',
      'authorize',
      'reserve',
      'credential',
      'spawn',
      'settle',
    ])
    assert.deepEqual(result, {
      status: 'settled',
      batch_id: batch.batch_id,
      reservation_version: 7,
    })
  })

  it('does not acquire a credential or spawn on an idempotent reservation replay', async () => {
    const compiled = compileValid()
    const batch = compiled.batches[0]
    const events: string[] = []
    const result = await admitA0BehaviorBatch({
      compiled,
      batch_id: batch.batch_id,
      authorization: authorization(batch),
      now: new Date('2026-09-12T12:10:00.000Z'),
      ...ports(events, {
        disposition: 'replayed',
        state: 'reserved',
        version: 7,
      }),
    })
    assert.deepEqual(events, ['snapshot', 'authorize', 'reserve'])
    assert.deepEqual(result, {
      status: 'reservation_replayed',
      batch_id: batch.batch_id,
      reservation_state: 'reserved',
      reservation_version: 7,
    })
  })

  it('holds the reservation on unknown or uncertain execution outcome', async () => {
    const compiled = compileValid()
    const batch = compiled.batches[0]
    const events: string[] = []
    const base = ports(events)
    base.runner.spawn = async () => {
      events.push('spawn')
      return { status: 'unknown', reason: 'process_outcome_unknown' }
    }
    const result = await admitA0BehaviorBatch({
      compiled,
      batch_id: batch.batch_id,
      authorization: authorization(batch),
      now: new Date('2026-09-12T12:10:00.000Z'),
      ...base,
    })
    assert.deepEqual(events, [
      'snapshot',
      'authorize',
      'reserve',
      'credential',
      'spawn',
      'hold',
    ])
    assert.deepEqual(result, {
      status: 'held_unknown',
      batch_id: batch.batch_id,
      reservation_version: 7,
    })
  })

  it('fails before reservation for drift, invalid authorization or enabled connectors', async () => {
    const compiled = compileValid()
    const batch = compiled.batches[0]
    for (const invalid of [
      'authorization',
      'connectors',
      'compiled-drift',
    ] as const) {
      const events: string[] = []
      const dependencies = ports(events)
      const auth: any = authorization(batch)
      if (invalid === 'authorization') auth.batch_sha256 = SHA
      if (invalid === 'connectors')
        (dependencies.runner.descriptor as any).real_connectors_enabled = true
      const input: any = {
        compiled,
        batch_id: batch.batch_id,
        authorization: auth,
        now: new Date('2026-09-12T12:10:00.000Z'),
        ...dependencies,
      }
      if (invalid === 'compiled-drift') {
        input.compiled.batches[0].tasks[0].maximum_tokens = 6144
        rehashCompiled(input.compiled)
      }
      await assert.rejects(
        () => admitA0BehaviorBatch(input),
        A0BehaviorAdmissionError,
      )
      assert.deepEqual(events, [])
    }
  })

  it('fails closed on budget denial without acquiring a credential or spawning', async () => {
    const compiled = compileValid()
    const batch = compiled.batches[0]
    const events: string[] = []
    await assert.rejects(
      () =>
        admitA0BehaviorBatch({
          compiled,
          batch_id: batch.batch_id,
          authorization: authorization(batch),
          now: new Date('2026-09-12T12:10:00.000Z'),
          ...ports(events, {
            disposition: 'denied',
            reason: 'activation_limit',
          }),
        }),
      /A0_BUDGET_DENIED/,
    )
    assert.deepEqual(events, ['snapshot', 'authorize', 'reserve'])
  })

  it('requires the exact sealed snapshot attestation before authorization or reservation', async () => {
    const compiled = compileValid()
    const batch = compiled.batches[0]!
    const events: string[] = []
    const dependencies = ports(events)
    dependencies.artifactSnapshotVerifier.verify = async () => {
      events.push('snapshot')
      return { status: 'rejected', reason: 'byte_digest_mismatch' }
    }
    await assert.rejects(
      () =>
        admitA0BehaviorBatch({
          compiled,
          batch_id: batch.batch_id,
          authorization: authorization(batch),
          now: new Date('2026-09-12T12:10:00.000Z'),
          ...dependencies,
        }),
      /A0_ARTIFACT_SNAPSHOT_UNVERIFIED/,
    )
    assert.deepEqual(events, ['snapshot'])
  })

  it('passes only the dedicated contract and sealed handles to the injected runner', async () => {
    const compiled = compileValid()
    const batch = compiled.batches[0]!
    const events: string[] = []
    const dependencies = ports(events)
    dependencies.runner.spawn = async (input) => {
      events.push('spawn')
      assert.notEqual(input.batch, batch)
      assert.deepEqual(input.execution_contract, compiled.execution_contract)
      assert.notEqual(input.execution_contract, compiled.execution_contract)
      assert.equal(
        input.sealed_artifact_snapshot.snapshot_sha256,
        compiled.sealed_artifact_snapshot.snapshot_sha256,
      )
      assert.equal(
        input.batch.tasks[0]!.fixture_handle.startsWith('a0-sealed:'),
        true,
      )
      return {
        status: 'known',
        provider_id: 'opencode-go',
        model_id: 'deepseek-v4-flash',
        model_calls: 6,
        usage_value_micro_cents: 1_000_000,
        usage_record_id: 'usage-1',
      }
    }
    await admitA0BehaviorBatch({
      compiled,
      batch_id: batch.batch_id,
      authorization: authorization(batch),
      now: new Date('2026-09-12T12:10:00.000Z'),
      ...dependencies,
    })
    assert.deepEqual(events, [
      'snapshot',
      'authorize',
      'reserve',
      'credential',
      'spawn',
      'settle',
    ])
  })

  it('holds once when credential, spawn or settlement becomes uncertain', async () => {
    for (const phase of ['credential', 'spawn', 'settle'] as const) {
      const compiled = compileValid()
      const batch = compiled.batches[0]!
      const events: string[] = []
      const dependencies = ports(events)
      if (phase === 'credential')
        dependencies.credential.acquire = async () => {
          events.push('credential')
          throw new Error('uncertain credential boundary')
        }
      if (phase === 'spawn')
        dependencies.runner.spawn = async () => {
          events.push('spawn')
          throw new Error('uncertain process boundary')
        }
      if (phase === 'settle')
        dependencies.ledger.settle = async () => {
          events.push('settle')
          throw new Error('uncertain settlement boundary')
        }
      const result = await admitA0BehaviorBatch({
        compiled,
        batch_id: batch.batch_id,
        authorization: authorization(batch),
        now: new Date('2026-09-12T12:10:00.000Z'),
        ...dependencies,
      })
      assert.equal(result.status, 'held_unknown')
      assert.equal(events.filter((event) => event === 'hold').length, 1)
    }
  })

  it('deeply revalidates task order, contract and critical cardinality after valid rehashes', async () => {
    const mutations: Array<(compiled: A0CompiledBatchPlan) => void> = [
      (compiled) => {
        compiled.batches[0]!.tasks[0]!.sequence = 2
      },
      (compiled) => {
        compiled.execution_contract.maximum_model_calls_per_task = 2 as 1
      },
      (compiled) => {
        compiled.batches[0]!.tasks[0]!.critical = true
      },
      (compiled) => {
        compiled.batches[0]!.tasks[0]!.fixture_handle =
          compiled.batches[0]!.tasks[1]!.fixture_handle
      },
    ]
    for (const mutate of mutations) {
      const compiled = compileValid()
      mutate(compiled)
      rehashCompiled(compiled)
      const batch = compiled.batches[0]!
      const events: string[] = []
      await assert.rejects(
        () =>
          admitA0BehaviorBatch({
            compiled,
            batch_id: batch.batch_id,
            authorization: authorization(batch),
            now: new Date('2026-09-12T12:10:00.000Z'),
            ...ports(events),
          }),
        A0BehaviorAdmissionError,
      )
      assert.deepEqual(events, [])
    }
  })

  it('attempts holdUnknown exactly once when the hold CAS fails', async () => {
    for (const mode of ['returns-false', 'throws'] as const) {
      const compiled = compileValid()
      const batch = compiled.batches[0]!
      const events: string[] = []
      const dependencies = ports(events)
      dependencies.runner.spawn = async () => {
        events.push('spawn')
        return { status: 'unknown', reason: 'process_outcome_unknown' }
      }
      dependencies.ledger.holdUnknown = async () => {
        events.push('hold')
        if (mode === 'throws') throw new Error('transport uncertainty')
        return false
      }
      await assert.rejects(
        () =>
          admitA0BehaviorBatch({
            compiled,
            batch_id: batch.batch_id,
            authorization: authorization(batch),
            now: new Date('2026-09-12T12:10:00.000Z'),
            ...dependencies,
          }),
        /A0_LEDGER_HOLD_CAS_FAILED/,
      )
      assert.equal(events.filter((event) => event === 'hold').length, 1)
    }
  })

  it('exports an inert admission composition that never spawns during wiring', () => {
    const events: string[] = []
    const dependencies = ports(events)
    const admission = createA0BehaviorBatchAdmission({
      ...dependencies,
      now: () => new Date('2026-09-12T12:10:00.000Z'),
    })
    assert.deepEqual(events, [])
    assert.equal(typeof admission.compile, 'function')
    assert.equal(typeof admission.admit, 'function')
  })
})
