import type { ApprovalAction } from './approvals.js'

interface ApprovalRecord {
  approval_id: string
  action: ApprovalAction
  action_hash: string
  requested_at: string
}

export interface ApprovalRequestRecord extends ApprovalRecord {
  status: 'pending' | 'denied'
}

export interface ApprovalGrantRecord extends ApprovalRecord {
  status: 'approved'
  approved_by: string
  expires_at: string
  nonce: string
  token: string
  consumed_at: string | null
}

export interface RuntimeRepository {
  ready(): Promise<boolean>
  saveMission(record: MissionRecord): Promise<void>
  getMission(id: string): Promise<MissionRecord | null>
  isMissionA3Enabled(id: string): Promise<boolean>
  storeWebhookEvent(record: WebhookEventRecord): Promise<boolean>
  createApprovalRequest(record: ApprovalRequestRecord): Promise<void>
  getApprovalRequest(id: string): Promise<ApprovalRequestRecord | ApprovalGrantRecord | null>
  saveApprovalDecision(record: ApprovalGrantRecord | (ApprovalRequestRecord & { status: 'denied' })): Promise<boolean>
  consumeApproval(input: {
    missionId: string
    actionHash: string
    nonce: string
    now: string
  }): Promise<ApprovalGrantRecord | null>
  isKillSwitchActive(input: { missionId: string; channel: string }): Promise<boolean>
  claimExternalAction(input: { missionId: string; channel: string; idempotencyKey: string }): Promise<{ status: 'acquired' } | { status: 'completed'; receipt_id: string; approval_id: string }>
  completeExternalAction(input: { missionId: string; idempotencyKey: string; receipt_id: string; approval_id: string }): Promise<void>
}

export interface WebhookEventRecord {
  mailbox_key: string
  provider_event_id: string
  received_at: string
  trust_classification: 'untrusted_external'
  instruction_eligible: false
  untrusted_payload: Record<string, unknown>
}

export interface MissionRecord {
  mission_id: string
  autonomy_level: string
  a3_enabled: boolean
  [key: string]: unknown
}

export class InMemoryRuntimeRepository implements RuntimeRepository {
  private readonly approvals = new Map<string, ApprovalRequestRecord | ApprovalGrantRecord>()
  private readonly killSwitches = new Set<string>()
  private readonly missions = new Map<string, MissionRecord>()
  private readonly webhookEvents = new Map<string, WebhookEventRecord>()
  private readonly externalActions = new Map<string, { receipt_id?: string; approval_id?: string }>()

  async ready(): Promise<boolean> {
    return true
  }

  async saveMission(record: MissionRecord): Promise<void> {
    this.missions.set(record.mission_id, structuredClone(record))
  }

  async getMission(id: string): Promise<MissionRecord | null> {
    const mission = this.missions.get(id)
    return mission ? structuredClone(mission) : null
  }

  async isMissionA3Enabled(id: string): Promise<boolean> {
    const mission = this.missions.get(id)
    return mission?.autonomy_level === 'A3' && mission.a3_enabled === true
  }

  async storeWebhookEvent(record: WebhookEventRecord): Promise<boolean> {
    const key = `${record.mailbox_key}:${record.provider_event_id}`
    if (this.webhookEvents.has(key)) return false
    this.webhookEvents.set(key, structuredClone(record))
    return true
  }

  async listWebhookEvents(): Promise<WebhookEventRecord[]> {
    return [...this.webhookEvents.values()].map((event) => structuredClone(event))
  }

  async createApprovalRequest(record: ApprovalRequestRecord): Promise<void> {
    if (this.approvals.has(record.approval_id)) throw new Error('duplicate approval id')
    this.approvals.set(record.approval_id, structuredClone(record))
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequestRecord | ApprovalGrantRecord | null> {
    const record = this.approvals.get(id)
    return record ? structuredClone(record) : null
  }

  async saveApprovalDecision(
    record: ApprovalGrantRecord | (ApprovalRequestRecord & { status: 'denied' }),
  ): Promise<boolean> {
    const current = this.approvals.get(record.approval_id)
    if (!current || current.status !== 'pending') return false
    this.approvals.set(record.approval_id, structuredClone(record))
    return true
  }

  async consumeApproval(input: {
    missionId: string
    actionHash: string
    nonce: string
    now: string
  }): Promise<ApprovalGrantRecord | null> {
    for (const [id, record] of this.approvals) {
      if (
        record.status === 'approved' &&
        record.action.mission_id === input.missionId &&
        record.action_hash === input.actionHash &&
        record.nonce === input.nonce &&
        record.consumed_at === null &&
        Date.parse(record.expires_at) > Date.parse(input.now)
      ) {
        const consumed = { ...record, consumed_at: input.now }
        this.approvals.set(id, consumed)
        return structuredClone(consumed)
      }
    }
    return null
  }

  async activateKillSwitch(scope: string, scopeId: string): Promise<void> {
    this.killSwitches.add(`${scope}:${scopeId}`)
  }

  async isKillSwitchActive(input: { missionId: string; channel: string }): Promise<boolean> {
    return (
      this.killSwitches.has('global:*') ||
      this.killSwitches.has(`mission:${input.missionId}`) ||
      this.killSwitches.has(`channel:${input.channel}`)
    )
  }

  async claimExternalAction(input: { missionId: string; channel: string; idempotencyKey: string }): Promise<{ status: 'acquired' } | { status: 'completed'; receipt_id: string; approval_id: string }> {
    if (await this.isKillSwitchActive(input)) throw new Error('KILL_SWITCH_ACTIVE')
    const key = `${input.missionId}:${input.idempotencyKey}`
    const current = this.externalActions.get(key)
    if (current?.receipt_id && current.approval_id) {
      return {
        status: 'completed',
        receipt_id: current.receipt_id,
        approval_id: current.approval_id,
      }
    }
    if (current) throw new Error('EXECUTION_IN_PROGRESS')
    this.externalActions.set(key, {})
    return { status: 'acquired' }
  }

  async completeExternalAction(input: { missionId: string; idempotencyKey: string; receipt_id: string; approval_id: string }): Promise<void> {
    this.externalActions.set(`${input.missionId}:${input.idempotencyKey}`, { receipt_id: input.receipt_id, approval_id: input.approval_id })
  }
}
