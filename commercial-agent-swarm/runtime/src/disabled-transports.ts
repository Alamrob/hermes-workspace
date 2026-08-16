import type { ApprovalAction } from './approvals.js'
import type { MailTransport } from './mail.js'

export class DisabledExternalMailTransport implements MailTransport {
  async send(_action: ApprovalAction): Promise<{ receipt_id: string }> {
    throw new Error('EXTERNAL_ACTIONS_DISABLED')
  }
}
