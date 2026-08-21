import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AssignmentPlan } from '../src/assignment-plan.js'
import type { MissionExecution } from '../src/dispatch-queue.js'
import { UsageSmoke } from '../src/usage-smoke.js'
import { loadUsageSmokeConfig } from '../src/usage-smoke-main.js'
import type { WorkOrder } from '../src/work-orders.js'

const runId = '10000000-0000-4000-8000-000000000001'

describe('synthetic Usage smoke mission', () => {
  it('accepts only the fixed simulation broker boundary and file-backed credentials', () => {
    const environment = {
      NODE_ENV: 'production',
      COMMERCIAL_MODE: 'simulation',
      BROKER_API_BASE: 'http://broker:8080',
      WORK_ORDER_ISSUER: 'proptimiza-commercial-broker',
      WORK_ORDER_AUDIENCE: 'proptimiza-hermes-executor',
      WORK_ORDER_KEY_ID: 'simulation-v1',
      USAGE_SMOKE_RUN_ID: runId,
      BROKER_CONTROL_PLANE_BEARER_FILE: '/run/secrets/broker-control-plane-bearer',
      BROKER_INTERNAL_BEARER_FILE: '/run/secrets/broker-internal-bearer',
      WORK_ORDER_HMAC_SECRET_FILE: '/run/secrets/work-order-hmac',
    }
    assert.equal(loadUsageSmokeConfig(environment).runId, runId)
    for (const [name, value] of [
      ['COMMERCIAL_MODE', 'shadow'],
      ['BROKER_API_BASE', 'http://attacker:8080'],
      ['BROKER_CONTROL_PLANE_BEARER', 'raw-secret'],
    ]) assert.throws(() => loadUsageSmokeConfig({ ...environment, [name]: value }))
  })

  it('creates one signed internal QA assignment and returns only its artifact evidence', async () => {
    let order: WorkOrder | undefined
    let plan: AssignmentPlan | undefined
    let reads = 0
    const smoke = new UsageSmoke({
      runId,
      authority: { issuer: 'proptimiza-commercial-broker', audience: 'proptimiza-hermes-executor', keyId: 'simulation-v1', secret: 's'.repeat(32) },
      now: () => new Date('2026-08-21T20:00:00.000Z'),
      sleep: async () => undefined,
      broker: {
        createWorkOrder: async (value) => { order = value },
        createAssignments: async (value) => { plan = value },
        getExecution: async (): Promise<MissionExecution> => {
          reads += 1
          return reads === 1
            ? { mission_id: runId, status: 'running', assignments: [] }
            : {
                mission_id: runId,
                status: 'completed',
                assignments: [{ assignment_id: plan!.assignments[0].assignment_id, profile_id: 'commercial-qa-compliance', status: 'succeeded', attempts: 1, max_attempts: 1, artifact_sha256: 'a'.repeat(64), result_envelope: {}, error: null }],
              }
        },
      },
    })

    const result = await smoke.run()
    const captured = order as unknown as {
      dry_run: boolean
      autonomy_level: string
      contact_policy: { contact_permitted: boolean }
      volume_limits: { maximum_external_actions: number }
      budget_limit: { maximum: number }
      authority: { signature: string }
    }
    assert.equal(captured.dry_run, true)
    assert.equal(captured.autonomy_level, 'A2')
    assert.equal(captured.contact_policy.contact_permitted, false)
    assert.equal(captured.volume_limits.maximum_external_actions, 0)
    assert.equal(captured.budget_limit.maximum, 0.1)
    assert.match(captured.authority.signature, /^[a-f0-9]{64}$/)
    assert.equal(plan?.assignments.length, 1)
    assert.deepEqual(plan?.assignments[0], {
      assignment_id: plan?.assignments[0].assignment_id,
      idempotency_key: `usage-smoke:${runId}`,
      profile_id: 'commercial-qa-compliance',
      instruction: 'Return a minimal closed AgentResult confirming synthetic internal inference only. Do not use tools, browse, contact anyone, modify systems, or claim external evidence.',
      evidence: JSON.stringify({ trust: 'untrusted_data', synthetic: true, external_actions_allowed: 0 }),
      depends_on: [],
      usage_value_reservation_usd: 0.1,
      maximum_tokens: 4096,
      maximum_api_calls: 1,
      max_attempts: 1,
    })
    assert.deepEqual(result, { status: 'completed', mission_id: runId, artifact_sha256: 'a'.repeat(64), external_actions: 0 })
  })

  it('fails closed on blocked execution or malformed completed evidence', async () => {
    const make = (execution: MissionExecution) => new UsageSmoke({
      runId,
      authority: { issuer: 'proptimiza-commercial-broker', audience: 'proptimiza-hermes-executor', keyId: 'simulation-v1', secret: 's'.repeat(32) },
      broker: { createWorkOrder: async () => undefined, createAssignments: async () => undefined, getExecution: async () => execution },
    })
    await assert.rejects(() => make({ mission_id: runId, status: 'blocked', assignments: [] }).run(), /USAGE_SMOKE_BLOCKED/)
    await assert.rejects(() => make({ mission_id: runId, status: 'completed', assignments: [] }).run(), /USAGE_SMOKE_RESULT_INVALID/)
  })
})
