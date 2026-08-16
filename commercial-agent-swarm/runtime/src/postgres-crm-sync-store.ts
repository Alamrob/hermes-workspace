import type {
  CrmInboxEvent,
  CrmOutboxItem,
  CrmStream,
  CrmSyncStorePort,
} from './crm-sync.js'

interface QueryPort {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export class PostgresCrmSyncStore implements CrmSyncStorePort {
  constructor(private readonly database: QueryPort) {}

  async claim(
    workerId: string,
    leaseSeconds: number,
  ): Promise<CrmOutboxItem | null> {
    const result = await this.database.query(
      `SELECT * FROM integration.claim_crm_outbox($1,$2)`,
      [workerId, leaseSeconds],
    )
    const row = result.rows.at(0) as
      | {
          outbox_id: string
          connector_id: 'twenty'
          operation: CrmOutboxItem['operation']
          payload: Record<string, unknown>
          source_version: string | number
        }
      | undefined
    if (!row) return null
    return {
      outboxId: row.outbox_id,
      connectorId: row.connector_id,
      operation: row.operation,
      payload: row.payload,
      sourceVersion: Number(row.source_version),
    }
  }

  async complete(
    outboxId: string,
    workerId: string,
    remoteRecordId: string,
    remoteVersion: string,
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT integration.complete_crm_outbox($1,$2,$3,$4) AS completed`,
      [outboxId, workerId, remoteRecordId, remoteVersion],
    )
    if (
      (result.rows.at(0) as { completed?: boolean } | undefined)?.completed !==
      true
    )
      throw new Error('CRM_OUTBOX_COMPLETION_CONFLICT')
  }

  async markOutcomeUnknown(
    outboxId: string,
    workerId: string,
    errorCode: 'TWENTY_OUTCOME_UNKNOWN',
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT integration.mark_crm_outbox_outcome_unknown($1,$2,$3) AS recorded`,
      [outboxId, workerId, errorCode],
    )
    if (
      (result.rows.at(0) as { recorded?: boolean } | undefined)?.recorded !==
      true
    )
      throw new Error('CRM_OUTBOX_OUTCOME_CONFLICT')
  }

  async storeInbox(event: CrmInboxEvent): Promise<boolean> {
    const result = await this.database.query(
      `SELECT integration.store_crm_inbox('twenty',$1,$2,$3,$4,$5) AS inserted`,
      [
        event.remoteEventId,
        event.recordType,
        event.remoteRecordId,
        event.remoteVersion,
        event.payload,
      ],
    )
    return (
      (result.rows.at(0) as { inserted?: boolean } | undefined)?.inserted ===
      true
    )
  }

  async advanceCursor(
    connectorId: 'twenty',
    stream: CrmStream,
    expectedVersion: number,
    nextCursor: string,
  ): Promise<number> {
    const result = await this.database.query(
      `SELECT integration.advance_crm_cursor($1,$2,$3,$4) AS version`,
      [connectorId, stream, expectedVersion, nextCursor],
    )
    const version = Number(
      (result.rows.at(0) as { version?: string | number } | undefined)?.version,
    )
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('CRM_CURSOR_RESULT_INVALID')
    return version
  }

  async ready(): Promise<boolean> {
    const result = await this.database.query(
      `SELECT integration.crm_sync_ready() AS ready`,
    )
    return (
      (result.rows.at(0) as { ready?: boolean } | undefined)?.ready === true
    )
  }

  async getCursor(
    connectorId: 'twenty',
    stream: CrmStream,
  ): Promise<{ value: string | null; version: number }> {
    const result = await this.database.query(
      `SELECT cursor_value,cursor_version
       FROM integration.get_crm_cursor($1,$2)`,
      [connectorId, stream],
    )
    const row = result.rows.at(0) as
      | { cursor_value?: unknown; cursor_version?: unknown }
      | undefined
    if (!row) return { value: null, version: 0 }
    const version = Number(row.cursor_version)
    if (
      typeof row.cursor_value !== 'string' ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      throw new Error('CRM_CURSOR_RESULT_INVALID')
    return { value: row.cursor_value, version }
  }

  async listOutcomeUnknown(
    limit: number,
  ): Promise<Array<{
    outboxId: string
    errorCode: 'TWENTY_OUTCOME_UNKNOWN'
  }>> {
    const result = await this.database.query(
      `SELECT outbox_id,error_code
       FROM integration.list_crm_outcome_unknown($1)`,
      [limit],
    )
    return result.rows.map((candidate) => {
      const row = candidate as { outbox_id?: unknown; error_code?: unknown }
      if (
        typeof row.outbox_id !== 'string' ||
        row.error_code !== 'TWENTY_OUTCOME_UNKNOWN'
      )
        throw new Error('CRM_RECONCILIATION_RESULT_INVALID')
      return { outboxId: row.outbox_id, errorCode: row.error_code }
    })
  }
}
