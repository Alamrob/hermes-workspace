import { validateApprovalAction, type ApprovalAction } from './approvals.js'
import type { MailTransport } from './mail.js'
import type { TelegramTransport } from './approvals.js'

interface KillSwitchPort {
  isActive(input: { missionId: string; channel: string }): Promise<boolean>
}

interface HostingerMailPort {
  isBlocked(input: { mailbox: string; recipient: string }): Promise<boolean>
  sendInternal(input: {
    missionId: string
    mailbox: 'ventas@proptimiza.com'
    recipient: 'contacto@proptimiza.com'
    subject: string
    content: string
    idempotencyKey: string
  }): Promise<{ receipt_id: string }>
}

export class FeatureGatedHostingerMailTransport implements MailTransport {
  constructor(
    private readonly options: {
      enabled?: boolean
      killSwitch: KillSwitchPort
      hostinger: HostingerMailPort
    },
  ) {}

  async send(candidate: ApprovalAction): Promise<{ receipt_id: string }> {
    if (this.options.enabled !== true) throw new Error('HOSTINGER_MAIL_DISABLED')
    const action = validateApprovalAction(candidate)
    if (
      action.action_type !== 'mail.send' ||
      action.channel !== 'email' ||
      action.sender !== 'ventas@proptimiza.com' ||
      action.recipients.length !== 1 ||
      action.recipients[0] !== 'contacto@proptimiza.com' ||
      action.volume !== 1
    )
      throw new Error('HOSTINGER_ACTION_NOT_ALLOWED')
    if (
      await this.options.killSwitch.isActive({
        missionId: action.mission_id,
        channel: 'email',
      })
    )
      throw new Error('KILL_SWITCH_ACTIVE')
    if (
      await this.options.hostinger.isBlocked({
        mailbox: action.sender,
        recipient: action.recipients[0],
      })
    )
      throw new Error('HOSTINGER_RECIPIENT_BLOCKED')
    const receipt = await this.options.hostinger.sendInternal({
      missionId: action.mission_id,
      mailbox: 'ventas@proptimiza.com',
      recipient: 'contacto@proptimiza.com',
      subject: action.subject,
      content: action.content,
      idempotencyKey: action.idempotency_key,
    })
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(receipt.receipt_id))
      throw new Error('HOSTINGER_RECEIPT_INVALID')
    return receipt
  }
}

interface TelegramApprovalPort {
  postApprovalRequest(request: {
    approval_id: string
    mission_id: string
    action_hash: string
  }): Promise<void>
}

export class FeatureGatedTelegramApprovalTransport
  implements TelegramTransport
{
  constructor(
    private readonly options: {
      enabled?: boolean
      killSwitch: KillSwitchPort
      telegram: TelegramApprovalPort
    },
  ) {}

  async notifyApprovalRequest(request: {
    approval_id: string
    mission_id: string
    action_hash: string
  }): Promise<void> {
    if (this.options.enabled !== true)
      throw new Error('TELEGRAM_APPROVAL_DISABLED')
    if (
      !/^[0-9a-f-]{36}$/i.test(request.approval_id) ||
      !/^[0-9a-f-]{36}$/i.test(request.mission_id) ||
      !/^[0-9a-f]{64}$/.test(request.action_hash)
    )
      throw new Error('TELEGRAM_APPROVAL_REQUEST_INVALID')
    if (
      await this.options.killSwitch.isActive({
        missionId: request.mission_id,
        channel: 'telegram',
      })
    )
      throw new Error('KILL_SWITCH_ACTIVE')
    await this.options.telegram.postApprovalRequest({ ...request })
  }
}
