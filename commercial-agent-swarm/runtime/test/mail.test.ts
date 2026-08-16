import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApprovalBroker, type ApprovalAction } from '../src/approvals.js'
import { MailPolicyError, MailService, type MailTransport } from '../src/mail.js'
import { InMemoryRuntimeRepository } from '../src/repository.js'

const MISSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const NOW = new Date('2026-08-15T20:00:00.000Z')

class ControlledMailTransport implements MailTransport {
  readonly sent: ApprovalAction[] = []

  async send(action: ApprovalAction) {
    this.sent.push(structuredClone(action))
    return { receipt_id: `receipt-${this.sent.length}` }
  }
}

function action(overrides: Partial<ApprovalAction> = {}): ApprovalAction {
  return {
    mission_id: MISSION_ID,
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
    ...overrides,
  }
}

async function setup(a3Enabled: boolean) {
  const repository = new InMemoryRuntimeRepository()
  await repository.saveMission({ mission_id: MISSION_ID, autonomy_level: 'A3', a3_enabled: a3Enabled })
  const approvals = new ApprovalBroker({
    repository,
    hmacSecret: 'test-secret-with-at-least-32-bytes',
    now: () => NOW,
    nonce: () => '00112233445566778899aabbccddeeff',
    id: () => '323e4567-e89b-42d3-a456-426614174000',
  })
  const transport = new ControlledMailTransport()
  const mail = new MailService({ repository, approvals, transport })
  return { repository, approvals, transport, mail }
}

async function tokenFor(approvals: ApprovalBroker, approvedAction: ApprovalAction) {
  const request = await approvals.request(approvedAction)
  const decision = await approvals.decide(request.approval_id, {
    approved: true,
    approved_by: 'human-director',
    expires_at: '2026-08-15T20:15:00.000Z',
  })
  return decision.token!
}

describe('internal mail policy', () => {
  it('rejects any non-allowlisted recipient before invoking the transport', async () => {
    const state = await setup(true)

    await assert.rejects(
      state.mail.send({ action: action({ recipients: ['prospect@example.com'] }), approval_token: 'bad' }),
      (error: unknown) => error instanceof MailPolicyError && error.code === 'RECIPIENT_NOT_ALLOWED',
    )
    assert.equal(state.transport.sent.length, 0)
  })

  it('rejects the exact internal mail while A3 is disabled for its mission', async () => {
    const state = await setup(false)

    await assert.rejects(
      state.mail.send({ action: action(), approval_token: 'bad' }),
      (error: unknown) => error instanceof MailPolicyError && error.code === 'A3_DISABLED',
    )
    assert.equal(state.transport.sent.length, 0)
  })

  it('sends one exact approved internal message and returns its receipt', async () => {
    const state = await setup(true)
    const approvedAction = action()
    const approvalToken = await tokenFor(state.approvals, approvedAction)

    const result = await state.mail.send({ action: approvedAction, approval_token: approvalToken })

    assert.deepEqual(result, { receipt_id: 'receipt-1' })
    assert.deepEqual(state.transport.sent, [approvedAction])
  })
})
