import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InternalMailOneShot, InternalMailOneShotError, type InternalMailOneShotPorts } from '../src/internal-mail-one-shot.js'

const NOW = new Date('2026-08-26T20:00:00.000Z')
const PLAN_HASH = '18fe59be00a1b5dd5f4e3bb81f77ef41d69f17024cc2797e7b1ecacc3f34f348'
const ids = ['123e4567-e89b-42d3-a456-426614174001','123e4567-e89b-42d3-a456-426614174002']

function input() {
  return {
    readiness: { status: 'ready_for_a3_request' as const, qa_approved: true as const, execution_allowed: false as const, checked_at: '2026-08-26T19:59:00.000Z', plan_hash: PLAN_HASH as typeof PLAN_HASH, action: { sender: 'ventas@proptimiza.com' as const, recipient: 'contacto@proptimiza.com' as const, volume: 1 as const }, failures: [] as [] },
    authorization: { approved_by: 'proptimizaspa@gmail.com' as const, authorized_at: '2026-08-26T19:59:30.000Z', authorized_plan_hash: PLAN_HASH as typeof PLAN_HASH, instruction_sha256: 'a'.repeat(64) },
  }
}

function setup(overrides: Partial<InternalMailOneShotPorts> = {}) {
  const events: string[] = []
  let active = true
  let sends = 0
  const ports: InternalMailOneShotPorts = {
    createWorkOrder: async (order) => { events.push(`mission:${order.autonomy_level}:${order.dry_run}`) },
    requestApproval: async (action) => ({ approval_id: '223e4567-e89b-42d3-a456-426614174003', action_hash: (await import('../src/canonical.js')).hashAction(action) }),
    approve: async () => ({ token: `APPROVAL::${'x'.repeat(120)}` }),
    isGlobalKillSwitchActive: async () => active,
    setGlobalKillSwitch: async (value) => { active = value; events.push(`switch:${value}`) },
    send: async ({ action }) => { sends += 1; events.push(`send:${action.recipients[0]}`); return { receipt_id: 'hostinger:receipt', approval_reference: '223e4567-e89b-42d3-a456-426614174003' } },
    record: async (event) => { events.push(event.type) },
    ...overrides,
  }
  let index = 0
  const runner = new InternalMailOneShot({ ports, now: () => NOW, uuid: () => ids[index++]! })
  return { runner, events, get active() { return active }, get sends() { return sends } }
}

describe('single-use internal mail transaction', () => {
  it('binds one A3 mission and approval to the exact internal message and restores the switch', async () => {
    const state = setup()
    const result = await state.runner.run(input())
    assert.equal(result.receipt_id, 'hostinger:receipt')
    assert.equal(state.sends, 1)
    assert.equal(state.active, true)
    assert.deepEqual(state.events, [
      'mission:A3:false','mission.created','switch:false','kill_switch.opened_for_single_send',
      'send:contacto@proptimiza.com','switch:true','mail.sent_once',
    ])
  })

  it('rejects stale readiness or authorization before creating a mission', async () => {
    for (const mutate of [
      (value: ReturnType<typeof input>) => { value.readiness.checked_at = '2026-08-26T19:00:00.000Z' },
      (value: ReturnType<typeof input>) => { value.authorization.authorized_plan_hash = '0'.repeat(64) as typeof PLAN_HASH },
      (value: ReturnType<typeof input>) => { value.authorization.instruction_sha256 = 'invalid' },
    ]) {
      const value = input(); mutate(value)
      const state = setup()
      await assert.rejects(state.runner.run(value), InternalMailOneShotError)
      assert.deepEqual(state.events, [])
      assert.equal(state.sends, 0)
    }
  })

  it('never sends while the switch is already open', async () => {
    const state = setup({ isGlobalKillSwitchActive: async () => false })
    await assert.rejects(state.runner.run(input()), /KILL_SWITCH_NOT_ACTIVE_BEFORE_SEND/)
    assert.equal(state.sends, 0)
  })

  it('does not retry an uncertain send and restores the switch', async () => {
    let attempts = 0
    const state = setup({ send: async () => { attempts += 1; throw new Error('delivery_uncertain') } })
    await assert.rejects(state.runner.run(input()), /SINGLE_SEND_FAILED/)
    assert.equal(attempts, 1)
    assert.equal(state.active, true)
    assert.deepEqual(state.events.slice(-1), ['switch:true'])
  })

  it('attempts fail-safe restoration even when opening the switch errors', async () => {
    const calls: boolean[] = []
    const state = setup({
      setGlobalKillSwitch: async (value) => { calls.push(value); if (!value) throw new Error('open_uncertain') },
    })
    await assert.rejects(state.runner.run(input()), /SINGLE_SEND_FAILED/)
    assert.deepEqual(calls, [false, true])
    assert.equal(state.sends, 0)
  })

  it('surfaces switch restoration failure as the terminal safety error', async () => {
    let active = true
    const state = setup({
      isGlobalKillSwitchActive: async () => active,
      setGlobalKillSwitch: async (value) => { if (value) throw new Error('restore_failed'); active = false },
    })
    await assert.rejects(state.runner.run(input()), /KILL_SWITCH_RESTORE_FAILED/)
  })
})
