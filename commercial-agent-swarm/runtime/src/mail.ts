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
  }) {}

  async send(command: { action: ApprovalAction; approval_token: string }) {
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
    if (!(await this.options.repository.isMissionA3Enabled(action.mission_id))) {
      throw new MailPolicyError('A3_DISABLED')
    }
    await this.options.approvals.authorize(command.approval_token, action)
    return this.options.transport.send(action)
  }
}
