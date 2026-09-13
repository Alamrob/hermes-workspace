import type { QueryConfig, QueryResult, QueryResultRow } from 'pg'
import type {
  A0BehaviorLedgerPort,
  A0ReserveResult,
  A0SettlementLookupResult,
  A0TaskExecutionContract,
} from './a0-behavior-batch-admission.js'
import {
  validateExecutionPermit,
  type ExecutionPermit,
} from './execution-lease.js'

export interface A0BehaviorLedgerDatabasePort {
  query<T extends QueryResultRow>(config: QueryConfig): Promise<QueryResult<T>>
}

export interface PostgresA0BehaviorLedgerOptions {
  database: A0BehaviorLedgerDatabasePort
  expectedPrincipal: string
}

const CAPABILITY_ROLE = 'commercial_a0_behavior_ledger'
const EXPECTED_LOGIN = 'proptimiza_a0_behavior_ledger_login'
const EXPECTED_DATABASE = 'proptimiza_commercial_authority'
const EXPECTED_DATABASE_OWNER = 'proptimiza_commercial_authority_owner'
const capabilityFunctions = [
  'control.acquire_a0_behavior_execution_permit(uuid,text,bigint)',
  'control.get_a0_behavior_task_execution_permit(uuid,text,bigint,uuid,text,text)',
  'control.get_a0_behavior_usage_budget_state(uuid,text,bigint)',
  'control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text)',
  'control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,jsonb)',
  'control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz,jsonb)',
  'control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)',
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
      database_name: unknown
      database_owner: unknown
      can_connect: unknown
      database_is_template: unknown
      database_allows_connections: unknown
      rolcanlogin: unknown
      rolinherit: unknown
      unsafe: unknown
      memberships: unknown
      unexpected_functions: unknown
      missing_functions: unknown
      unsafe_effective: unknown
    }>(
      `SELECT current_user,current_database()::text AS database_name,
        pg_get_userbyid(d.datdba)::text AS database_owner,
        has_database_privilege(current_user,d.oid,'CONNECT') AS can_connect,
        d.datistemplate AS database_is_template,d.datallowconn AS database_allows_connections,
        r.rolcanlogin,r.rolinherit,
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS unsafe,
        ARRAY(SELECT parent.rolname::text FROM pg_roles parent
          WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'MEMBER')
          ORDER BY parent.rolname)::text[] AS memberships,
        ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname=ANY(ARRAY['public','catalog','control','mail','integration'])
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
            WHERE n.nspname=ANY(ARRAY['public','catalog','control','mail','integration'])
              AND c.relkind IN('r','p','v','m','f')
              AND (has_table_privilege(current_user,c.oid,'SELECT')
                OR has_table_privilege(current_user,c.oid,'INSERT')
                OR has_table_privilege(current_user,c.oid,'UPDATE')
                OR has_table_privilege(current_user,c.oid,'DELETE')
                OR has_table_privilege(current_user,c.oid,'TRUNCATE')
                OR has_table_privilege(current_user,c.oid,'REFERENCES')
                OR has_table_privilege(current_user,c.oid,'TRIGGER')))
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=ANY(ARRAY['public','catalog','control','mail','integration'])
              AND c.relkind='S' AND (has_sequence_privilege(current_user,c.oid,'SELECT')
                OR has_sequence_privilege(current_user,c.oid,'USAGE')
                OR has_sequence_privilege(current_user,c.oid,'UPDATE')))
          OR EXISTS(SELECT 1 FROM pg_namespace n
            WHERE n.nspname=ANY(ARRAY['public','catalog','control','mail','integration'])
              AND has_schema_privilege(current_user,n.oid,'CREATE'))
          OR has_database_privilege(current_user,current_database(),'CREATE')
          OR has_database_privilege(current_user,current_database(),'TEMP')
          OR EXISTS(SELECT 1 FROM pg_database owned WHERE owned.datdba=r.oid)
          OR EXISTS(SELECT 1 FROM pg_namespace owned WHERE owned.nspowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_class owned WHERE owned.relowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_proc owned WHERE owned.proowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_auth_members membership
            WHERE membership.member=r.oid AND membership.admin_option)
          OR EXISTS(SELECT 1 FROM pg_roles parent
            WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'MEMBER')
              AND (parent.rolsuper OR parent.rolcreatedb OR parent.rolcreaterole
                OR parent.rolreplication OR parent.rolbypassrls))
        ) AS unsafe_effective
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user`,
      [capabilityFunctions],
      'A0_LEDGER_PRINCIPAL_UNVERIFIED',
    )
    if (
      row.current_user !== this.expectedPrincipal ||
      row.database_name !== EXPECTED_DATABASE ||
      row.database_owner !== EXPECTED_DATABASE_OWNER ||
      row.can_connect !== true ||
      row.database_is_template !== false ||
      row.database_allows_connections !== true ||
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
        $1::text,$2::uuid,$3::text,$4::text,$5::bigint,$6::timestamptz,
        $7::jsonb) AS value`,
      [
        input.idempotency_key,
        input.run_id,
        input.batch_id,
        input.batch_sha256,
        input.reservation_micro_cents,
        input.expires_at,
        JSON.stringify(input.task_contract),
      ],
      'A0_LEDGER_RESERVATION_UNCONFIRMED',
    )
    return validateReserveResult(row.value)
  }

  async readTaskExecutionPermit(input: {
    run_id: string
    batch_id: string
    reservation_version: number
    task_id: string
    profile_id: string
    worker_id: string
  }): Promise<ExecutionPermit> {
    validateTaskPermit(input)
    const row = await this.one<{ value: unknown }>(
      `SELECT control.get_a0_behavior_task_execution_permit(
        $1::uuid,$2::text,$3::bigint,$4::uuid,$5::text,$6::text) AS value`,
      [
        input.run_id,
        input.batch_id,
        input.reservation_version,
        input.task_id,
        input.profile_id,
        input.worker_id,
      ],
      'A0_LEDGER_TASK_PERMIT_UNCONFIRMED',
    )
    let permit: ExecutionPermit
    try {
      permit = validateExecutionPermit(row.value)
    } catch {
      throw new PostgresA0BehaviorLedgerError(
        'A0_LEDGER_TASK_PERMIT_UNCONFIRMED',
      )
    }
    if (
      permit.job_id !== input.task_id ||
      permit.mission_id !== input.run_id ||
      permit.worker_id !== input.worker_id ||
      permit.budget_version !== input.reservation_version
    )
      throw new PostgresA0BehaviorLedgerError(
        'A0_LEDGER_TASK_PERMIT_UNCONFIRMED',
      )
    return permit
  }

  async readUsageBudgetState(input: {
    run_id: string
    batch_id: string
    reservation_version: number
  }): Promise<{
    total_committed_excluding_batch_micro_cents: number
  }> {
    validatePermit(input)
    const row = await this.one<{ value: unknown }>(
      `SELECT control.get_a0_behavior_usage_budget_state(
        $1::uuid,$2::text,$3::bigint) AS value`,
      [input.run_id, input.batch_id, input.reservation_version],
      'A0_LEDGER_USAGE_BUDGET_STATE_UNCONFIRMED',
    )
    const value = row.value
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value as Record<string, unknown>).length !== 1
    )
      throw new PostgresA0BehaviorLedgerError(
        'A0_LEDGER_USAGE_BUDGET_STATE_UNCONFIRMED',
      )
    const total = (value as Record<string, unknown>)
      .total_committed_excluding_batch_micro_cents
    if (!Number.isSafeInteger(total) || Number(total) < 0)
      throw new PostgresA0BehaviorLedgerError(
        'A0_LEDGER_USAGE_BUDGET_STATE_UNCONFIRMED',
      )
    return { total_committed_excluding_batch_micro_cents: Number(total) }
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
    const usageRecords = canonicalUsageRecords(input.usage_records)
    const row = await this.one<{ applied: unknown }>(
      `SELECT control.settle_a0_behavior_batch(
        $1::uuid,$2::text,$3::bigint,$4::bigint,$5::jsonb) AS applied`,
      [
        input.run_id,
        input.batch_id,
        input.reservation_version,
        input.usage_value_micro_cents,
        JSON.stringify(usageRecords),
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
    const usageRecords = canonicalUsageRecords(input.usage_records)
    const row = await this.one<{ value: unknown }>(
      `SELECT control.get_a0_behavior_batch_settlement(
        $1::uuid,$2::text,$3::bigint,$4::bigint,$5::jsonb) AS value`,
      [
        input.run_id,
        input.batch_id,
        input.reservation_version,
        input.usage_value_micro_cents,
        JSON.stringify(usageRecords),
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
    !canonicalIso(input.expires_at) ||
    !validTaskContract(input.task_contract)
  )
    throw new PostgresA0BehaviorLedgerError(
      'A0_LEDGER_RESERVATION_INPUT_INVALID',
    )
}

function validTaskContract(value: unknown): value is A0TaskExecutionContract[] {
  if (!Array.isArray(value) || value.length !== 6 || Object.keys(value).length !== 6)
    return false
  const ids = new Set<string>()
  const profiles = [
    'sales-orchestrator',
    'market-account-intelligence',
    'contact-data-steward',
    'qualification-prioritization',
    'outreach-draft-manager',
    'commercial-qa-compliance',
  ]
  return value.every((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const row = item as Record<string, unknown>
    if (
      Object.keys(row).sort().join(',') !==
        'agent_id,fixture_id,fixture_sha256,maximum_model_calls,maximum_tokens,reservation_micro_cents,sequence,task_id' ||
      row.sequence !== index + 1 ||
      !UUID.test(String(row.task_id)) ||
      ids.has(String(row.task_id)) ||
      !UUID.test(String(row.fixture_id)) ||
      row.agent_id !== profiles[index] ||
      !SHA256.test(String(row.fixture_sha256)) ||
      row.maximum_tokens !== 4096 ||
      row.maximum_model_calls !== 1 ||
      row.reservation_micro_cents !== 1_000_000
    )
      return false
    ids.add(String(row.task_id))
    return true
  })
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
    !validUsageRecords(input.usage_records, input.usage_value_micro_cents)
  )
    throw new PostgresA0BehaviorLedgerError(
      'A0_LEDGER_SETTLEMENT_INPUT_INVALID',
    )
}

function validUsageRecords(value: unknown, expectedTotal: number): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    Object.keys(value).length !== 6
  )
    return false
  const ids = new Set<string>()
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (
      keys.length !== 2 ||
      keys[0] !== 'usage_record_id' ||
      keys[1] !== 'usage_value_micro_cents' ||
      typeof record.usage_record_id !== 'string' ||
      !SAFE_ID.test(record.usage_record_id) ||
      ids.has(record.usage_record_id) ||
      !Number.isSafeInteger(record.usage_value_micro_cents) ||
      Number(record.usage_value_micro_cents) < 1
    )
      return false
    ids.add(record.usage_record_id)
    total += Number(record.usage_value_micro_cents)
    if (!Number.isSafeInteger(total)) return false
  }
  return total === expectedTotal
}

function canonicalUsageRecords(
  records: Parameters<A0BehaviorLedgerPort['settle']>[0]['usage_records'],
): Array<{ usage_record_id: string; usage_value_micro_cents: number }> {
  return records
    .map((record) => ({
      usage_record_id: record.usage_record_id,
      usage_value_micro_cents: record.usage_value_micro_cents,
    }))
    .sort((left, right) =>
      left.usage_record_id.localeCompare(right.usage_record_id, 'en'),
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

function validateTaskPermit(input: {
  run_id: string
  batch_id: string
  reservation_version: number
  task_id: string
  profile_id: string
  worker_id: string
}): void {
  validatePermit(input)
  if (
    !UUID.test(input.task_id) ||
    ![
      'sales-orchestrator',
      'market-account-intelligence',
      'contact-data-steward',
      'qualification-prioritization',
      'outreach-draft-manager',
      'commercial-qa-compliance',
    ].includes(input.profile_id) ||
    input.worker_id !== 'a0-manual-runner-1'
  )
    throw new PostgresA0BehaviorLedgerError(
      'A0_LEDGER_TASK_PERMIT_INPUT_INVALID',
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
