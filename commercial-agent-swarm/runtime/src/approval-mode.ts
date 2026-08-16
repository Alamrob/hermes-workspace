export type ApprovalMode =
  | 'sales_only'
  | 'telegram_only'
  | 'either'
  | 'dual_channel'
export type ApprovalChannel = 'sales' | 'telegram'

export interface ApprovalChannelEvidence {
  approvalId: string
  actionHash: string
  channel: ApprovalChannel
  decision: 'approved' | 'denied'
  actorId: string
  decidedAt: string
}

export interface ApprovalEvidenceStorePort {
  record(evidence: ApprovalChannelEvidence): Promise<void>
  list(approvalId: string): Promise<ApprovalChannelEvidence[]>
}

export interface ApprovalGrantPort {
  decide(
    approvalId: string,
    decision: {
      approved: boolean
      approved_by: string
      expires_at: string
    },
  ): Promise<{ status: 'approved' | 'denied'; token?: string }>
}

export class InMemoryApprovalEvidenceStore
  implements ApprovalEvidenceStorePort
{
  private readonly evidence = new Map<string, ApprovalChannelEvidence>()

  async record(value: ApprovalChannelEvidence): Promise<void> {
    validateEvidence(value)
    const key = `${value.approvalId}:${value.channel}`
    const existing = this.evidence.get(key)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(value))
        throw new Error('APPROVAL_EVIDENCE_CONFLICT')
      return
    }
    this.evidence.set(key, structuredClone(value))
  }

  async list(approvalId: string): Promise<ApprovalChannelEvidence[]> {
    return [...this.evidence.values()]
      .filter((value) => value.approvalId === approvalId)
      .sort((left, right) => left.channel.localeCompare(right.channel))
      .map((value) => structuredClone(value))
  }
}

export function parseApprovalMode(value: unknown): ApprovalMode {
  if (value === undefined || value === null || value === '') return 'either'
  if (
    value === 'sales_only' ||
    value === 'telegram_only' ||
    value === 'either' ||
    value === 'dual_channel'
  )
    return value
  throw new Error('INVALID_APPROVAL_MODE')
}

export function evaluateApprovalMode(
  mode: ApprovalMode,
  evidence: ApprovalChannelEvidence[],
): 'pending' | 'approved' | 'denied' {
  const parsedMode = parseApprovalMode(mode)
  if (evidence.length === 0) return 'pending'
  const approvalId = evidence[0].approvalId
  const actionHash = evidence[0].actionHash
  const channels = new Set<ApprovalChannel>()
  for (const item of evidence) {
    validateEvidence(item)
    if (item.approvalId !== approvalId || item.actionHash !== actionHash)
      throw new Error('APPROVAL_EVIDENCE_MISMATCH')
    if (channels.has(item.channel))
      throw new Error('APPROVAL_EVIDENCE_CONFLICT')
    channels.add(item.channel)
  }
  if (evidence.some((item) => item.decision === 'denied')) return 'denied'
  const approved = new Set(
    evidence
      .filter((item) => item.decision === 'approved')
      .map((item) => item.channel),
  )
  if (parsedMode === 'sales_only')
    return approved.has('sales') ? 'approved' : 'pending'
  if (parsedMode === 'telegram_only')
    return approved.has('telegram') ? 'approved' : 'pending'
  if (parsedMode === 'either')
    return approved.size > 0 ? 'approved' : 'pending'
  return approved.has('sales') && approved.has('telegram')
    ? 'approved'
    : 'pending'
}

export class ApprovalModeCoordinator {
  private readonly mode: ApprovalMode

  constructor(
    private readonly options: {
      mode?: ApprovalMode
      store: ApprovalEvidenceStorePort
      grants: ApprovalGrantPort
    },
  ) {
    this.mode = parseApprovalMode(options.mode)
  }

  async submit(
    evidence: ApprovalChannelEvidence,
    expiresAt: string,
  ): Promise<{ status: 'pending' | 'approved' | 'denied'; token?: string }> {
    validateEvidence(evidence)
    if (!Number.isFinite(Date.parse(expiresAt)))
      throw new Error('APPROVAL_EXPIRY_INVALID')
    await this.options.store.record(evidence)
    const all = await this.options.store.list(evidence.approvalId)
    const status = evaluateApprovalMode(this.mode, all)
    if (status === 'pending') return { status }
    const approvedBy = all
      .slice()
      .sort((left, right) => left.channel.localeCompare(right.channel))
      .map((item) => `${item.channel}:${item.actorId}`)
      .join('+')
    return this.options.grants.decide(evidence.approvalId, {
      approved: status === 'approved',
      approved_by: approvedBy,
      expires_at: expiresAt,
    })
  }
}

function validateEvidence(value: ApprovalChannelEvidence): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.approvalId,
    ) ||
    !/^[0-9a-f]{64}$/.test(value.actionHash) ||
    !['sales', 'telegram'].includes(value.channel) ||
    !['approved', 'denied'].includes(value.decision) ||
    !/^[A-Za-z0-9._:@-]{1,128}$/.test(value.actorId) ||
    !Number.isFinite(Date.parse(value.decidedAt))
  )
    throw new Error('APPROVAL_EVIDENCE_INVALID')
}
