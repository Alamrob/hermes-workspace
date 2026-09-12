import type { QueryConfig, QueryResult, QueryResultRow } from 'pg'
import type {
  A0BehaviorLedgerPort,
  A0ReserveResult,
  A0SettlementLookupResult,
} from './a0-behavior-batch-admission.js'

export interface A0BehaviorLedgerDatabasePort {
  query<T extends QueryResultRow>(config: QueryConfig): Promise<QueryResult<T>>
}

export interface PostgresA0BehaviorLedgerOptions {
  database: A0BehaviorLedgerDatabasePort
  expectedPrincipal: string
}

const CAPABILITY_ROLE = 'commercial_a0_behavior_ledger'
const EXPECTED_LOGIN = 'proptimiza_a0_behavior_ledger_login'
const capabilityFunctions = [
  'control.acquire_a0_behavior_execution_permit(uuid,text,bigint)',
  'control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text)',
  'control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,text)',
  'control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz)',
  'control.settle_a0_behavior_batch(uuid,text,bigint,bigint,text)',
] as const
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/

export class PostgresA0BehaviorLedgerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PostgresA0BehaviorLedgerError'
  }
}

/**
 * Function-only PostgreSQL capability for A0 reservations and accounting.
 * It owns no connection string, credential, generic SQL, runner, or retry API.
 */
export class PostgresA0BehaviorLedger implements A0BehaviorLedgerPort {
  private readonly query: A0BehaviorLedgerDatabasePort['query']
  private readonly expectedPrincipal: string

  constructor(options: PostgresA0BehaviorLedgerOptions) {
    if (
      !options.database ||
      typeof options.database.query !== 'function' ||
      options.expectedPrincipal !== EXPECTED_LOGIN
    )
      throw new PostgresA0BehaviorLedgerError('A0_LEDGER_CONFIGURATION_INVALID')
    this.query = options.database.query.bind(options.database)
    this.expectedPrincipal = options.expectedPrincipal
  }

  async ready(): Promise<void> {
    const row = await this.one<{
      current_user: unknown
      rolcanlogin: unknown
      rolinherit: unknown
      unsafe: unknown
      memberships: unknown
      unexpected_functions: unknown
      missing_functions: unknown
      unsafe_effective: unknown
    }>(
      `SELECT current_user,r.rolcanlogin,r.rolinherit,
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS unsafe,
        ARRAY(SELECT parent.rolname::text FROM pg_roles parent
          WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'MEMBER')
          ORDER BY parent.rolname)::text[] AS memberships,
        ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname=ANY(ARRAY['catalog','control','mail','integration'])
            AND has_function_privilege(current_user,p.oid,'EXECUTE')
            AND p.oid<>ALL(ARRAY(SELECT to_regprocedure(expected.name)::oid
              FROM unnest($1::text[]) AS expected(name)))
          ORDER BY p.oid::regprocedure::text) AS unexpected_functions,
        ARRAY(SELECT expected.name FROM unnest($1::text[]) AS expected(name)
          WHERE to_regprocedure(expected.name) IS NULL
            OR NOT coalesce(has_function_privilege(
              current_user,to_regprocedure(expected.name),'EXECUTE'),false)
          ORDER BY expected.name) AS missing_functions,
        (
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=ANY(ARRAY['catalog','control','mail','integration'])
              AND c.relkind IN('r','p','v','m','f')
              AND (has_table_privilege(current_user,c.oid,'SELECT')
                OR has_table_privilege(current_user,c.oid,'INSERT')
                OR has_table_privilege(current_user,c.oid,'UPDATE')
                OR has_table_privilege(current_user,c.oid,'DELETE')
                OR has_table_privilege(current_user,c.oid,'TRUNCATE')
                OR has_table_privilege(current_user,c.oid,'REFERENCES')
                OR has_table_privilege(current_user,c.oid,'TRIGGER')))
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=ANY(ARRAY['catalog','control','mail','integration'])
              AND c.relkind='S' AND (has_sequence_privilege(current_user,c.oid,'SELECT')
                OR has_sequence_privilege(current_user,c.oid,'USAGE')
                OR has_sequence_privilege(current_user,c.oid,'UPDATE')))
          OR EXISTS(SELECT 1 FROM pg_namespace n
            WHERE n.nspname=ANY(ARRAY['catalog','control','mail','integration'])
              AND has_schema_privilege(current_user,n.oid,'CREATE'))
          OR has_database_privilege(current_user,current_database(),'CREATE')
          OR has_database_privilege(current_user,current_database(),'TEMP')
          OR EXISTS(SELECT 1 FROM pg_auth_members membership
            WHERE membership.member=r.oid AND membership.admin_option)
          OR EXISTS(SELECT 1 FROM pg_roles parent
            WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'MEMBER')
              AND (parent.rolsuper OR parent.rolcreatedb OR parent.rolcreaterole
                OR parent.rolreplication OR parent.rolbypassrls))
        ) AS unsafe_effective
      FROM pg_roles r WHERE r.rolname=current_user`,
      [capabilityFunctions],
      'A0_LEDGER_PRINCIPAL_UNVERIFIED',
    )
    if (
      row.current_user !== this.expectedPrincipal ||
      row.rolcanlogin !== true ||
      row.rolinherit !== true ||
      row.unsafe !== false ||
      row.unsafe_effective !== false ||
      !sameStrings(row.memberships, [CAPABILITY_ROLE]) ||
      !sameStrings(row.unexpected_functions, []) ||
      !sameStrings(row.missing_functions, [])
    )
      throw new PostgresA0BehaviorLedgerError('A0_LEDGER_PRINCIPAL_UNVERIFIED')
  }

  async reserve(input: Parameters<A0BehaviorLedgerPort['reserve']>[0]) {
    validateReservation(input)
    const row = await this.one<{ value: unknown }>(
      `SELECT control.reserve_a0_behavior_batch(
        $1::text,$2::uuid,$3::text,$4::text,$5::bigint,$6::timestamptz) AS value`,
      [
        input.idempotency_key,
        input.run_id,
        input.batch_id,
        input.batch_sha256,
        input.reservation_micro_cents,
        input.expires_at,
      ],
      'A0_LEDGER_RESERVATION_UNCONFIRMED',
    )
    return validateReserveResult(row.value)
  }

  async acquireExecutionPermit(
    input: Parameters<A0BehaviorLedgerPort['acquireExecutionPermit']>[0],
  ) {
    validatePermit(input)
    const row = await this.one<{ granted: unknown }>(
      `SELECT control.acquire_a0_behavior_execution_permit(
        $1::uuid,$2::text,$3::bigint) AS granted`,
      [input.run_id, input.batch_id, input.reservation_version],
      'A0_LEDGER_EXECUTION_PERMIT_UNCONFIRMED',
    )
    if (typeof row.granted !== 'boolean')
      throw new PostgresA0BehaviorLedgerError(
        'A0_LEDGER_EXECUTION_PERMIT_UNCONFIRMED',
      )
    return row.granted
  }

  async settle(input: Parameters<A0BehaviorLedgerPort['settle']>[0]) {
    validateSettlement(input)
    const row = await this.one<{ applied: unknown }>(
      `SELECT control.settle_a0_behavior_batch(
        $1::uuid,$2::text,$3::bigint,$4::bigint,$5::text) AS applied`,
      [
        input.run_id,
        input.batch_id,
        input.reservation_version,
        input.usage_value_micro_cents,
        input.usage_record_id,
      ],
      'A0_LEDGER_SETTLEMENT_UNCONFIRMED',
    )
    if (typeof row.applied !== 'boolean')
      throw new PostgresA0BehaviorLedgerError(
        'A0_LEDGER_SETTLEMENT_UNCONFIRMED',
      )
    return row.applied
  }

  async getSettlement(
    input: Parameters<A0BehaviorLedgerPort['getSettlement']>[0],
  ) {
    validateSettlement(input)
    const row = await this.one<{ value: unknown }>(
      `SELECT control.get_a0_behavior_batch_settlement(
        $1::uuid,$2::text,$3::bigint,$4::bigint,$5::text) AS value`,
      [
        input.run_id,
        input.batch_id,
        input.reservation_version,
        input.usage_value_micro_cents,
        input.usage_record_id,
      ],
      'A0_LEDGER_RECONCILIATION_UNCONFIRMED',
    )
    return validateSettlementLookupResult(row.value)
  }

  async holdUnknown(input: Parameters<A0BehaviorLedgerPort['holdUnknown']>[0]) {
    validateHold(input)
    const row = await this.one<{ applied: unknown }>(
      `SELECT control.hold_a0_behavior_batch_unknown(
        $1::uuid,$2::text,$3::bigint,$4::text) AS applied`,
      [input.run_id, input.batch_id, input.reservation_version, input.reason],
      'A0_LEDGER_HOLD_UNCONFIRMED',
    )
    if (typeof row.applied !== 'boolean')
      throw new PostgresA0BehaviorLedgerError('A0_LEDGER_HOLD_UNCONFIRMED')
    return row.applied
  }

  private async one<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[],
    code: string,
  ): Promise<T> {
    try {
      const result = await this.query<T>({
        text,
        values: [...values],
        query_timeout: 1_500,
      } as QueryConfig)
      if (result.rowCount !== 1 || !result.rows[0]) throw new Error('ROW_COUNT')
      return result.rows[0]
    } catch {
      throw new PostgresA0BehaviorLedgerError(code)
    }
  }
}

function validateReservation(
  input: Parameters<A0BehaviorLedgerPort['reserve']>[0],
): void {
  if (
    !UUID.test(input.run_id) ||
    !validBatchId(input.run_id, input.batch_id) ||
    !SHA256.test(input.batch_sha256) ||
    input.idempotency_key !==
      `a0:${input.idempotency_key.split(':')[1]}:${input.batch_sha256}` ||
    !/^a0:[a-f0-9]{64}:[a-f0-9]{64}$/.test(input.idempotency_key) ||
    input.reservation_micro_cents !== 6_000_000 ||
    !canonicalIso(input.expires_at)
  )
    throw new PostgresA0BehaviorLedgerError(
      'A0_LEDGER_RESERVATION_INPUT_INVALID',
    )
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  )
}

function validateSettlement(
  input: Parameters<A0BehaviorLedgerPort['settle']>[0],
): void {
  if (
    !UUID.test(input.run_id) ||
    !validBatchId(input.run_id, input.batch_id) ||
    input.reservation_version !== 1 ||
    !Number.isSafeInteger(input.usage_value_micro_cents) ||
    input.usage_value_micro_cents < 1 ||
    !SAFE_ID.test(input.usage_record_id)
  )
    throw new PostgresA0BehaviorLedgerError(
      'A0_LEDGER_SETTLEMENT_INPUT_INVALID',
    )
}

function validatePermit(
  input: Parameters<A0BehaviorLedgerPort['acquireExecutionPermit']>[0],
): void {
  if (
    !UUID.test(input.run_id) ||
    !validBatchId(input.run_id, input.batch_id) ||
    input.reservation_version !== 1
  )
    throw new PostgresA0BehaviorLedgerError(
      'A0_LEDGER_EXECUTION_PERMIT_INPUT_INVALID',
    )
}

function validateHold(
  input: Parameters<A0BehaviorLedgerPort['holdUnknown']>[0],
): void {
  if (
    !UUID.test(input.run_id) ||
    !validBatchId(input.run_id, input.batch_id) ||
    input.reservation_version !== 1 ||
    input.reason !== 'A0_USAGE_UNKNOWN'
  )
    throw new PostgresA0BehaviorLedgerError('A0_LEDGER_HOLD_INPUT_INVALID')
}

function validBatchId(runId: string, batchId: string): boolean {
  return new RegExp(
    `^a0:${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:t(?:0[1-9]|1[0-6])$`,
    'i',
  ).test(batchId)
}

function validateReserveResult(value: unknown): A0ReserveResult {
  const result = record(value, 'A0_LEDGER_RESULT_INVALID')
  if (result.disposition === 'denied') {
    exactKeys(result, ['disposition', 'reason'], 'A0_LEDGER_RESULT_INVALID')
    if (typeof result.reason !== 'string' || !SAFE_ID.test(result.reason))
      throw new PostgresA0BehaviorLedgerError('A0_LEDGER_RESULT_INVALID')
    return result as unknown as A0ReserveResult
  }
  exactKeys(
    result,
    ['disposition', 'state', 'version'],
    'A0_LEDGER_RESULT_INVALID',
  )
  if (!Number.isSafeInteger(result.version) || Number(result.version) < 1)
    throw new PostgresA0BehaviorLedgerError('A0_LEDGER_RESULT_INVALID')
  if (result.disposition === 'created' && result.state === 'reserved')
    return result as unknown as A0ReserveResult
  if (
    result.disposition === 'replayed' &&
    ['reserved', 'settled', 'budget_exceeded', 'held_unknown'].includes(
      String(result.state),
    )
  )
    return result as unknown as A0ReserveResult
  throw new PostgresA0BehaviorLedgerError('A0_LEDGER_RESULT_INVALID')
}

function validateSettlementLookupResult(
  value: unknown,
): A0SettlementLookupResult {
  const result = record(value, 'A0_LEDGER_RECONCILIATION_INVALID')
  if (result.status === 'unconfirmed') {
    exactKeys(result, ['status'], 'A0_LEDGER_RECONCILIATION_INVALID')
    return { status: 'unconfirmed' }
  }
  exactKeys(
    result,
    ['status', 'state', 'version'],
    'A0_LEDGER_RECONCILIATION_INVALID',
  )
  if (
    result.status !== 'confirmed' ||
    !['settled', 'budget_exceeded'].includes(String(result.state)) ||
    !Number.isSafeInteger(result.version) ||
    ![2, 3].includes(Number(result.version))
  )
    throw new PostgresA0BehaviorLedgerError(
      'A0_LEDGER_RECONCILIATION_INVALID',
    )
  return result as unknown as A0SettlementLookupResult
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PostgresA0BehaviorLedgerError(code)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    throw new PostgresA0BehaviorLedgerError(code)
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  )
}
