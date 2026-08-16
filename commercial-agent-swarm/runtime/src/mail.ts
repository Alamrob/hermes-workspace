import type { ApprovalAction, ApprovalBroker } from './approvals.js'
import type { RuntimeRepository } from './repository.js'

export interface MailTransport {
  send(action: ApprovalAction): Promise<{ receipt_id: string }>
}

export class MailPolicyError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'MailPolicyError'
  }
}

export class MailService {
  constructor(private readonly options: {
    repository: RuntimeRepository
    approvals: ApprovalBroker
    transport: MailTransport
    now?: () => Date
  }) {}

  async send(command: { action: ApprovalAction; approval_token: string }): Promise<{ receipt_id: string; approval_reference: string }> {
    const { action } = command
    if (action.sender !== 'ventas@proptimiza.com') throw new MailPolicyError('SENDER_NOT_ALLOWED')
    if (
      action.recipients.length !== 1 ||
      action.recipients[0] !== 'contacto@proptimiza.com'
    ) {
      throw new MailPolicyError('RECIPIENT_NOT_ALLOWED')
    }
    if (action.volume !== 1) throw new MailPolicyError('VOLUME_NOT_ALLOWED')
    if (action.action_type !== 'mail.send' || action.channel !== 'email') {
      throw new MailPolicyError('ACTION_NOT_ALLOWED')
    }
    const mission = await this.options.repository.getMission(action.mission_id)
    if (!mission || mission.autonomy_level !== 'A3' || mission.a3_enabled !== true) throw new MailPolicyError('A3_DISABLED')
    if (!mission || !isLiveMailMission(mission, action, (this.options.now ?? (() => new Date()))())) throw new MailPolicyError('MISSION_POLICY_DENIED')
    const grant = await this.options.approvals.authorize(command.approval_token, action)
    const claim = await this.options.repository.claimExternalAction({ missionId: action.mission_id, channel: action.channel, idempotencyKey: action.idempotency_key })
    if (claim.status === 'completed') return { receipt_id: claim.receipt_id, approval_reference: grant.approval_id }
    const receipt = await this.options.transport.send(action)
    await this.options.repository.completeExternalAction({ missionId: action.mission_id, idempotencyKey: action.idempotency_key, receipt_id: receipt.receipt_id, approval_id: grant.approval_id })
    return { ...receipt, approval_reference: grant.approval_id }
  }
}

function isLiveMailMission(mission: Record<string, unknown>, action: ApprovalAction, now: Date): boolean {
  const strings = (key: string) => Array.isArray(mission[key]) && (mission[key] as unknown[]).every((value) => typeof value === 'string') ? mission[key] as string[] : []
  return mission.autonomy_level === 'A3' && mission.a3_enabled === true && mission.dry_run === false &&
    typeof mission.expires_at === 'string' && Date.parse(mission.expires_at) > now.getTime() &&
    strings('allowed_actions').includes(action.action_type) && !strings('prohibited_actions').includes(action.action_type) &&
    strings('approved_channels').includes(action.channel) && strings('approved_tools').includes('broker.mail') &&
    mission.project_id === action.project_id && mission.project_version === action.project_version &&
    mission.offer_version === action.offer_version && mission.policy_version === action.policy_version
}
