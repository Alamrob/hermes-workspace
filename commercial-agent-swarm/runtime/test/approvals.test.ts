import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApprovalBroker, ApprovalError, type ApprovalAction } from '../src/approvals.js'
import { hashAction } from '../src/canonical.js'
import { InMemoryRuntimeRepository } from '../src/repository.js'

const NOW = new Date('2026-08-15T20:00:00.000Z')
const MISSION_ID = '123e4567-e89b-42d3-a456-426614174000'

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
    offer_version: 'operacion-sin-planillas-v1',
    policy_version: 'commercial-policy-v1',
    idempotency_key: 'mail-internal-0001',
    ...overrides,
  }
}

function broker(repository = new InMemoryRuntimeRepository()) {
  let clock = NOW
  return {
    repository,
    setNow(value: Date) {
      clock = value
    },
    broker: new ApprovalBroker({
      repository,
      hmacSecret: 'test-secret-with-at-least-32-bytes',
      now: () => clock,
      nonce: () => '00112233445566778899aabbccddeeff',
      id: () => '323e4567-e89b-42d3-a456-426614174000',
    }),
  }
}

describe('approval broker', () => {
  it('issues the exact six-segment signed approval token', async () => {
    const setup = broker()
    const approvedAction = action()
    const request = await setup.broker.request(approvedAction)

    const decision = await setup.broker.decide(request.approval_id, {
      approved: true,
      approved_by: 'human-director',
      expires_at: '2026-08-15T20:15:00.000Z',
    })

    const segments = decision.token?.split('::') ?? []
    assert.equal(segments.length, 6)
    assert.deepEqual(segments.slice(0, 5), [
      'APPROVAL',
      MISSION_ID,
      hashAction(approvedAction),
      '2026-08-15T20:15:00.000Z',
      '00112233445566778899aabbccddeeff',
    ])
    assert.match(segments[5] ?? '', /^[0-9a-f]{64}$/)
  })

  it('rejects an approval decision whose TTL exceeds thirty minutes', async () => {
    const setup = broker()
    const request = await setup.broker.request(action())

    await assert.rejects(
      setup.broker.decide(request.approval_id, {
        approved: true,
        approved_by: 'human-director',
        expires_at: '2026-08-15T20:30:00.001Z',
      }),
      (error: unknown) => error instanceof ApprovalError && error.code === 'INVALID_TTL',
    )
  })

  it('binds approval to exact content and consumes it only once atomically', async () => {
    const setup = broker()
    const request = await setup.broker.request(action())
    const decision = await setup.broker.decide(request.approval_id, {
      approved: true,
      approved_by: 'human-director',
      expires_at: '2026-08-15T20:15:00.000Z',
    })

    await assert.rejects(
      setup.broker.authorize(decision.token, action({ content: 'Contenido alterado' })),
      (error: unknown) => error instanceof ApprovalError && error.code === 'CONTENT_MISMATCH',
    )

    const attempts = await Promise.allSettled([
      setup.broker.authorize(decision.token, action()),
      setup.broker.authorize(decision.token, action()),
    ])
    assert.deepEqual(
      attempts.map((attempt) => attempt.status).sort(),
      ['fulfilled', 'rejected'],
    )
    const rejected = attempts.find((attempt) => attempt.status === 'rejected')
    assert.ok(rejected && rejected.reason instanceof ApprovalError)
    assert.equal(rejected.reason.code, 'REPLAYED')
  })

  it('rejects expired approval before attempting consumption', async () => {
    const setup = broker()
    setup.setNow(new Date('2026-08-15T19:50:00.000Z'))
    const request = await setup.broker.request(action())
    const decision = await setup.broker.decide(request.approval_id, {
      approved: true,
      approved_by: 'human-director',
      expires_at: '2026-08-15T19:59:59.000Z',
    })
    setup.setNow(NOW)

    await assert.rejects(
      setup.broker.authorize(decision.token, action()),
      (error: unknown) => error instanceof ApprovalError && error.code === 'EXPIRED',
    )
  })

  it('fails closed while a mission or email-channel kill switch is active', async () => {
    const setup = broker()
    const request = await setup.broker.request(action())
    const decision = await setup.broker.decide(request.approval_id, {
      approved: true,
      approved_by: 'human-director',
      expires_at: '2026-08-15T20:15:00.000Z',
    })
    await setup.repository.activateKillSwitch('mission', MISSION_ID)

    await assert.rejects(
      setup.broker.authorize(decision.token, action()),
      (error: unknown) => error instanceof ApprovalError && error.code === 'KILL_SWITCH_ACTIVE',
    )
  })
})
