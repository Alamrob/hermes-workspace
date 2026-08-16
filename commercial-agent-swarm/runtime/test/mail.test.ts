import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApprovalBroker, type ApprovalAction } from '../src/approvals.js'
import { MailPolicyError, MailService, type MailTransport } from '../src/mail.js'
import { InMemoryRuntimeRepository } from '../src/repository.js'

const MISSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const NOW = new Date('2026-08-15T20:00:00.000Z')

class ControlledMailTransport implements MailTransport {
  readonly sent: ApprovalAction[] = []
  readonly received: ApprovalAction[] = []

  async send(action: ApprovalAction) {
    this.received.push(action)
    this.sent.push(structuredClone(action))
    return { receipt_id: `receipt-${this.sent.length}` }
  }
}

function action(overrides: Partial<ApprovalAction> = {}): ApprovalAction {
  return {
    mission_id: MISSION_ID,
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
    ...overrides,
  }
}

async function setup(
  a3Enabled: boolean,
  approvalIds = ['323e4567-e89b-42d3-a456-426614174000'],
) {
  const repository = new InMemoryRuntimeRepository()
  let approvalIdIndex = 0
  let nonceIndex = 0
  await repository.saveMission({ mission_id: MISSION_ID, autonomy_level: 'A3', a3_enabled: a3Enabled, expires_at: '2026-08-15T21:00:00.000Z', allowed_actions: ['mail.send'], prohibited_actions: [], approved_channels: ['email'], approved_tools: ['broker.mail'], dry_run: false, project_id: 'proptimiza', project_version: 'v1', offer_version: 'offer-v1', policy_version: 'policy-v1' })
  const approvals = new ApprovalBroker({
    repository,
    hmacSecret: 'test-secret-with-at-least-32-bytes',
    now: () => NOW,
    nonce: () => `${nonceIndex++}`.padStart(32, '0'),
    id: () => approvalIds[approvalIdIndex++]!,
  })
  const transport = new ControlledMailTransport()
  const mail = new MailService({ repository, approvals, transport, now: () => NOW })
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

    assert.deepEqual(result, { receipt_id: 'receipt-1', approval_reference: '323e4567-e89b-42d3-a456-426614174000' })
    assert.deepEqual(state.transport.sent, [approvedAction])
    assert.notEqual(state.transport.received[0], approvedAction)
  })

  it('rejects provider options on mail actions before approval or transport', async () => {
    const state = await setup(true)
    const approvedAction = action()
    const approvalToken = await tokenFor(state.approvals, approvedAction)
    const unsafeAction = {
      ...approvedAction,
      provider_options: { headers: { authorization: 'Bearer must-not-pass' } },
    }

    await assert.rejects(
      state.mail.send({ action: unsafeAction as never, approval_token: approvalToken }),
      (error: unknown) => error instanceof Error && error.message === 'INVALID_ACTION',
    )
    assert.equal(state.transport.sent.length, 0)
  })

  it('returns the original receipt and approval for multiple grants with one idempotency key', async () => {
    const firstApprovalId = '323e4567-e89b-42d3-a456-426614174000'
    const secondApprovalId = '423e4567-e89b-42d3-a456-426614174000'
    const state = await setup(true, [firstApprovalId, secondApprovalId])
    const approvedAction = action()
    const firstToken = await tokenFor(state.approvals, approvedAction)
    const secondToken = await tokenFor(state.approvals, approvedAction)

    const first = await state.mail.send({ action: approvedAction, approval_token: firstToken })
    const repeated = await state.mail.send({ action: approvedAction, approval_token: secondToken })

    assert.deepEqual(first, { receipt_id: 'receipt-1', approval_reference: firstApprovalId })
    assert.deepEqual(repeated, first)
    assert.deepEqual(state.transport.sent, [approvedAction])
  })

  it('rejects an idempotency key reused for a changed action instead of inheriting its receipt', async () => {
    const state = await setup(true, [
      '323e4567-e89b-42d3-a456-426614174000',
      '423e4567-e89b-42d3-a456-426614174000',
    ])
    const firstAction = action()
    const changedAction = action({ content: 'Mensaje distinto', content_version: 'mail-v2' })
    const firstToken = await tokenFor(state.approvals, firstAction)
    const changedToken = await tokenFor(state.approvals, changedAction)
    await state.mail.send({ action: firstAction, approval_token: firstToken })

    await assert.rejects(
      state.mail.send({ action: changedAction, approval_token: changedToken }),
      /IDEMPOTENCY_CONFLICT/,
    )
    assert.deepEqual(state.transport.sent, [firstAction])
  })

  it('revalidates the live mission dry-run policy before invoking transport', async () => {
    const state = await setup(true)
    await state.repository.saveMission({ mission_id: MISSION_ID, autonomy_level: 'A3', a3_enabled: true, expires_at: '2026-08-15T21:00:00.000Z', allowed_actions: ['mail.send'], prohibited_actions: [], approved_channels: ['email'], approved_tools: ['broker.mail'], dry_run: true, project_id: 'proptimiza', project_version: 'v1', offer_version: 'offer-v1', policy_version: 'policy-v1' })
    const approvedAction = action()
    const approvalToken = await tokenFor(state.approvals, approvedAction)
    await assert.rejects(state.mail.send({ action: approvedAction, approval_token: approvalToken }), (error: unknown) => error instanceof MailPolicyError && error.code === 'MISSION_POLICY_DENIED')
    assert.equal(state.transport.sent.length, 0)
  })

  it('rejects an expired mission at send time before invoking transport', async () => {
    const state = await setup(true)
    await state.repository.saveMission({ mission_id: MISSION_ID, autonomy_level: 'A3', a3_enabled: true, expires_at: '2026-08-15T19:59:59.999Z', allowed_actions: ['mail.send'], prohibited_actions: [], approved_channels: ['email'], approved_tools: ['broker.mail'], dry_run: false, project_id: 'proptimiza', project_version: 'v1', offer_version: 'offer-v1', policy_version: 'policy-v1' })
    const approvedAction = action()
    const approvalToken = await tokenFor(state.approvals, approvedAction)

    await assert.rejects(
      state.mail.send({ action: approvedAction, approval_token: approvalToken }),
      (error: unknown) => error instanceof MailPolicyError && error.code === 'MISSION_POLICY_DENIED',
    )
    assert.equal(state.transport.sent.length, 0)
  })

  it('rejects an action prohibited by the live mission before invoking transport', async () => {
    const state = await setup(true)
    await state.repository.saveMission({ mission_id: MISSION_ID, autonomy_level: 'A3', a3_enabled: true, expires_at: '2026-08-15T21:00:00.000Z', allowed_actions: ['mail.send'], prohibited_actions: ['mail.send'], approved_channels: ['email'], approved_tools: ['broker.mail'], dry_run: false, project_id: 'proptimiza', project_version: 'v1', offer_version: 'offer-v1', policy_version: 'policy-v1' })
    const approvedAction = action()
    const approvalToken = await tokenFor(state.approvals, approvedAction)

    await assert.rejects(
      state.mail.send({ action: approvedAction, approval_token: approvalToken }),
      (error: unknown) => error instanceof MailPolicyError && error.code === 'MISSION_POLICY_DENIED',
    )
    assert.equal(state.transport.sent.length, 0)
  })

  it('rejects a mission with the wrong approved channel or tool before transport', async () => {
    for (const policy of [
      { approved_channels: ['internal'], approved_tools: ['broker.mail'] },
      { approved_channels: ['email'], approved_tools: ['broker.calendar'] },
    ]) {
      const state = await setup(true)
      await state.repository.saveMission({ mission_id: MISSION_ID, autonomy_level: 'A3', a3_enabled: true, expires_at: '2026-08-15T21:00:00.000Z', allowed_actions: ['mail.send'], prohibited_actions: [], dry_run: false, project_id: 'proptimiza', project_version: 'v1', offer_version: 'offer-v1', policy_version: 'policy-v1', ...policy })
      const approvedAction = action()
      const approvalToken = await tokenFor(state.approvals, approvedAction)

      await assert.rejects(
        state.mail.send({ action: approvedAction, approval_token: approvalToken }),
        (error: unknown) => error instanceof MailPolicyError && error.code === 'MISSION_POLICY_DENIED',
      )
      assert.equal(state.transport.sent.length, 0)
    }
  })

  it('rejects a delivery policy version absent from the repository catalog', async () => {
    const state = await setup(true)
    const unknown = action({ policy_version: 'policy-v999' })
    await state.repository.saveMission({ ...(await state.repository.getMission(MISSION_ID))!, policy_version: 'policy-v999' })
    await assert.rejects(
      state.mail.send({ action: unknown, approval_token: 'unused' }),
      (error: unknown) => error instanceof MailPolicyError && error.code === 'CATALOG_POLICY_DENIED',
    )
    assert.equal(state.transport.sent.length, 0)
  })
})
