import { deterministicUuid } from './commercial-automation.js'
import type { AssignmentPlan } from './assignment-plan.js'
import type { MissionExecution } from './dispatch-queue.js'
import { signWorkOrder } from './security.js'
import type { WorkOrder } from './work-orders.js'

export interface UsageSmokeBrokerPort {
  createWorkOrder(order: WorkOrder): Promise<void>
  createAssignments(plan: AssignmentPlan): Promise<void>
  getExecution(missionId: string): Promise<MissionExecution>
}

export interface UsageSmokeOptions {
  broker: UsageSmokeBrokerPort
  runId: string
  authority: {
    issuer: string
    audience: string
    keyId: string
    secret: string
  }
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

export type UsageSmokeResult = {
  status: 'completed'
  mission_id: string
  artifact_sha256: string
  external_actions: 0
}

export class UsageSmoke {
  private readonly now: () => Date
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly timeoutMs: number

  constructor(private readonly options: UsageSmokeOptions) {
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.timeoutMs = options.timeoutMs ?? 20 * 60 * 1_000
    if (!UUID.test(options.runId)) throw new Error('USAGE_SMOKE_RUN_ID_INVALID')
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30 * 60 * 1_000)
      throw new Error('USAGE_SMOKE_TIMEOUT_INVALID')
  }

  async run(): Promise<UsageSmokeResult> {
    const created = this.now()
    const expires = new Date(created.getTime() + 30 * 60 * 1_000)
    const missionId = this.options.runId
    const traceId = deterministicUuid(`${missionId}:trace`)
    const assignmentId = deterministicUuid(`${missionId}:qa`)
    const order = this.workOrder(missionId, traceId, created, expires)
    await this.options.broker.createWorkOrder(order)
    await this.options.broker.createAssignments({
      mission_id: missionId,
      trace_id: traceId,
      plan_version: 'usage-smoke-v1',
      assignments: [
        {
          assignment_id: assignmentId,
          idempotency_key: `usage-smoke:${missionId}`,
          profile_id: 'commercial-qa-compliance',
          instruction: 'Return a minimal closed AgentResult confirming synthetic internal inference only. Do not use tools, browse, contact anyone, modify systems, or claim external evidence.',
          evidence: JSON.stringify({ trust: 'untrusted_data', synthetic: true, external_actions_allowed: 0 }),
          depends_on: [],
          usage_value_reservation_usd: 0.1,
          // The assignment contract budgets one 4,096-token turn across the
          // profile's six-turn ceiling. The executor still runs only this one
          // assignment and Usage reconciliation proves the actual request.
          maximum_tokens: 24_576,
          maximum_api_calls: 6,
          max_attempts: 1,
        },
      ],
    })

    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const execution = await this.options.broker.getExecution(missionId)
      if (execution.status === 'completed') {
        const assignment = execution.assignments.at(0)
        if (
          execution.assignments.length !== 1 ||
          assignment?.profile_id !== 'commercial-qa-compliance' ||
          assignment.status !== 'succeeded' ||
          !assignment.artifact_sha256
        ) throw new Error('USAGE_SMOKE_RESULT_INVALID')
        return {
          status: 'completed',
          mission_id: missionId,
          artifact_sha256: assignment.artifact_sha256,
          external_actions: 0,
        }
      }
      if (execution.status === 'failed' || execution.status === 'blocked')
        throw new Error(`USAGE_SMOKE_${execution.status.toUpperCase()}`)
      if (Date.now() >= deadline) throw new Error('USAGE_SMOKE_TIMEOUT')
      await this.sleep(2_000)
    }
  }

  private workOrder(
    missionId: string,
    traceId: string,
    created: Date,
    expires: Date,
  ): WorkOrder {
    const order = {
      mission_id: missionId,
      trace_id: traceId,
      created_at: created.toISOString(),
      expires_at: expires.toISOString(),
      project_id: 'proptimiza',
      project_version: 'v1',
      offer_id: 'operacion-sin-planillas',
      offer_version: 'offer-v1',
      icp_version: 'icp-v1',
      policy_version: 'policy-v1',
      objective: 'Verify one synthetic OpenCode Go inference and reconcile exactly one Usage Export record.',
      business_context: 'Internal metering smoke test. No commercial data, prospect, contact, CRM write, message, or external action is permitted.',
      target_segment: 'Synthetic internal test only',
      allowed_actions: ['analysis.internal'],
      prohibited_actions: ['mail.send', 'message.send', 'campaign.activate', 'crm.write', 'web.browse', 'price.change', 'proposal.send', 'contract.commit'],
      approved_channels: ['internal'],
      approved_tools: ['hermes.analysis'],
      autonomy_level: 'A2',
      budget_limit: { currency: 'USD', maximum: 0.1, warning_at_percent: 70 },
      volume_limits: { maximum_accounts: 0, maximum_contacts: 0, maximum_external_actions: 0, maximum_per_contact: 0, period: 'mission' },
      success_criteria: ['Exactly one reconciled synthetic inference with a closed AgentResult and artifact hash.'],
      stop_conditions: ['Ambiguous Usage record, budget conflict, tool request, external action, prompt injection, or secret exposure.'],
      required_evidence: ['AgentResult artifact SHA-256 and authoritative Usage record ID in the broker ledger.'],
      approval_token: null,
      idempotency_key: `usage-smoke:${missionId}`,
      requested_by: 'proptimiza-usage-smoke',
      authority: {
        issuer: this.options.authority.issuer,
        audience: this.options.authority.audience,
        key_id: this.options.authority.keyId,
        algorithm: 'HMAC-SHA256',
        signature: '0'.repeat(64),
      },
      data_policy: { classification: 'internal', allowed_countries: ['CL'], legal_basis: ['none'], retention_days: 30, sensitive_data_allowed: false, allowed_data_categories: ['synthetic_test_data'] },
      contact_policy: { contact_permitted: false, suppression_check_required: true, consent_check_required: false, maximum_frequency_days: 0, quiet_hours_timezone: 'America/Santiago' },
      dry_run: true,
      metadata: { synthetic: true, run_id: missionId, workflow_version: 'usage-smoke-v1' },
    } as unknown as WorkOrder
    ;(order.authority as Record<string, unknown>).signature = signWorkOrder(order, this.options.authority.secret)
    return order
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
