import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BrokerHttpClient, PaperclipHttpClient } from '../src/automation-http-clients.js'
import { loadCommercialAutomationConfig } from '../src/commercial-automation-main.js'

const company = '387d4503-0f7b-4708-bb62-8295a1e23e1b'
const project = '19055d28-5e59-4597-baa3-9357feccc96c'

describe('commercial automation HTTP boundaries', () => {
  it('accepts only exact internal Paperclip/Broker origins and file-backed separate credentials', () => {
    const config = loadCommercialAutomationConfig(environment())
    assert.equal(config.mode, 'observe')
    for (const mutate of [
      (env: Record<string, string | undefined>) => { env.PAPERCLIP_API_BASE = 'http://127.0.0.1:3100' },
      (env: Record<string, string | undefined>) => { env.BROKER_API_BASE = 'https://broker:8080' },
      (env: Record<string, string | undefined>) => { env.PAPERCLIP_BOARD_API_KEY = '' },
      (env: Record<string, string | undefined>) => { env.BROKER_CONTROL_PLANE_BEARER_FILE = env.BROKER_INTERNAL_BEARER_FILE },
    ]) {
      const changed = environment()
      mutate(changed)
      assert.throws(() => loadCommercialAutomationConfig(changed), /INVALID|FORBIDDEN|REUSE/)
    }
    assert.throws(() => new PaperclipHttpClient('http://169.254.169.254:3100', company, async () => 'x'.repeat(32)), /ORIGIN/)
    assert.throws(() => new BrokerHttpClient('http://broker:8081', async () => 'x'.repeat(32), async () => 'y'.repeat(32)), /ORIGIN/)
  })

  it('uses bounded authenticated Paperclip routes and parses only the expected issue contract', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new PaperclipHttpClient('http://paperclip:3100', company, async () => 'p'.repeat(32), async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ items: [{
        id: '123e4567-e89b-42d3-a456-426614174000', identifier: 'ALA-31', title: 'Diagnostic',
        description: 'untrusted', status: 'in_review', projectId: project, updatedAt: '2026-08-21T17:00:00.000Z',
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    assert.equal((await client.listIssues())[0].identifier, 'ALA-31')
    assert.equal(calls[0].url, `http://paperclip:3100/api/companies/${company}/issues?view=compact`)
    assert.equal((calls[0].init?.headers as Record<string, string>).authorization, `Bearer ${'p'.repeat(32)}`)
  })

  it('writes the exact installed Paperclip comment contract without spoofing actor attribution', async () => {
    let requestBody: unknown = null
    const client = new PaperclipHttpClient('http://paperclip:3100', company, async () => 'p'.repeat(32), async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ id: '123e4567-e89b-42d3-a456-426614174001' }), { status: 201 })
    })
    await client.addSignedComment('123e4567-e89b-42d3-a456-426614174000', 'marker')
    assert.deepEqual(requestBody, { body: 'marker' })
  })

  it('cancels oversized responses and fails closed without returning response bodies', async () => {
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close() } })
    const client = new PaperclipHttpClient('http://paperclip:3100', company, async () => 'p'.repeat(32), async () => new Response(oversized, { status: 200 }))
    await assert.rejects(() => client.listIssues(), /PAPERCLIP_UNAVAILABLE/)
  })

  it('reads only the closed shadow gate projection with the internal bearer', async () => {
    let request: { url: string; authorization: string } | null = null
    const client = new BrokerHttpClient(
      'http://broker:8080',
      async () => 'c'.repeat(32),
      async () => 'i'.repeat(32),
      async (input, init) => {
        request = {
          url: String(input),
          authorization: (init?.headers as Record<string, string>).authorization,
        }
        return new Response(JSON.stringify({
          review_id: 'a1500000-0000-4500-8500-000000000050',
          mission_id: 'a1500000-0000-4500-8500-000000000051',
          status: 'completed', completed_decisions: 30, expected_decisions: 30,
          concordance_percent: 90, evidence_completeness_percent: 95,
          shadow_gate: 'passed', production_gate: 'blocked', external_actions: 0,
          eligible: true, observed_at: '2026-08-24T12:00:00.000Z',
        }), { status: 200 })
      },
    )
    const gate = await client.getShadowReviewGate('a1500000-0000-4500-8500-000000000050')
    assert.equal(gate.eligible, true)
    assert.deepEqual(request, {
      url: 'http://broker:8080/internal/v1/shadow-gates/a1500000-0000-4500-8500-000000000050',
      authorization: `Bearer ${'i'.repeat(32)}`,
    })
  })
})

function environment(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production', COMMERCIAL_MODE: 'simulation', AUTOMATION_MODE: 'observe',
    AUTOMATION_HOST: '0.0.0.0', AUTOMATION_PORT: '8090',
    AUTOMATION_TRIGGER_BEARER_FILE: '/run/secrets/automation-trigger',
    PAPERCLIP_BOARD_API_KEY_FILE: '/run/secrets/paperclip-board-key',
    BROKER_CONTROL_PLANE_BEARER_FILE: '/run/secrets/broker-control',
    BROKER_INTERNAL_BEARER_FILE: '/run/secrets/broker-internal',
    WORK_ORDER_HMAC_SECRET_FILE: '/run/secrets/work-order-hmac',
    PAPERCLIP_COMPANY_ID: company, PAPERCLIP_PROJECT_ID: project,
    PAPERCLIP_API_BASE: 'http://paperclip:3100', BROKER_API_BASE: 'http://broker:8080',
    WORK_ORDER_ISSUER: 'proptimiza-commercial-broker', WORK_ORDER_AUDIENCE: 'proptimiza-hermes-executor',
    WORK_ORDER_KEY_ID: 'control-key-1',
  }
}
