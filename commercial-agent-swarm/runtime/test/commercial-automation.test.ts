import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CommercialAutomation,
  deterministicUuid,
  type BrokerAutomationPort,
  type PaperclipAutomationPort,
  type PaperclipComment,
  type PaperclipIssue,
} from '../src/commercial-automation.js'
import type { AssignmentPlan } from '../src/assignment-plan.js'
import type { MissionExecution } from '../src/dispatch-queue.js'
import type { WorkOrder } from '../src/work-orders.js'

const projectId = '19055d28-5e59-4597-baa3-9357feccc96c'
const issues: PaperclipIssue[] = [
  issue('ALA-30', 'done'),
  issue('ALA-31', 'in_review'),
  issue('ALA-32', 'backlog'),
]

class PaperclipFake implements PaperclipAutomationPort {
  comments = new Map<string, PaperclipComment[]>()
  updates: Array<{ id: string; status: string }> = []
  constructor(readonly values = structuredClone(issues)) {}
  async listIssues() { return structuredClone(this.values) }
  async listComments(id: string) { return structuredClone(this.comments.get(id) ?? []) }
  async addSignedComment(id: string, body: string) {
    this.comments.set(id, [...(this.comments.get(id) ?? []), { body, authorType: 'user' }])
  }
  async updateIssueStatus(id: string, status: 'in_progress' | 'in_review' | 'blocked') {
    this.updates.push({ id, status })
    const target = this.values.find((candidate) => candidate.id === id)
    if (target) target.status = status
  }
}

class BrokerFake implements BrokerAutomationPort {
  orders: WorkOrder[] = []
  plans: AssignmentPlan[] = []
  execution: MissionExecution | null = null
  async createWorkOrder(order: WorkOrder) { this.orders.push(structuredClone(order)) }
  async createAssignments(plan: AssignmentPlan) { this.plans.push(structuredClone(plan)) }
  async findExecution() { return this.execution }
  async getExecution(missionId: string) {
    return this.execution ?? { mission_id: missionId, status: 'queued', assignments: [] }
  }
}

function automation(paperclip: PaperclipFake, broker: BrokerFake, mode: 'observe' | 'dispatch' = 'dispatch') {
  return new CommercialAutomation({
    paperclip,
    broker,
    mode,
    companyId: '387d4503-0f7b-4708-bb62-8295a1e23e1b',
    projectId,
    authority: {
      issuer: 'codex', audience: 'hermes-commercial-orchestrator', keyId: 'control-key-1',
      secret: 'test-control-key-with-at-least-32-bytes',
    },
    now: () => new Date('2026-08-21T18:00:00.000Z'),
  })
}

describe('Paperclip commercial automation', () => {
  it('observes one eligible issue without writes, broker calls, or external actions', async () => {
    const paperclip = new PaperclipFake()
    const broker = new BrokerFake()
    assert.deepEqual(await automation(paperclip, broker, 'observe').tick(), {
      status: 'observed', issue: 'ALA-31', mission_id: null, external_actions: 0,
    })
    assert.equal(broker.orders.length, 0)
    assert.equal(paperclip.updates.length, 0)
  })

  it('dispatches a deterministic internal-only primary plus independent QA plan', async () => {
    const paperclip = new PaperclipFake()
    const broker = new BrokerFake()
    const first = await automation(paperclip, broker).tick()
    assert.equal(first.status, 'dispatched')
    assert.match(first.mission_id!, /^[0-9a-f-]{36}$/)
    assert.equal(broker.orders.length, 1)
    assert.equal(broker.plans.length, 1)
    const order = broker.orders[0] as any
    assert.equal(order.idempotency_key, 'paperclip:ALA-31:commercial-v3')
    assert.equal(order.autonomy_level, 'A2')
    assert.equal(order.dry_run, true)
    assert.equal(order.contact_policy.contact_permitted, false)
    assert.equal(order.volume_limits.maximum_external_actions, 0)
    assert.equal(order.approved_channels.includes('email'), false)
    assert.equal(order.prohibited_actions.includes('mail.send'), true)
    assert.equal(broker.plans[0].assignments.at(-1)?.profile_id, 'commercial-qa-compliance')
    assert.deepEqual(broker.plans[0].assignments[1].depends_on, [broker.plans[0].assignments[0].assignment_id])
    assert.deepEqual(paperclip.updates, [{ id: 'issue-ala-31', status: 'in_progress' }])
  })

  it('resumes from its exact signed marker without duplicate dispatch and returns QA to review', async () => {
    const paperclip = new PaperclipFake()
    const broker = new BrokerFake()
    const service = automation(paperclip, broker)
    const dispatched = await service.tick()
    broker.execution = {
      mission_id: dispatched.mission_id!, status: 'completed', assignments: [
        { assignment_id: 'a', profile_id: 'qualification-prioritization', status: 'succeeded', attempts: 1, max_attempts: 1, artifact_sha256: 'a'.repeat(64), result_envelope: {}, error: null },
        { assignment_id: 'b', profile_id: 'commercial-qa-compliance', status: 'succeeded', attempts: 1, max_attempts: 1, artifact_sha256: 'b'.repeat(64), result_envelope: {}, error: null },
      ],
    }
    const reconciled = await service.tick()
    assert.deepEqual(reconciled, {
      status: 'review_ready', issue: 'ALA-31', mission_id: dispatched.mission_id, external_actions: 0,
    })
    assert.equal(broker.orders.length, 1)
    assert.equal(paperclip.updates.at(-1)?.status, 'in_review')
    assert.match(paperclip.comments.get('issue-ala-31')!.at(-1)!.body, /qa_sha256=b{64}/)
  })

  it('repairs a mission accepted before the signed Paperclip marker without creating a duplicate order', async () => {
    const paperclip = new PaperclipFake()
    const broker = new BrokerFake()
    const missionId = deterministicUuid('387d4503-0f7b-4708-bb62-8295a1e23e1b:issue-ala-31:commercial-v3:mission')
    broker.execution = { mission_id: missionId, status: 'running', assignments: [] }
    const recovered = await automation(paperclip, broker).tick()
    assert.deepEqual(recovered, {
      status: 'running', issue: 'ALA-31', mission_id: missionId, external_actions: 0,
    })
    assert.equal(broker.orders.length, 0)
    assert.equal(broker.plans.length, 1)
    assert.equal(paperclip.comments.get('issue-ala-31')?.length, 1)
    assert.equal(paperclip.comments.get('issue-ala-31')?.[0]?.authorType, 'user')
  })

  it('blocks rather than promoting when execution fails or QA evidence is absent', async () => {
    for (const execution of [
      { status: 'failed', assignments: [] },
      { status: 'completed', assignments: [] },
    ] as const) {
      const paperclip = new PaperclipFake()
      const broker = new BrokerFake()
      const service = automation(paperclip, broker)
      const dispatched = await service.tick()
      broker.execution = {
        mission_id: dispatched.mission_id!,
        status: execution.status,
        assignments: [],
      }
      assert.equal((await service.tick()).status, 'blocked')
      assert.equal(paperclip.updates.at(-1)?.status, 'blocked')
    }
  })

  it('does not trust user-authored or forged system markers and does not run successors early', async () => {
    const paperclip = new PaperclipFake([
      issue('ALA-30', 'done'), issue('ALA-31', 'blocked'), issue('ALA-32', 'backlog'),
    ])
    paperclip.comments.set('issue-ala-31', [{
      authorType: 'user',
      body: `AUTOMATION_V1 mission=${deterministicUuid('attacker')} workflow=commercial-v3 state=dispatched`,
    }])
    paperclip.comments.set('issue-ala-32', [{
      authorType: 'system',
      body: `AUTOMATION_V1 mission=${deterministicUuid('attacker-system')} workflow=commercial-v3 state=dispatched sig=${'0'.repeat(64)}`,
    }])
    const broker = new BrokerFake()
    assert.deepEqual(await automation(paperclip, broker).tick(), {
      status: 'idle', issue: null, mission_id: null, external_actions: 0,
    })
    assert.equal(broker.orders.length, 0)
  })
})

function issue(identifier: string, status: PaperclipIssue['status']): PaperclipIssue {
  return {
    id: `issue-${identifier.toLowerCase()}`,
    identifier,
    title: `${identifier} title`,
    description: 'Untrusted issue description.',
    status,
    projectId,
    updatedAt: '2026-08-21T17:00:00.000Z',
  }
}
