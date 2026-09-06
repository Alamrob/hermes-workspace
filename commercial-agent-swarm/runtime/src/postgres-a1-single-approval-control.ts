import type { QueryConfig, QueryResult, QueryResultRow } from 'pg'
import type {
  A1SingleApprovalControlCapability,
} from './a1-single-approval-broker-application-port.js'
import type {
  A1SingleApprovalBrokerDispatchInput,
  A1SingleApprovalBrokerParentInput,
  A1SingleApprovalBrokerRecontainInput,
} from './a1-single-approval-broker-adapter.js'
import type { A1SingleApprovalControlState } from './a1-single-approval-coordinator.js'

interface QueryPort {
  query<T extends QueryResultRow>(config: QueryConfig): Promise<QueryResult<T>>
}

export interface A1SingleApprovalTimerAttestation {
  inspect(): Promise<unknown>
}

export interface A1SingleApprovalManualDispatcher {
  runOnce(): Promise<unknown>
}

interface Options {
  database: QueryPort
  expectedPrincipal: string
  timer: A1SingleApprovalTimerAttestation
  dispatcher: A1SingleApprovalManualDispatcher
}

const capabilityFunctions = [
  'control.consume_a1_single_approval_parent(jsonb)',
  'control.get_a1_single_approval_chain_state(uuid)',
  'control.recontain_a1_single_approval_chain(uuid,text)',
] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digest = /^[0-9a-f]{64}$/

export class PostgresA1SingleApprovalControlError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PostgresA1SingleApprovalControlError'
  }
}

/**
 * Function-only PostgreSQL capability for the deterministic single-approval
 * A1 chain. It owns no scheduler, generic SQL, URL, credential, or retry API.
 */
export class PostgresA1SingleApprovalControlCapability
implements A1SingleApprovalControlCapability {
  constructor(private readonly options: Options) {
    if (
      !options.database || typeof options.database.query !== 'function' ||
      !options.timer || typeof options.timer.inspect !== 'function' ||
      !options.dispatcher || typeof options.dispatcher.runOnce !== 'function' ||
      !/^[a-z][a-z0-9_]{2,62}$/.test(options.expectedPrincipal) ||
      options.expectedPrincipal === 'commercial_a1_chain_runner'
    ) throw new PostgresA1SingleApprovalControlError('A1_CONTROL_CONFIGURATION_INVALID')
  }

  async ready(): Promise<void> {
    const row = await this.one<{
      current_user: unknown
      rolcanlogin: unknown
      unsafe: unknown
      memberships: unknown
      unexpected_functions: unknown
      missing_functions: unknown
      unsafe_effective: unknown
    }>(
      `SELECT current_user,r.rolcanlogin,
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
      'A1_CONTROL_PRINCIPAL_UNVERIFIED',
    )
    if (
      row.current_user !== this.options.expectedPrincipal || row.rolcanlogin !== true ||
      row.unsafe !== false || row.unsafe_effective !== false ||
      !sameStrings(row.memberships, ['commercial_a1_chain_runner']) ||
      !sameStrings(row.unexpected_functions, []) || !sameStrings(row.missing_functions, [])
    ) throw new PostgresA1SingleApprovalControlError('A1_CONTROL_PRINCIPAL_UNVERIFIED')
  }

  async inspect(missionId: string): Promise<A1SingleApprovalControlState> {
    requireUuid(missionId, 'A1_CONTROL_MISSION_INVALID')
    const row = await this.one<{ value: unknown }>(
      `SELECT control.get_a1_single_approval_chain_state($1::uuid) AS value`,
      [missionId],
      'A1_CONTROL_INSPECTION_FAILED',
    )
    const databaseState = record(row.value, 'A1_CONTROL_STATE_INVALID')
    exactKeys(databaseState, [
      'mission_id', 'channel_kills', 'external_actions_blocked', 'external_actions',
      'crm_writes', 'crm_outbox', 'global_kill', 'execution_window_open',
      'dispatch_claiming_permitted', 'active_or_uncertain_jobs',
      'parent_authorization_consumed', 'completed_jobs', 'usage_value_consumed_usd',
    ], 'A1_CONTROL_STATE_INVALID')
    let timerValue: unknown
    try {
      timerValue = await this.options.timer.inspect()
    } catch {
      throw new PostgresA1SingleApprovalControlError('A1_CONTROL_TIMER_UNVERIFIED')
    }
    const timer = record(timerValue, 'A1_CONTROL_TIMER_UNVERIFIED')
    exactKeys(timer, ['enabled', 'active'], 'A1_CONTROL_TIMER_UNVERIFIED')
    if (timer.enabled !== false || timer.active !== false)
      throw new PostgresA1SingleApprovalControlError('A1_CONTROL_TIMER_UNVERIFIED')
    const state = { ...databaseState, timer_enabled: false, timer_active: false }
    return validateControlState(state, missionId)
  }

  async consumeParentAuthorization(input: A1SingleApprovalBrokerParentInput): Promise<unknown> {
    validateParentInput(input)
    const row = await this.one<{ value: unknown }>(
      `SELECT control.consume_a1_single_approval_parent($1::jsonb) AS value`,
      [JSON.stringify(input)],
      'A1_CONTROL_PARENT_CONSUMPTION_FAILED',
    )
    const value = record(row.value, 'A1_CONTROL_PARENT_CONSUMPTION_FAILED')
    exactKeys(value, ['consumed'], 'A1_CONTROL_PARENT_CONSUMPTION_FAILED')
    if (value.consumed !== true)
      throw new PostgresA1SingleApprovalControlError('A1_CONTROL_PARENT_CONSUMPTION_FAILED')
    return { consumed: true }
  }

  async dispatchOnce(input: A1SingleApprovalBrokerDispatchInput): Promise<unknown> {
    validateDispatchInput(input)
    const state = await this.inspect(input.mission_id)
    if (
      state.global_kill !== false || state.execution_window_open !== true ||
      state.dispatch_claiming_permitted !== true || state.external_actions_blocked !== true ||
      state.channel_kills !== 7 || state.active_or_uncertain_jobs !== 0 ||
      state.external_actions !== 0 || state.crm_writes !== 0 || state.crm_outbox !== 0
    ) throw new PostgresA1SingleApprovalControlError('A1_CONTROL_DISPATCH_GATE_CLOSED')
    let raw: unknown
    try {
      raw = await this.options.dispatcher.runOnce()
    } catch {
      throw new PostgresA1SingleApprovalControlError('A1_CONTROL_DISPATCH_UNCERTAIN')
    }
    const result = record(raw, 'A1_CONTROL_DISPATCH_UNCERTAIN')
    exactKeys(result, ['status', 'processed', 'external_actions'], 'A1_CONTROL_DISPATCH_UNCERTAIN')
    if (result.status !== 'processed' || result.processed !== true || result.external_actions !== 0)
      throw new PostgresA1SingleApprovalControlError('A1_CONTROL_DISPATCH_UNCERTAIN')
    return { status: 'processed', processed: true, external_actions: 0, retry_attempted: false }
  }

  async recontain(input: A1SingleApprovalBrokerRecontainInput): Promise<unknown> {
    requireUuid(input.mission_id, 'A1_CONTROL_RECONTAIN_INPUT_INVALID')
    if (
      !/^A1_SINGLE_APPROVAL_(CHAIN_COMPLETED|FAILED:[a-z_]+)$/.test(input.reason) ||
      !digest.test(input.stage_receipt_key) || !digest.test(input.user_authorization_sha256)
    ) throw new PostgresA1SingleApprovalControlError('A1_CONTROL_RECONTAIN_INPUT_INVALID')
    const row = await this.one<{ value: unknown }>(
      `SELECT control.recontain_a1_single_approval_chain($1::uuid,$2::text) AS value`,
      [input.mission_id, input.reason],
      'A1_CONTROL_RECONTAINMENT_FAILED',
    )
    const value = record(row.value, 'A1_CONTROL_RECONTAINMENT_FAILED')
    exactKeys(value, ['recontained'], 'A1_CONTROL_RECONTAINMENT_FAILED')
    if (value.recontained !== true)
      throw new PostgresA1SingleApprovalControlError('A1_CONTROL_RECONTAINMENT_FAILED')
    return { recontained: true }
  }

  private async one<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[],
    code: string,
  ): Promise<T> {
    try {
      const result = await this.options.database.query<T>({
        text,
        values: [...values],
        query_timeout: 1_500,
      } as QueryConfig)
      if (result.rowCount !== 1 || !result.rows[0]) throw new Error('ROW_COUNT')
      return result.rows[0]
    } catch {
      throw new PostgresA1SingleApprovalControlError(code)
    }
  }
}

function validateParentInput(input: A1SingleApprovalBrokerParentInput): void {
  requireUuid(input.request_id, 'A1_CONTROL_PARENT_INPUT_INVALID')
  requireUuid(input.mission_id, 'A1_CONTROL_PARENT_INPUT_INVALID')
  requireUuid(input.trace_id, 'A1_CONTROL_PARENT_INPUT_INVALID')
  if (
    !digest.test(input.authorization_digest_sha256) ||
    !digest.test(input.user_authorization_sha256) ||
    !digest.test(input.expected_mission_sha256) ||
    !digest.test(input.assignment_plan_sha256) || !digest.test(input.job_set_sha256) ||
    !digest.test(input.stage_receipt_key) || !digest.test(input.idempotency_key) ||
    input.stage_receipt_key !== input.idempotency_key ||
    input.worker_id !== 'broker-dispatcher-1' || input.maximum_dispatch_ticks !== 6 ||
    !Array.isArray(input.assignment_ids) || input.assignment_ids.length !== 6 ||
    new Set(input.assignment_ids).size !== 6 || input.assignment_ids.some((id) => !uuid.test(id))
  ) throw new PostgresA1SingleApprovalControlError('A1_CONTROL_PARENT_INPUT_INVALID')
}

function validateDispatchInput(input: A1SingleApprovalBrokerDispatchInput): void {
  requireUuid(input.mission_id, 'A1_CONTROL_DISPATCH_INPUT_INVALID')
  if (
    input.worker_id !== 'broker-dispatcher-1' || !Number.isSafeInteger(input.tick) ||
    input.tick < 1 || input.tick > 6 || !digest.test(input.stage_receipt_key) ||
    !digest.test(input.user_authorization_sha256)
  ) throw new PostgresA1SingleApprovalControlError('A1_CONTROL_DISPATCH_INPUT_INVALID')
}

function validateControlState(
  value: Record<string, unknown>,
  missionId: string,
): A1SingleApprovalControlState {
  exactKeys(value, [
    'mission_id', 'channel_kills', 'external_actions_blocked', 'timer_enabled',
    'timer_active', 'external_actions', 'crm_writes', 'crm_outbox', 'global_kill',
    'execution_window_open', 'dispatch_claiming_permitted', 'active_or_uncertain_jobs',
    'parent_authorization_consumed', 'completed_jobs', 'usage_value_consumed_usd',
  ], 'A1_CONTROL_STATE_INVALID')
  if (
    value.mission_id !== missionId || value.channel_kills !== 7 ||
    value.external_actions_blocked !== true || value.timer_enabled !== false ||
    value.timer_active !== false || value.external_actions !== 0 || value.crm_writes !== 0 ||
    value.crm_outbox !== 0 || typeof value.global_kill !== 'boolean' ||
    typeof value.execution_window_open !== 'boolean' ||
    typeof value.dispatch_claiming_permitted !== 'boolean' ||
    typeof value.parent_authorization_consumed !== 'boolean' ||
    !nonNegativeInteger(value.active_or_uncertain_jobs) ||
    !nonNegativeInteger(value.completed_jobs) ||
    typeof value.usage_value_consumed_usd !== 'number' ||
    !Number.isFinite(value.usage_value_consumed_usd) || value.usage_value_consumed_usd < 0
  ) throw new PostgresA1SingleApprovalControlError('A1_CONTROL_STATE_INVALID')
  return structuredClone(value) as unknown as A1SingleApprovalControlState
}

function requireUuid(value: string, code: string): void {
  if (!uuid.test(value)) throw new PostgresA1SingleApprovalControlError(code)
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PostgresA1SingleApprovalControlError(code)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new PostgresA1SingleApprovalControlError(code)
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index])
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
