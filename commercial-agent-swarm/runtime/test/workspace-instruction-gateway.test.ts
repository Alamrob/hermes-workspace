import assert from 'node:assert/strict'
import { once } from 'node:events'
import { describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createWorkspaceInstructionGateway } from '../src/workspace-instruction-gateway.js'
import { loadWorkspaceInstructionGatewayConfig } from '../src/workspace-instruction-gateway-main.js'

const workspaceBearer = 'workspace-bearer-0123456789abcdef0123456789'
const brokerBearer = 'broker-bearer-fedcba9876543210fedcba9876'
const fixedNow = new Date('2026-08-22T20:00:00.000Z')

describe('deterministic Workspace instruction gateway', () => {
  it('exposes only health, one model, and a non-executable streamed instruction receipt', async () => {
    const brokerCalls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
    const server = createWorkspaceInstructionGateway({
      host: '0.0.0.0',
      port: 8642,
      workspaceBearer,
      brokerBearer,
      brokerBase: 'http://broker:8080',
      requestedBy: 'proptimizaspa@gmail.com',
      now: () => fixedNow,
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        brokerCalls.push({ url: String(input), init: init!, body })
        return new Response(JSON.stringify({
          request_id: body.request_id,
          status: 'pending_codex_review',
          requires_codex_review: true,
          external_actions_allowed: false,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(health.status, 200)
      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/models`)
      assert.equal(unauthorized.status, 401)
      const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${workspaceBearer}` },
      })
      assert.deepEqual(await models.json(), {
        object: 'list',
        data: [{ id: 'commercial-instruction-inbox', object: 'model', owned_by: 'proptimiza-control-plane' }],
      })

      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${workspaceBearer}`,
          'content-type': 'application/json',
          'x-claude-session-id': 'session-1',
        },
        body: JSON.stringify({
          model: 'commercial-instruction-inbox',
          messages: [
            { role: 'system', content: 'Respond in Spanish.' },
            { role: 'user', content: 'Investiga diez cuentas del ICP aprobado.' },
          ],
          stream: true,
        }),
      })
      assert.equal(response.status, 200)
      const stream = await response.text()
      assert.match(stream, /Instrucción registrada para revisión de Codex/)
      assert.match(stream, /No se ejecutó ninguna acción externa/)
      assert.match(stream, /data: \[DONE\]/)
      assert.equal(brokerCalls.length, 1)
      assert.equal(brokerCalls[0].url, 'http://broker:8080/v1/instruction-requests')
      assert.equal(new Headers(brokerCalls[0].init.headers).get('authorization'), `Bearer ${brokerBearer}`)
      assert.deepEqual(
        {
          project_id: brokerCalls[0].body.project_id,
          instruction: brokerCalls[0].body.instruction,
          source: brokerCalls[0].body.source,
          autonomy_ceiling: brokerCalls[0].body.autonomy_ceiling,
          requires_codex_review: brokerCalls[0].body.requires_codex_review,
          external_actions_allowed: brokerCalls[0].body.external_actions_allowed,
        },
        {
          project_id: 'proptimiza',
          instruction: 'Investiga diez cuentas del ICP aprobado.',
          source: 'workspace',
          autonomy_ceiling: 'A0',
          requires_codex_review: true,
          external_actions_allowed: false,
        },
      )
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('deduplicates identical session content before the broker and never accepts execution extensions', async () => {
    const ids: string[] = []
    const server = createWorkspaceInstructionGateway({
      host: '0.0.0.0', port: 8642, workspaceBearer, brokerBearer,
      brokerBase: 'http://broker:8080', requestedBy: 'proptimizaspa@gmail.com',
      now: () => fixedNow,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        ids.push(String(body.request_id))
        return new Response(JSON.stringify({
          request_id: body.request_id, status: 'pending_codex_review',
          requires_codex_review: true, external_actions_allowed: false,
        }), { status: ids.length === 1 ? 201 : 200 })
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const send = (extra: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspaceBearer}`,
        'content-type': 'application/json',
        'x-claude-session-id': 'same-session',
      },
      body: JSON.stringify({
        model: 'commercial-instruction-inbox',
        messages: [{ role: 'user', content: 'Preparar análisis sin contactar.' }],
        stream: false,
        ...extra,
      }),
    })
    try {
      assert.equal((await send()).status, 200)
      assert.equal((await send()).status, 200)
      assert.equal(ids.length, 2)
      assert.equal(ids[0], ids[1])
      assert.equal((await send({ tools: [{ type: 'function' }] })).status, 400)
      assert.equal(ids.length, 2)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('fails closed for invalid credentials, input, broker results, and unsafe configuration', async () => {
    assert.throws(() => createWorkspaceInstructionGateway({
      host: '0.0.0.0', port: 8642, workspaceBearer, brokerBearer: workspaceBearer,
      brokerBase: 'http://broker:8080', requestedBy: 'proptimizaspa@gmail.com',
    }), /WORKSPACE_GATEWAY_SECRET_REUSE/)
    assert.throws(() => loadWorkspaceInstructionGatewayConfig({
      NODE_ENV: 'production', COMMERCIAL_MODE: 'simulation', A3_ENABLED: 'false',
      EXTERNAL_ACTION_KILL_SWITCH: 'true', WORKSPACE_API_BEARER: 'raw',
    }), /WORKSPACE_GATEWAY_RAW_SECRET_FORBIDDEN/)
    assert.deepEqual(loadWorkspaceInstructionGatewayConfig({
      NODE_ENV: 'production', COMMERCIAL_MODE: 'simulation', A3_ENABLED: 'false',
      EXTERNAL_ACTION_KILL_SWITCH: 'true', WORKSPACE_GATEWAY_HOST: '0.0.0.0',
      WORKSPACE_GATEWAY_PORT: '8642', BROKER_API_BASE: 'http://broker:8080',
      WORKSPACE_REQUESTED_BY: 'proptimizaspa@gmail.com',
      WORKSPACE_API_BEARER_FILE: '/run/secrets/workspace-api-bearer',
      BROKER_INSTRUCTION_BEARER_FILE: '/run/secrets/broker-instruction-bearer',
    }), {
      host: '0.0.0.0', port: 8642,
      workspaceBearerFile: '/run/secrets/workspace-api-bearer',
      brokerBearerFile: '/run/secrets/broker-instruction-bearer',
      brokerBase: 'http://broker:8080', requestedBy: 'proptimizaspa@gmail.com',
    })
  })
})
