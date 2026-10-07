import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, chown, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { HermesConversationProcess } from '../src/hermes-conversation-process.js'
import { NodeProcessRunner, type ProcessInvocation, type ProcessRunner } from '../src/hermes-executor.js'

const key = 'pcw1_' + 'a'.repeat(64)
const schema = 'proptimiza-conversation-child.v1'
const scope = { schema: 'proptimiza-hermes-affinity.v1', source: 'proptimiza-whatsapp', gateway_session_key: key }
const context = JSON.stringify({ schema: 'proptimiza-business-context.v1', revision: 'fixture', valid_from: 1, valid_until: 2000000000,
  facts: [{ id: 'fixture', text: 'Ficticio' }] })
const request = { schema, scope, context_json: context, context_sha256: createHash('sha256').update(context).digest('hex'),
  transcript: { schema: 'proptimiza-conversation-transcript.v1', scope, messages: [{ message_id: '101', sequence: 1, kind: 'incoming', content: 'Ficticio' }] },
  turn_sha256: 'b'.repeat(64), maximum_output_tokens: 16, timeout_seconds: 2 }
const raw = JSON.stringify(request)
const usage = { input_tokens: 20, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
  total_tokens: 30, api_calls: 1, model: 'deepseek-v4-flash', provider: 'opencode-go', completed: true, failed: false,
  estimated_cost_usd: null, cost_status: 'unknown', cost_source: 'none', session_id: null, service_tier: null }
function output() { return { schema, status: 'completed', execution_state: 'finished', native_usage_json: JSON.stringify(usage),
  reply: { conversation_key: key, last_message_id: '101', turn_sha256: request.turn_sha256, context_sha256: request.context_sha256,
    response: 'Respuesta ficticia.', fact_ids: ['fixture'], handoff_reason: 'none', send_permitted: false },
  transport_attempts: 1, stop_code: null } }
const invocation = { command: '/synthetic', args: [], env: {}, uid: 10002, gid: 10002, shell: false as const, detached: true as const, cwd: '/synthetic' }
const clock = () => new Date('2026-09-28T23:00:00Z')
const permit = () => ({ signal: new AbortController().signal, leaseLive: () => true, maximumTokens: 64, maximumUsd: .001 })
const stub = (value: unknown): ProcessRunner => ({ async run() { return { stdout: JSON.stringify(value) + '\n', stderr: '', exitCode: 0 } } })

test('binds the child reply and prices native usage without authorizing delivery', async () => {
  let call: ProcessInvocation | undefined
  const process = new HermesConversationProcess({ async run(c) { call = c; return stub(output()).run(c) } }, invocation, clock)
  const result = await process.run(raw, permit())
  assert.equal(result.stopCode, null)
  assert.equal(result.executionState, 'finished')
  assert.equal(result.reply?.last_message_id, '101')
  assert.equal(result.usage?.cost.usage_value_usd, .000009)
  assert.equal(result.usageRecordId, null)
  assert.equal(result.sendPermitted, false)
  assert.equal(call?.stdin, raw)
  assert.equal(call?.timeoutMs, 2000)
  await assert.rejects(process.run(raw, permit()), /CONSUMED/)
})
test('retains an allowlisted native session identity for one-time settlement', async () => {
  const value = output()
  value.native_usage_json = JSON.stringify({ ...usage, session_id: 'session_fixture-1' })
  const result = await new HermesConversationProcess(stub(value), invocation, clock).run(raw, permit())
  assert.equal(result.usageRecordId, 'opencode-session:session_fixture-1')
  assert.equal(result.usage?.tokens.total, 30)
})
test('denies invalid input and a dead lease before the runner', async () => {
  let calls = 0
  const runner: ProcessRunner = { async run() { calls++; throw Error() } }
  for (const bad of [raw + '\n', raw.replace('"schema":', '"schema":1,"schema":'), JSON.stringify({ ...request, tools: [] }), 'x'.repeat(131073)]) {
    const result = await new HermesConversationProcess(runner, invocation, clock).run(bad, permit())
    assert.equal(result.executionState, 'not_started'); assert.equal(result.stopCode, 'HERMES_CONVERSATION_INPUT_INVALID')
  }
  const result = await new HermesConversationProcess(runner, invocation, clock).run(raw, { ...permit(), leaseLive: () => false })
  assert.equal(result.executionState, 'not_started'); assert.equal(calls, 0)
})
test('revocation after child completion discards reply but retains known usage', async () => {
  let live = true
  const runner: ProcessRunner = { async run(c) { live = false; return stub(output()).run(c) } }
  const result = await new HermesConversationProcess(runner, invocation, clock).run(raw, { ...permit(), leaseLive: () => live })
  assert.equal(result.stopCode, 'HERMES_CONVERSATION_LEASE_EXPIRED')
  assert.equal(result.reply, null); assert.equal(result.usage?.tokens.total, 30)
})
test('rejects foreign recipient, event, context, turn, facts and send permission', async () => {
  for (const patch of [{ conversation_key: 'pcw1_' + 'f'.repeat(64) }, { last_message_id: '102' },
    { context_sha256: 'f'.repeat(64) }, { turn_sha256: 'f'.repeat(64) }, { fact_ids: ['foreign'] },
    { send_permitted: true }, { response: '' }, { recipient: 'foreign' }]) {
    const value = output(); Object.assign(value.reply, patch)
    const result = await new HermesConversationProcess(stub(value), invocation, clock).run(raw, permit())
    assert.equal(result.reply, null); assert.equal(result.stopCode, 'HERMES_CONVERSATION_REPLY_INVALID')
    assert.equal(result.usage?.tokens.total, 30)
  }
})
test('preserves budget overrun telemetry but rejects the reply', async () => {
  const result = await new HermesConversationProcess(stub(output()), invocation, clock).run(raw, { ...permit(), maximumTokens: 16 })
  assert.equal(result.reply, null); assert.equal(result.stopCode, 'HERMES_CONVERSATION_BUDGET_EXCEEDED')
  assert.equal(result.usage?.tokens.total, 30)
})
test('never fabricates zero usage for timeout, malformed output or a thrown runner', async () => {
  for (const runner of [stub({}), { async run() { throw Error('synthetic private details') } },
    { async run() { return { stdout: '', stderr: 'synthetic private details', exitCode: -1, timedOut: true } } }]) {
    const result = await new HermesConversationProcess(runner, invocation, clock).run(raw, permit())
    assert.equal(result.executionState, 'unknown'); assert.equal(result.usage, null); assert.equal(result.reply, null)
    assert(!JSON.stringify(result).includes('private'))
  }
})
test('maps closed child failures to diagnostic categories without exposing child text', async () => {
  const cases = [
    ['HERMES_CONVERSATION_INPUT_INVALID', 'HERMES_CHILD_INPUT_REJECTED'],
    ['HERMES_CONVERSATION_MODEL_FAILED', 'HERMES_CHILD_MODEL_REJECTED'],
    ['HERMES_CONVERSATION_EXECUTION_FAILED', 'HERMES_CHILD_EXECUTION_REJECTED'],
    ['HERMES_CONVERSATION_RESULT_INVALID', 'HERMES_CHILD_RESULT_REJECTED'],
    ['HERMES_CONVERSATION_REPLAY_DENIED', 'HERMES_CHILD_TRANSPORT_REJECTED'],
    ['HERMES_CONVERSATION_LEASE_EXPIRED', 'HERMES_CONVERSATION_LEASE_EXPIRED'],
    ['PRIVATE_FREE_FORM', 'HERMES_CONVERSATION_CHILD_REJECTED'],
  ] as const
  for (const [childCode, expected] of cases) {
    const value = { ...output(), status: 'failed', execution_state: 'unknown', reply: null,
      native_usage_json: null, transport_attempts: 1, stop_code: childCode }
    const result = await new HermesConversationProcess(stub(value), invocation, clock).run(raw, permit())
    assert.equal(result.stopCode, expected)
    assert.equal(result.reply, null)
    assert.equal(JSON.stringify(result).includes('PRIVATE_FREE_FORM'), false)
  }
})
test('bridges lease loss and AbortSignal to the process runner without retry', async () => {
  for (const external of [false, true]) {
    const controller = new AbortController(); let live = true, calls = 0
    const runner: ProcessRunner = { async run(c) {
      calls++
      const timer = setTimeout(() => { live = false; if (external) controller.abort() }, 5)
      await new Promise<void>(resolve => c.signal!.addEventListener('abort', () => resolve(), { once: true }))
      clearTimeout(timer)
      return { stdout: '', stderr: '', exitCode: -1, cancelled: true }
    } }
    const result = await new HermesConversationProcess(runner, invocation, clock).run(raw,
      { ...permit(), signal: controller.signal, leaseLive: () => live })
    assert.equal(calls, 1); assert.equal(result.executionState, 'unknown'); assert.equal(result.reply, null)
  }
})
test('snapshots trusted invocation before callbacks can mutate it', async () => {
  const config = { ...invocation, args: ['original'], env: { FIXTURE: 'original' } }
  let received: ProcessInvocation | undefined
  const runner: ProcessRunner = { async run(c) { received = c; return stub(output()).run(c) } }
  const child = new HermesConversationProcess(runner, config, clock)
  config.args[0] = 'changed'; config.env.FIXTURE = 'changed'
  await child.run(raw, permit())
  assert.deepEqual(received?.args, ['original']); assert.equal(received?.env.FIXTURE, 'original')
})
test('a revoked lease cannot become live again during child cleanup', async () => {
  let live = true
  const runner: ProcessRunner = { async run(c) {
    const timer = setTimeout(() => { live = false }, 5)
    await new Promise<void>(resolve => c.signal!.addEventListener('abort', () => resolve(), { once: true }))
    clearTimeout(timer); live = true
    return stub(output()).run(c)
  } }
  const result = await new HermesConversationProcess(runner, invocation, clock).run(raw, { ...permit(), leaseLive: () => live })
  assert.equal(result.stopCode, 'HERMES_CONVERSATION_LEASE_EXPIRED')
  assert.equal(result.reply, null); assert.equal(result.usage?.tokens.total, 30)
})
test('native Node parent invokes Python Hermes child with mock HTTP, then cancels a waiting native child',
  { skip: process.env.CONVERSATION_NATIVE_FIXTURE !== '1', timeout: 35000 }, async () => {
    const python = '/opt/hermes/.venv/bin/python'
    const fixture = resolve('test/hermes-conversation-native.py')
    const prepared = spawnSync(python, ['-B', fixture, '--prepare'], { encoding: 'utf8', timeout: 3000 })
    assert.equal(prepared.status, 0, prepared.stderr)
    const requestJson = prepared.stdout.trim()
    const binding = JSON.parse(requestJson)
    for (const cancel of [false, true]) {
      const home = await mkdtemp(join(tmpdir(), 'conversation-parent-'))
      try {
        await chown(home, 10002, 10002); await chmod(home, 0o700)
        const nativeInvocation = { command: python, args: ['-B', fixture, cancel ? '--wait' : '--mock'],
          env: { PATH: '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin', HOME: home, HERMES_HOME: home,
            PYTHONDONTWRITEBYTECODE: '1', OPENCODE_GO_API_KEY: 'synthetic-key-no-provider' },
          uid: 10002, gid: 10002, shell: false as const, detached: true as const, cwd: home }
        const controller = new AbortController()
        const timer = cancel ? setTimeout(() => controller.abort(), 1000) : undefined
        let result
        let diagnostic: { exitCode: number; timedOut?: boolean; cancelled?: boolean; phases: string[] } | undefined
        const runner: ProcessRunner = { async run(call) {
          const out = await new NodeProcessRunner().run(call)
          diagnostic = { exitCode: out.exitCode, timedOut: out.timedOut, cancelled: out.cancelled,
            phases: out.stderr.split('\n').filter(line => /^FIXTURE_[A-Z0-9_]+$/.test(line)) }
          return out
        } }
        try { result = await new HermesConversationProcess(runner, nativeInvocation, clock)
          .run(requestJson, { ...permit(), maximumTokens: 128, signal: controller.signal }) }
        finally { clearTimeout(timer) }
        assert.equal(result.sendPermitted, false)
        if (cancel) {
          assert.equal(result.stopCode, 'HERMES_CONVERSATION_CANCELLED'); assert.equal(result.usage, null)
          assert(diagnostic?.phases.includes('FIXTURE_WAITING'))
        }
        else {
          assert.equal(result.stopCode, null, JSON.stringify({ result, diagnostic }))
          assert.equal(result.reply?.last_message_id, binding.transcript.messages.at(-1).message_id)
          assert.equal(result.usage?.tokens.total, 30)
          assert.equal(result.usage?.cost.usage_value_usd, .000009)
          assert.equal(diagnostic?.phases.filter(code => code.startsWith('FIXTURE_MOCK_REQUEST_MS_')).length, 1)
          assert(diagnostic?.phases.some(code => code.startsWith('FIXTURE_CLOSED_MS_')))
        }
        console.log(JSON.stringify({ fixture: 'conversation-child-native', cancelled: cancel, diagnostic,
          tokens: result.usage?.tokens.total ?? null, sendPermitted: result.sendPermitted }))
        if (!cancel) {
          // Run the real entrypoint (no HTTP patch) with a bad turn pin. It must
          // reject before loading a model or reading the synthetic credential.
          const rejected = await new HermesConversationProcess(new NodeProcessRunner(), {
            ...nativeInvocation, args: ['-B', resolve('scripts/hermes_conversation_child.py')],
          }, clock).run(JSON.stringify({ ...binding, turn_sha256: 'f'.repeat(64) }), { ...permit(), maximumTokens: 128 })
          assert.equal(rejected.executionState, 'not_started')
          assert.equal(rejected.stopCode, 'HERMES_CHILD_INPUT_REJECTED')
          assert.equal(rejected.usage, null); assert.equal(rejected.reply, null)
        }
      } finally { await rm(home, { recursive: true, force: true }) }
    }
  })
