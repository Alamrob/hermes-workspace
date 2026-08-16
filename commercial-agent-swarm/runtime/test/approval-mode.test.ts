import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ApprovalModeCoordinator,
  evaluateApprovalMode,
  parseApprovalMode,
  type ApprovalChannelEvidence,
} from '../src/approval-mode.js'

const sales: ApprovalChannelEvidence = {
  approvalId: '323e4567-e89b-42d3-a456-426614174000',
  actionHash: 'a'.repeat(64),
  channel: 'sales',
  decision: 'approved',
  actorId: 'sales-director',
  decidedAt: '2026-08-16T12:00:00.000Z',
}
const telegram: ApprovalChannelEvidence = {
  ...sales,
  channel: 'telegram',
  actorId: 'telegram-user-1',
}

describe('multi-channel approval mode', () => {
  it('defaults to either and accepts only the four closed modes', () => {
    assert.equal(parseApprovalMode(undefined), 'either')
    for (const mode of [
      'sales_only',
      'telegram_only',
      'either',
      'dual_channel',
    ] as const)
      assert.equal(parseApprovalMode(mode), mode)
    assert.throws(() => parseApprovalMode('all'), /INVALID_APPROVAL_MODE/)
  })

  it('evaluates sales-only, telegram-only, either, and dual-channel evidence', () => {
    assert.equal(evaluateApprovalMode('sales_only', [sales]), 'approved')
    assert.equal(evaluateApprovalMode('sales_only', [telegram]), 'pending')
    assert.equal(evaluateApprovalMode('telegram_only', [telegram]), 'approved')
    assert.equal(evaluateApprovalMode('either', [telegram]), 'approved')
    assert.equal(evaluateApprovalMode('dual_channel', [sales]), 'pending')
    assert.equal(
      evaluateApprovalMode('dual_channel', [sales, telegram]),
      'approved',
    )
    assert.equal(
      evaluateApprovalMode('either', [
        sales,
        { ...telegram, decision: 'denied' },
      ]),
      'denied',
    )
  })

  it('issues no grant until the configured durable evidence is satisfied', async () => {
    const evidence: ApprovalChannelEvidence[] = []
    const grants: unknown[] = []
    const coordinator = new ApprovalModeCoordinator({
      mode: 'dual_channel',
      store: {
        record: async (value) => void evidence.push(value),
        list: async () => [...evidence],
      },
      grants: {
        decide: async (...args) => {
          grants.push(args)
          return { status: 'approved', token: 'token' }
        },
      },
    })
    assert.deepEqual(
      await coordinator.submit(sales, '2026-08-16T12:15:00.000Z'),
      { status: 'pending' },
    )
    assert.equal(grants.length, 0)
    assert.deepEqual(
      await coordinator.submit(telegram, '2026-08-16T12:15:00.000Z'),
      { status: 'approved', token: 'token' },
    )
    assert.equal(grants.length, 1)
  })

  it('rejects changed hashes and duplicate channel decisions fail-closed', async () => {
    const coordinator = new ApprovalModeCoordinator({
      mode: 'either',
      store: {
        record: async () => {
          throw new Error('APPROVAL_EVIDENCE_CONFLICT')
        },
        list: async () => [],
      },
      grants: { decide: async () => ({ status: 'approved', token: 'never' }) },
    })
    await assert.rejects(
      coordinator.submit(sales, '2026-08-16T12:15:00.000Z'),
      /APPROVAL_EVIDENCE_CONFLICT/,
    )
  })
})
