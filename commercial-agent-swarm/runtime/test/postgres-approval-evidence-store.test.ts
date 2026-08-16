import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PostgresApprovalEvidenceStore } from '../src/postgres-approval-evidence-store.js'
import type { ApprovalChannelEvidence } from '../src/approval-mode.js'

const evidence: ApprovalChannelEvidence = {
  approvalId: '323e4567-e89b-42d3-a456-426614174000',
  actionHash: 'a'.repeat(64),
  channel: 'sales',
  decision: 'approved',
  actorId: 'sales-director',
  decidedAt: '2026-08-16T12:00:00.000Z',
}

describe('PostgreSQL approval evidence capability adapter', () => {
  it('records and reads evidence only through narrow control functions', async () => {
    const queries: string[] = []
    const store = new PostgresApprovalEvidenceStore({
      query: async (sql) => {
        queries.push(sql)
        if (sql.includes('list_approval_channel_evidence'))
          return {
            rows: [
              {
                approval_id: evidence.approvalId,
                action_hash: evidence.actionHash,
                channel: evidence.channel,
                decision: evidence.decision,
                actor_id: evidence.actorId,
                decided_at: evidence.decidedAt,
              },
            ],
          }
        return { rows: [{ recorded: true }] }
      },
    })
    await store.record(evidence)
    assert.deepEqual(await store.list(evidence.approvalId), [evidence])
    assert.equal(queries[0].includes('control.record_approval_channel_evidence'), true)
    assert.equal(queries[1].includes('control.list_approval_channel_evidence'), true)
    assert.equal(queries.every((sql) => !/control\.approvals\b/.test(sql)), true)
  })
})
