import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FeatureGatedHostingerMailTransport,
  FeatureGatedTelegramApprovalTransport,
} from '../src/external-adapters.js'
import type { ApprovalAction } from '../src/approvals.js'

const action: ApprovalAction = {
  mission_id: '123e4567-e89b-42d3-a456-426614174000',
  project_id: 'proptimiza',
  project_version: 'v1',
  action_type: 'mail.send',
  channel: 'email',
  sender: 'ventas@proptimiza.com',
  recipients: ['contacto@proptimiza.com'],
  subject: 'Prueba interna',
  content: 'Mensaje controlado',
  content_version: 'mail-v1',
  volume: 1,
  offer_version: 'offer-v1',
  policy_version: 'policy-v1',
  idempotency_key: 'mail-internal-0001',
}

describe('feature-gated external adapters', () => {
  it('keeps Hostinger disabled by default and checks kill switch/blocklist before its port', async () => {
    let sends = 0
    const base = {
      killSwitch: { isActive: async () => false },
      hostinger: {
        isBlocked: async () => false,
        sendInternal: async () => {
          sends += 1
          return { receipt_id: 'hostinger-receipt-1' }
        },
      },
    }
    await assert.rejects(
      new FeatureGatedHostingerMailTransport(base).send(action),
      /HOSTINGER_MAIL_DISABLED/,
    )
    await assert.rejects(
      new FeatureGatedHostingerMailTransport({
        ...base,
        enabled: true,
        hostinger: { ...base.hostinger, isBlocked: async () => true },
      }).send(action),
      /HOSTINGER_RECIPIENT_BLOCKED/,
    )
    await assert.rejects(
      new FeatureGatedHostingerMailTransport({
        ...base,
        enabled: true,
        killSwitch: { isActive: async () => true },
      }).send(action),
      /KILL_SWITCH_ACTIVE/,
    )
    assert.equal(sends, 0)
  })

  it('sends only the internal allowlisted action through the injected Hostinger port', async () => {
    const calls: unknown[] = []
    const transport = new FeatureGatedHostingerMailTransport({
      enabled: true,
      killSwitch: { isActive: async () => false },
      hostinger: {
        isBlocked: async () => false,
        sendInternal: async (request) => {
          calls.push(request)
          return { receipt_id: 'hostinger-receipt-1' }
        },
      },
    })
    assert.deepEqual(await transport.send(action), {
      receipt_id: 'hostinger-receipt-1',
    })
    assert.equal(calls.length, 1)
    await assert.rejects(
      transport.send({ ...action, recipients: ['external@example.com'] }),
      /HOSTINGER_ACTION_NOT_ALLOWED/,
    )
  })

  it('keeps Telegram disabled by default and emits metadata only when enabled', async () => {
    const calls: unknown[] = []
    const request = {
      approval_id: '323e4567-e89b-42d3-a456-426614174000',
      mission_id: action.mission_id,
      action_hash: 'a'.repeat(64),
    }
    await assert.rejects(
      new FeatureGatedTelegramApprovalTransport({
        killSwitch: { isActive: async () => false },
        telegram: { postApprovalRequest: async () => undefined },
      }).notifyApprovalRequest(request),
      /TELEGRAM_APPROVAL_DISABLED/,
    )
    await new FeatureGatedTelegramApprovalTransport({
      enabled: true,
      killSwitch: { isActive: async () => false },
      telegram: {
        postApprovalRequest: async (value) => void calls.push(value),
      },
    }).notifyApprovalRequest(request)
    assert.deepEqual(calls, [request])
  })
})
