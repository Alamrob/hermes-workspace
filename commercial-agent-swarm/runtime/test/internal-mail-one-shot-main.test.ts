import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashAction } from '../src/canonical.js'
import { InternalMailHttpPorts } from '../src/internal-mail-one-shot-main.js'
import type { ApprovalAction } from '../src/approvals.js'
import type { WorkOrder } from '../src/work-orders.js'

const ACTION: ApprovalAction = {
  mission_id: '123e4567-e89b-42d3-a456-426614174001',
  project_id: 'proptimiza', project_version: 'v1', action_type: 'mail.send', channel: 'email',
  sender: 'ventas@proptimiza.com', recipients: ['contacto@proptimiza.com'],
  subject: 'Prueba interna de correo Proptimiza', content: 'internal',
  content_version: 'internal-mail-test-v1', volume: 1, offer_version: 'offer-v1', policy_version: 'policy-v1',
  idempotency_key: 'internal-mail-test:123e4567-e89b-42d3-a456-426614174001',
}

describe('internal-mail one-shot production adapters', () => {
  it('uses only loopback broker routes and capability-specific bearers', async () => {
    const calls: Array<{ url: string; authorization: string; body: any }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body))
      calls.push({ url, authorization: String((init?.headers as Record<string, string>).authorization), body })
      if (url.endsWith('/v1/work-orders')) return json(201, { status: 'accepted' })
      if (url.endsWith('/v1/approvals/requests')) return json(201, { approval_id: '223e4567-e89b-42d3-a456-426614174003', action_hash: hashAction(ACTION) })
      if (url.includes('/decision')) return json(200, { status: 'approved', token: `APPROVAL::${'x'.repeat(120)}` })
      if (url.endsWith('/internal/v1/safety/kill-switch')) return json(200, { active: true })
      if (url.endsWith('/v1/mail/send')) return json(200, { receipt_id: 'receipt-1', approval_reference: 'approval-1' })
      throw new Error('unexpected route')
    }
    const runtimeQueries: unknown[][] = []
    const safetyQueries: unknown[][] = []
    const pool = (queries: unknown[][], rows: unknown[]) => ({
      query: async (...args: unknown[]) => { queries.push(args); return { rows } },
      end: async () => undefined,
    })
    const ports = new InternalMailHttpPorts({
      workOrderSecret: 'w'.repeat(32), workOrderKeyId: 'simulation-v1',
      controlBearer: 'control', salesApprovalBearer: 'sales', connectorBearer: 'connector', internalBearer: 'internal',
      runtimeDatabaseUrl: 'postgres://unused', safetyDatabaseUrl: 'postgres://unused', fetchImpl: fetchImpl as typeof fetch,
      runtimePool: pool(runtimeQueries, []) as never,
      safetyPool: pool(safetyQueries, [{ changed: true }]) as never,
    })
    const order = { mission_id: ACTION.mission_id, authority: { key_id: 'wrong', signature: '0'.repeat(64) } } as unknown as WorkOrder
    await ports.createWorkOrder(order)
    await ports.requestApproval(ACTION)
    await ports.approve({ approval_id: '223e4567-e89b-42d3-a456-426614174003', action_hash: hashAction(ACTION), actor_id: 'proptimizaspa@gmail.com', decided_at: '2026-08-26T20:00:00Z', expires_at: '2026-08-26T20:15:00Z' })
    assert.equal(await ports.isKillSwitchActive({ missionId: '*', channel: '*' }), true)
    await ports.setGlobalKillSwitch(false)
    await ports.setEmailKillSwitch(false)
    await ports.send({ action: ACTION, approval_token: `APPROVAL::${'x'.repeat(120)}` })
    await ports.record({ type: 'mail.sent_once', at: '2026-08-26T20:00:00Z', mission_id: ACTION.mission_id, details: { receipt_recorded: true } })
    await ports.close()

    assert.equal(calls.every((call) => call.url.startsWith('http://127.0.0.1:8080/')), true)
    assert.deepEqual(calls.map((call) => call.authorization), ['Bearer control','Bearer control','Bearer sales','Bearer internal','Bearer connector'])
    assert.match(String((calls[0]!.body.authority as any).signature), /^[0-9a-f]{64}$/)
    assert.notEqual((calls[0]!.body.authority as any).signature, '0'.repeat(64))
    assert.deepEqual(safetyQueries, [
      ["SELECT control.set_kill_switch('global','*',$1) AS changed", [false]],
      ["SELECT control.set_kill_switch('channel','email',$1) AS changed", [false]],
    ])
    assert.equal(runtimeQueries.length, 1)
    const serialized = JSON.stringify({ calls, runtimeQueries, safetyQueries })
    for (const secret of ['w'.repeat(32), 'control', 'sales', 'connector', 'internal']) {
      if (secret.length > 10) assert.equal(serialized.includes(secret), false)
    }
  })
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
