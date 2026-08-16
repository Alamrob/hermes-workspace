import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { ApprovalBroker } from '../src/approvals.js'
import { hashAction } from '../src/canonical.js'
import { MailService } from '../src/mail.js'
import {
  PostgresAuditSink,
  PostgresRuntimeRepository,
} from '../src/postgres-repository.js'
import { validWorkOrder } from '../test/fixtures.js'
import type { ApprovalAction } from '../src/approvals.js'
import type { MailTransport } from '../src/mail.js'
import type { StructuredAuditEvent } from '../src/observability.js'
import type {
  ApprovalGrantRecord,
  ApprovalRequestRecord,
  MissionRecord,
} from '../src/repository.js'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const MIGRATION_URLS = [
  new URL('../migrations/001_runtime.sql', import.meta.url),
  new URL('../migrations/002_commercial_control_plane.sql', import.meta.url),
]
const NOW = '2026-08-15T20:00:00.000Z'
const LATER = '2026-08-15T20:15:00.000Z'

const integration = ADMIN_URL ? describe : describe.skip

integration('PostgreSQL 17 runtime repository', () => {
  const databaseName = `proptimiza_runtime_${randomUUID().replaceAll('-', '')}`
  let adminPool: Pool
  let firstPool: Pool
  let secondPool: Pool
  let first: PostgresRuntimeRepository
  let second: PostgresRuntimeRepository

  before(async () => {
    adminPool = new Pool({ connectionString: ADMIN_URL })
    await adminPool.query(`CREATE DATABASE "${databaseName}"`)
    const databaseUrl = new URL(ADMIN_URL!)
    databaseUrl.pathname = `/${databaseName}`
    firstPool = new Pool({ connectionString: databaseUrl.toString(), max: 4 })
    secondPool = new Pool({ connectionString: databaseUrl.toString(), max: 4 })
    const migrations = await Promise.all(
      MIGRATION_URLS.map((url) => readFile(url, 'utf8')),
    )
    for (const migration of migrations) await firstPool.query(migration)
    for (const migration of migrations) await firstPool.query(migration)
    first = new PostgresRuntimeRepository(firstPool)
    second = new PostgresRuntimeRepository(secondPool)
  })

  after(async () => {
    await Promise.allSettled([firstPool.end(), secondPool.end()])
    await adminPool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    )
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    await adminPool.end()
  })

  it('persists missions across repository restarts and rejects payload collisions', async () => {
    const mission = missionRecord(
      '123e4567-e89b-42d3-a456-426614174101',
      'mission-db-0001',
    )
    await first.saveMission(mission)

    assert.deepEqual(await second.getMission(mission.mission_id), mission)
    assert.equal(await second.isMissionA3Enabled(mission.mission_id), true)
    await second.saveMission(mission)
    await assert.rejects(
      second.saveMission({ ...mission, objective: 'payload changed' }),
      /MISSION_CONFLICT/,
    )
    await assert.rejects(
      second.saveMission({
        ...mission,
        mission_id: '123e4567-e89b-42d3-a456-426614174102',
      }),
      /MISSION_CONFLICT/,
    )
    await assert.rejects(
      second.saveMission({
        ...mission,
        mission_id: '123e4567-e89b-42d3-a456-426614174103',
        idempotency_key: 'mission-db-unknown-version',
        offer_version: 'offer-v999',
      }),
      /UNKNOWN_CATALOG_VERSION/,
    )
  })

  it('compares approval decisions and consumes one grant atomically across instances', async () => {
    const request = approvalRequest(
      '323e4567-e89b-42d3-a456-426614174101',
      '123e4567-e89b-42d3-a456-426614174101',
    )
    await first.createApprovalRequest(request)
    const grant = approvalGrant(request)

    const decisions = await Promise.all([
      first.saveApprovalDecision(grant),
      second.saveApprovalDecision({ ...grant, approved_by: 'other-director' }),
    ])
    assert.deepEqual(decisions.sort(), [false, true])

    const consumed = await Promise.all([
      first.consumeApproval({
        missionId: request.action.mission_id,
        actionHash: request.action_hash,
        nonce: grant.nonce,
        now: NOW,
      }),
      second.consumeApproval({
        missionId: request.action.mission_id,
        actionHash: request.action_hash,
        nonce: grant.nonce,
        now: NOW,
      }),
    ])
    assert.equal(consumed.filter(Boolean).length, 1)
    assert.equal(consumed.filter((record) => record === null).length, 1)
  })

  it('enforces one approved grant for an exact mission, action hash, and nonce', async () => {
    const missionId = '123e4567-e89b-42d3-a456-426614174111'
    const firstRequest = approvalRequest(
      '323e4567-e89b-42d3-a456-426614174111',
      missionId,
    )
    const duplicateRequest = approvalRequest(
      '423e4567-e89b-42d3-a456-426614174111',
      missionId,
    )
    await first.createApprovalRequest(firstRequest)
    await first.createApprovalRequest(duplicateRequest)
    assert.equal(
      await first.saveApprovalDecision(approvalGrant(firstRequest)),
      true,
    )

    await assert.rejects(
      second.saveApprovalDecision({
        ...approvalGrant(duplicateRequest),
        token: `APPROVAL::${missionId}::${duplicateRequest.action_hash}::${LATER}::00112233445566778899aabbccddeeff::${'c'.repeat(64)}`,
      }),
      /duplicate key|unique constraint/i,
    )
    const consumed = await second.consumeApproval({
      missionId,
      actionHash: firstRequest.action_hash,
      nonce: approvalGrant(firstRequest).nonce,
      now: NOW,
    })
    assert.equal(consumed?.approval_id, firstRequest.approval_id)
  })

  it('permits exactly one concurrent action claim and returns its persisted receipt and approval', async () => {
    const mission = missionRecord(
      '123e4567-e89b-42d3-a456-426614174201',
      'mission-db-0201',
    )
    const request = approvalRequest(
      '323e4567-e89b-42d3-a456-426614174201',
      mission.mission_id,
    )
    await first.saveMission(mission)
    await first.createApprovalRequest(request)
    await first.saveApprovalDecision(approvalGrant(request))
    await first.consumeApproval({
      missionId: mission.mission_id,
      actionHash: request.action_hash,
      nonce: approvalGrant(request).nonce,
      now: NOW,
    })

    const claim = {
      missionId: mission.mission_id,
      channel: 'email',
      idempotencyKey: 'mail-db-0201',
      actionHash: request.action_hash,
    }
    const attempts = await Promise.allSettled([
      first.claimExternalAction(claim),
      second.claimExternalAction(claim),
    ])
    assert.equal(
      attempts.filter(
        (attempt) =>
          attempt.status === 'fulfilled' && attempt.value.status === 'acquired',
      ).length,
      1,
    )
    const rejected = attempts.find((attempt) => attempt.status === 'rejected')
    assert.ok(rejected && rejected.reason instanceof Error)
    assert.equal(rejected.reason.message, 'EXECUTION_IN_PROGRESS')

    await first.completeExternalAction({
      missionId: mission.mission_id,
      idempotencyKey: claim.idempotencyKey,
      actionHash: claim.actionHash,
      receipt_id: 'receipt-db-0201',
      approval_id: request.approval_id,
    })
    assert.deepEqual(await second.claimExternalAction(claim), {
      status: 'completed',
      receipt_id: 'receipt-db-0201',
      approval_id: request.approval_id,
    })
  })

  it('rejects a completed idempotency key when any action hash field changes', async () => {
    const mission = missionRecord(
      '123e4567-e89b-42d3-a456-426614174211',
      'mission-db-0211',
    )
    await first.saveMission(mission)
    const request = approvalRequest(
      '323e4567-e89b-42d3-a456-426614174211',
      mission.mission_id,
    )
    await first.createApprovalRequest(request)
    await first.saveApprovalDecision(approvalGrant(request))
    await first.consumeApproval({
      missionId: mission.mission_id,
      actionHash: request.action_hash,
      nonce: approvalGrant(request).nonce,
      now: NOW,
    })
    const claim = {
      missionId: mission.mission_id,
      channel: 'email',
      idempotencyKey: 'mail-db-0211',
      actionHash: 'a'.repeat(64),
    }
    assert.deepEqual(await first.claimExternalAction(claim), {
      status: 'acquired',
    })
    await first.completeExternalAction({
      missionId: mission.mission_id,
      idempotencyKey: claim.idempotencyKey,
      actionHash: claim.actionHash,
      receipt_id: 'receipt-db-0211',
      approval_id: request.approval_id,
    })

    await assert.rejects(
      second.claimExternalAction({ ...claim, actionHash: 'b'.repeat(64) }),
      /IDEMPOTENCY_CONFLICT/,
    )
  })

  it('runs a full overlapping two-grant flow with one transport send', async () => {
    const missionId = '123e4567-e89b-42d3-a456-426614174221'
    const mission = {
      ...missionRecord(missionId, 'mission-db-0221'),
      expires_at: '2026-08-15T21:00:00.000Z',
      allowed_actions: ['mail.send'],
      prohibited_actions: [],
      approved_channels: ['email'],
      approved_tools: ['broker.mail'],
      dry_run: false,
      project_id: 'proptimiza',
      project_version: 'v1',
      offer_version: 'offer-v1',
      policy_version: 'policy-v1',
    }
    await first.saveMission(mission)
    const action = approvalAction(missionId)
    const secret = 'postgres-test-secret-with-at-least-32-bytes'
    const firstBroker = new ApprovalBroker({
      repository: first,
      hmacSecret: secret,
      now: () => new Date(NOW),
      id: () => '323e4567-e89b-42d3-a456-426614174221',
      nonce: () => '00112233445566778899aabbccddeeff',
    })
    const secondBroker = new ApprovalBroker({
      repository: second,
      hmacSecret: secret,
      now: () => new Date(NOW),
      id: () => '423e4567-e89b-42d3-a456-426614174221',
      nonce: () => 'ffeeddccbbaa99887766554433221100',
    })
    const firstRequest = await firstBroker.request(action)
    const secondRequest = await secondBroker.request(action)
    const firstToken = (
      await firstBroker.decide(firstRequest.approval_id, {
        approved: true,
        approved_by: 'human-director',
        expires_at: LATER,
      })
    ).token!
    const secondToken = (
      await secondBroker.decide(secondRequest.approval_id, {
        approved: true,
        approved_by: 'human-director',
        expires_at: LATER,
      })
    ).token!
    let releaseTransport!: () => void
    let transportEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      transportEntered = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseTransport = resolve
    })
    const sent: Array<ApprovalAction> = []
    const transport: MailTransport = {
      async send(value) {
        sent.push(structuredClone(value))
        transportEntered()
        await released
        return { receipt_id: 'receipt-db-0221' }
      },
    }
    const firstMail = new MailService({
      repository: first,
      approvals: firstBroker,
      transport,
      now: () => new Date(NOW),
    })
    const secondMail = new MailService({
      repository: second,
      approvals: secondBroker,
      transport,
      now: () => new Date(NOW),
    })
    const firstSend = firstMail.send({ action, approval_token: firstToken })
    await entered
    await assert.rejects(
      secondMail.send({ action, approval_token: secondToken }),
      /EXECUTION_IN_PROGRESS/,
    )
    releaseTransport()
    assert.deepEqual(await firstSend, {
      receipt_id: 'receipt-db-0221',
      approval_reference: firstRequest.approval_id,
    })
    assert.deepEqual(sent, [action])
    assert.deepEqual(
      await second.claimExternalAction({
        missionId,
        channel: 'email',
        idempotencyKey: action.idempotency_key,
        actionHash: hashAction(action),
      }),
      {
        status: 'completed',
        receipt_id: 'receipt-db-0221',
        approval_id: firstRequest.approval_id,
      },
    )
  })

  it('checks channel, mission and global kill switches before each unique claim', async () => {
    const mission = missionRecord(
      '123e4567-e89b-42d3-a456-426614174301',
      'mission-db-0301',
    )
    await first.saveMission(mission)
    const scopes: Array<[string, string]> = [
      ['channel', 'email'],
      ['mission', mission.mission_id],
      ['global', '*'],
    ]

    for (const [index, [scope, scopeId]] of scopes.entries()) {
      await first.activateKillSwitch(scope, scopeId)
      await assert.rejects(
        second.claimExternalAction({
          missionId: mission.mission_id,
          channel: 'email',
          idempotencyKey: `mail-kill-${index}`,
          actionHash: `${index}`.repeat(64),
        }),
        /KILL_SWITCH_ACTIVE/,
      )
      await firstPool.query(
        'UPDATE control.kill_switches SET active = FALSE WHERE scope = $1 AND scope_id = $2',
        [scope, scopeId],
      )
    }
  })

  it('deduplicates webhook events concurrently by mailbox and provider event ID', async () => {
    const event = {
      mailbox_key: 'contacto',
      provider_event_id: 'evt-db-0001',
      received_at: NOW,
      trust_classification: 'untrusted_external' as const,
      instruction_eligible: false as const,
      untrusted_payload: { subject: 'external data' },
    }
    const inserted = await Promise.all([
      first.storeWebhookEvent(event),
      second.storeWebhookEvent(event),
    ])

    assert.deepEqual(inserted.sort(), [false, true])
  })

  it('stores audit events durably and rejects mutation or deletion', async () => {
    const sink = new PostgresAuditSink(firstPool)
    const event = auditEvent()
    await sink.record(event)

    const stored = await secondPool.query<{ event: StructuredAuditEvent }>(
      'SELECT event FROM control.audit_events',
    )
    assert.deepEqual(stored.rows.at(-1)?.event, event)
    await assert.rejects(
      secondPool.query('UPDATE control.audit_events SET event = $1::jsonb', [
        JSON.stringify({}),
      ]),
      /AUDIT_EVENTS_APPEND_ONLY/,
    )
    await assert.rejects(
      secondPool.query('DELETE FROM control.audit_events'),
      /AUDIT_EVENTS_APPEND_ONLY/,
    )
  })
})

function missionRecord(
  missionId: string,
  idempotencyKey: string,
): MissionRecord {
  return {
    ...validWorkOrder(),
    mission_id: missionId,
    idempotency_key: idempotencyKey,
    autonomy_level: 'A3',
    a3_enabled: true,
    objective: 'durable runtime test',
  }
}

function approvalAction(missionId: string): ApprovalAction {
  return {
    mission_id: missionId,
    project_id: 'proptimiza',
    project_version: 'v1',
    action_type: 'mail.send',
    channel: 'email',
    sender: 'ventas@proptimiza.com',
    recipients: ['contacto@proptimiza.com'],
    subject: 'Prueba durable',
    content: 'Contenido durable',
    content_version: 'mail-v1',
    volume: 1,
    offer_version: 'offer-v1',
    policy_version: 'policy-v1',
    idempotency_key: 'mail-db-approval',
  }
}

function approvalRequest(
  approvalId: string,
  missionId: string,
): ApprovalRequestRecord {
  return {
    approval_id: approvalId,
    action: approvalAction(missionId),
    action_hash: 'a'.repeat(64),
    requested_at: '2026-08-15T19:55:00.000Z',
    status: 'pending',
  }
}

function approvalGrant(request: ApprovalRequestRecord): ApprovalGrantRecord {
  return {
    ...request,
    status: 'approved',
    approved_by: 'human-director',
    expires_at: LATER,
    nonce: '00112233445566778899aabbccddeeff',
    token: `APPROVAL::${request.action.mission_id}::${request.action_hash}::${LATER}::00112233445566778899aabbccddeeff::${'b'.repeat(64)}`,
    consumed_at: null,
  }
}

function auditEvent(): StructuredAuditEvent {
  return {
    mission_id: null,
    agent_id: 'commercial-broker',
    tool_action: 'mission.get',
    started_at: NOW,
    completed_at: NOW,
    duration_ms: 0,
    token_cost: {
      input_tokens: 0,
      output_tokens: 0,
      currency: 'USD',
      amount: 0,
    },
    redacted_input: `sha256:${'c'.repeat(64)}`,
    result: 'status:200',
    error: null,
    retries: 0,
    external_action: false,
    approval_reference: null,
    receipt_reference: null,
    evidence: [],
    state_changes: ['mission.get'],
    deployed_version: 'test',
  }
}
