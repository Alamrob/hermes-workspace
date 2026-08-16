import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BrokerApplication } from '../src/application.js'
import { ApprovalBroker, type ApprovalAction, type TelegramTransport } from '../src/approvals.js'
import { MailService, type MailTransport } from '../src/mail.js'
import { InMemoryAuditSink } from '../src/observability.js'
import { InMemoryRuntimeRepository } from '../src/repository.js'
import { WebhookService } from '../src/webhook.js'
import { createBrokerHttpServer } from '../src/server.js'
import { signWorkOrder } from '../src/security.js'
import { validWorkOrder } from './fixtures.js'

const NOW = new Date('2026-08-15T20:00:00.000Z')

class FakeTelegram implements TelegramTransport {
  requests: Array<{ approval_id: string; mission_id: string; action_hash: string }> = []
  async notifyApprovalRequest(request: { approval_id: string; mission_id: string; action_hash: string }) {
    this.requests.push(request)
  }
}

class FakeMail implements MailTransport {
  async send(_action: ApprovalAction) {
    return { receipt_id: 'mail-receipt-1' }
  }
}

function setup() {
  const repository = new InMemoryRuntimeRepository()
  const telegram = new FakeTelegram()
  const approvals = new ApprovalBroker({
    repository,
    telegram,
    hmacSecret: 'test-secret-with-at-least-32-bytes',
    now: () => NOW,
    nonce: () => '00112233445566778899aabbccddeeff',
    id: () => '323e4567-e89b-42d3-a456-426614174000',
  })
  const audit = new InMemoryAuditSink()
  return {
    repository,
    telegram,
    audit,
    app: new BrokerApplication({
      repository,
      approvals,
      mail: new MailService({ repository, approvals, transport: new FakeMail(), now: () => NOW }),
      webhook: new WebhookService({
        repository,
        mailboxSecrets: { contacto: '0123456789abcdef0123456789abcdef' },
        maxPayloadBytes: 1024,
        now: () => NOW,
      }),
      audit,
      now: () => NOW,
      deployedVersion: 'runtime-test-v1',
      authentication: {
        workOrders: { issuer: 'codex', audience: 'hermes-commercial-orchestrator', keys: { 'control-key-1': 'test-control-key-with-at-least-32-bytes' } },
        controlPlane: 'control-plane-token', approvalGateway: 'approval-gateway-token', connector: 'connector-token', internal: 'internal-token', approvers: ['human-director'],
      },
    }),
  }
}

function signedWorkOrder() {
  const order = validWorkOrder()
  order.authority.algorithm = 'HMAC-SHA256'
  order.authority.signature = signWorkOrder(order as never, 'test-control-key-with-at-least-32-bytes')
  return order
}

const headers = (token: string) => ({ authorization: `Bearer ${token}` })

function mailAction(): ApprovalAction {
  return {
    mission_id: validWorkOrder().mission_id,
    project_id: 'proptimiza',
    project_version: 'v1',
    action_type: 'mail.send',
    channel: 'email',
    sender: 'ventas@proptimiza.com',
    recipients: ['contacto@proptimiza.com'],
    subject: 'Prueba interna',
    content: 'Mensaje controlado',
    content_version: 'v1',
    volume: 1,
    offer_version: 'v1',
    policy_version: 'v1',
    idempotency_key: 'mail-internal-0001',
  }
}

describe('broker application routes', () => {
  it('rejects an unsigned work order before it can create a mission', async () => {
    const state = setup()
    const response = await state.app.handle({
      method: 'POST',
      path: '/v1/work-orders',
      body: validWorkOrder(),
    })
    assert.equal(response.status, 403)
  })

  it('rejects a signed work order for the wrong issuer, audience, key, project, or validity', async () => {
    for (const mutate of [
      (order: any) => { order.authority.issuer = 'wrong' },
      (order: any) => { order.authority.audience = 'wrong' },
      (order: any) => { order.authority.key_id = 'unknown-key' },
      (order: any) => { order.project_id = 'other-project' },
      (order: any) => { order.expires_at = '2026-08-15T19:30:00.000Z' },
    ]) {
      const state = setup()
      const order = signedWorkOrder()
      mutate(order)
      assert.equal((await state.app.handle({ method: 'POST', path: '/v1/work-orders', headers: headers('control-plane-token'), body: order })).status, 403)
    }
  })

  it('requires the approval gateway bearer token and allowlisted approver', async () => {
    const state = setup()
    await state.app.handle({ method: 'POST', path: '/v1/work-orders', headers: headers('control-plane-token'), body: signedWorkOrder() })
    const requested = await state.app.handle({ method: 'POST', path: '/v1/approvals/requests', headers: headers('control-plane-token'), body: mailAction() })
    const id = (requested.body as any).approval_id
    const decision = { approved: true, approved_by: 'unapproved', expires_at: '2026-08-15T20:15:00.000Z' }
    assert.equal((await state.app.handle({ method: 'POST', path: `/v1/approvals/${id}/decision`, body: decision })).status, 403)
    assert.equal((await state.app.handle({ method: 'POST', path: `/v1/approvals/${id}/decision`, headers: headers('approval-gateway-token'), body: decision })).status, 403)
  })

  it('serves the public application through the built-in Node HTTP server', async () => {
    const state = setup()
    const server = createBrokerHttpServer(state.app, { maxBodyBytes: 2048 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { status: 'ok' })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('exposes health/readiness and persists then returns a validated mission', async () => {
    const state = setup()
    assert.equal((await state.app.handle({ method: 'GET', path: '/healthz' })).status, 200)
    assert.equal((await state.app.handle({ method: 'GET', path: '/readyz' })).status, 200)
    assert.equal(
      (await state.app.handle({ method: 'POST', path: '/v1/work-orders', headers: headers('control-plane-token'), body: signedWorkOrder() })).status,
      201,
    )
    const mission = await state.app.handle({
      method: 'GET',
      path: `/v1/missions/${validWorkOrder().mission_id}`,
      headers: headers('internal-token'),
    })
    assert.equal(mission.status, 200)
    assert.equal((mission.body as any).mission_id, validWorkOrder().mission_id)

    const event = state.audit.events.find((entry) => entry.tool_action === 'work_order.create')!
    assert.deepEqual(Object.keys(event).sort(), [
      'agent_id', 'approval_reference', 'completed_at', 'deployed_version', 'duration_ms',
      'error', 'evidence', 'external_action', 'mission_id', 'redacted_input', 'result',
      'retries', 'started_at', 'state_changes', 'token_cost', 'tool_action',
    ].sort())
  })

  it('exposes approval request/decision and the one-time mail endpoint through injected transports', async () => {
    const state = setup()
    await state.app.handle({ method: 'POST', path: '/v1/work-orders', headers: headers('control-plane-token'), body: signedWorkOrder() })
    const action = mailAction()
    const requested = await state.app.handle({ method: 'POST', path: '/v1/approvals/requests', headers: headers('control-plane-token'), body: action })
    assert.equal(requested.status, 201)
    assert.equal(state.telegram.requests.length, 1)
    const approvalId = (requested.body as any).approval_id
    const decided = await state.app.handle({
      method: 'POST',
      path: `/v1/approvals/${approvalId}/decision`,
      headers: headers('approval-gateway-token'),
      body: { approved: true, approved_by: 'human-director', expires_at: '2026-08-15T20:15:00.000Z' },
    })
    const sent = await state.app.handle({
      method: 'POST',
      path: '/v1/mail/send',
      headers: headers('connector-token'),
      body: { action, approval_token: (decided.body as any).token },
    })
    assert.deepEqual(sent, { status: 200, body: { receipt_id: 'mail-receipt-1', approval_reference: '323e4567-e89b-42d3-a456-426614174000' } })
  })

  it('exposes the authenticated Hostinger webhook route', async () => {
    const state = setup()
    const response = await state.app.handle({
      method: 'POST',
      path: '/webhooks/hostinger-mail/contacto',
      headers: { authorization: 'Bearer 0123456789abcdef0123456789abcdef' },
      rawBody: JSON.stringify({ provider_event_id: 'evt-app-1', text: 'external instructions' }),
    })
    assert.deepEqual(response, { status: 202, body: { accepted: true, duplicate: false } })
  })
})
