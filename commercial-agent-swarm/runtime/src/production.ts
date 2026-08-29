import { Pool } from 'pg'
import { InMemoryAuditSink } from './observability.js'
import {
  PostgresAuditSink,
  PostgresRuntimeRepository,
} from './postgres-repository.js'
import { InMemoryRuntimeRepository } from './repository.js'
import { InMemoryApprovalEvidenceStore } from './approval-mode.js'
import { PostgresApprovalEvidenceStore } from './postgres-approval-evidence-store.js'
import { PostgresDispatchQueue } from './dispatch-queue.js'
import type { ApprovalEvidenceStorePort } from './approval-mode.js'
import type { DispatchQueuePort } from './dispatch-queue.js'
import type { AuditSink } from './observability.js'
import type { RuntimeRepository } from './repository.js'

type RuntimeEnvironment = Record<string, string | undefined>

export interface RuntimePersistence {
  repository: RuntimeRepository
  audit: AuditSink
  approvalEvidenceStore: ApprovalEvidenceStorePort
  dispatchQueue: DispatchQueuePort
  close: () => Promise<void>
  ready: () => Promise<void>
}

export async function createRuntimePersistence(
  environment: RuntimeEnvironment = process.env,
): Promise<RuntimePersistence> {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (databaseUrl) {
    const approverUrl = environment.APPROVER_DATABASE_URL?.trim()
    const safetyUrl = environment.SAFETY_DATABASE_URL?.trim()
    const workOrderUrl = environment.WORK_ORDER_DATABASE_URL?.trim()
    const approvalEvidenceUrl =
      environment.APPROVAL_EVIDENCE_DATABASE_URL?.trim()
    if (environment.NODE_ENV === 'production' && !approverUrl) {
      throw new Error('APPROVER_DATABASE_URL is required in production')
    }
    if (environment.NODE_ENV === 'production' && !safetyUrl) {
      throw new Error('SAFETY_DATABASE_URL is required in production')
    }
    if (environment.NODE_ENV === 'production' && !workOrderUrl) {
      throw new Error('WORK_ORDER_DATABASE_URL is required in production')
    }
    if (environment.NODE_ENV === 'production' && !approvalEvidenceUrl) {
      throw new Error(
        'APPROVAL_EVIDENCE_DATABASE_URL is required in production',
      )
    }
    const principals = [
      principal(databaseUrl, 'DATABASE_URL'),
      principal(workOrderUrl ?? databaseUrl, 'WORK_ORDER_DATABASE_URL'),
      principal(approverUrl ?? databaseUrl, 'APPROVER_DATABASE_URL'),
      principal(safetyUrl ?? databaseUrl, 'SAFETY_DATABASE_URL'),
      principal(
        approvalEvidenceUrl ?? databaseUrl,
        'APPROVAL_EVIDENCE_DATABASE_URL',
      ),
    ]
    if (environment.NODE_ENV === 'production' && new Set(principals).size !== 5)
      throw new Error('PRODUCTION_DATABASE_PRINCIPALS_MUST_BE_DISTINCT')
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'proptimiza-commercial-runtime',
    })
    const approverPool = new Pool({
      connectionString: approverUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-approver',
    })
    const ingestorPool = new Pool({
      connectionString: workOrderUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-work-order-ingestor',
    })
    const safetyPool = new Pool({
      connectionString: safetyUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-safety',
    })
    const approvalEvidencePool = new Pool({
      connectionString: approvalEvidenceUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-approval-evidence',
    })
    const persistence: RuntimePersistence = {
      repository: new PostgresRuntimeRepository(pool, {
        ingestorPool,
        approverPool,
        safetyPool,
      }),
      audit: new PostgresAuditSink(pool),
      approvalEvidenceStore: new PostgresApprovalEvidenceStore(
        approvalEvidencePool,
      ),
      dispatchQueue: new PostgresDispatchQueue(pool),
      ready: async () =>
        verifyProductionDatabasePrincipals([
          { pool, expected: principals[0], capability: 'commercial_runtime' },
          {
            pool: ingestorPool,
            expected: principals[1],
            capability: 'commercial_work_order_ingestor',
          },
          {
            pool: approverPool,
            expected: principals[2],
            capability: 'commercial_approver',
          },
          {
            pool: safetyPool,
            expected: principals[3],
            capability: 'commercial_safety_operator',
          },
          {
            pool: approvalEvidencePool,
            expected: principals[4],
            capability: 'commercial_approval_evidence',
          },
        ]),
      close: async () => {
        await Promise.all([
          pool.end(),
          ingestorPool.end(),
          approverPool.end(),
          safetyPool.end(),
          approvalEvidencePool.end(),
        ])
      },
    }
    try {
      await persistence.ready()
      return persistence
    } catch (error) {
      await persistence.close()
      throw error
    }
  }
  if (
    environment.NODE_ENV === 'test' ||
    environment.NODE_ENV === 'development'
  ) {
    return {
      repository: new InMemoryRuntimeRepository(),
      audit: new InMemoryAuditSink(),
      approvalEvidenceStore: new InMemoryApprovalEvidenceStore(),
      dispatchQueue: noDispatchQueue(),
      ready: async () => undefined,
      close: async () => undefined,
    }
  }
  throw new Error('DATABASE_URL is required outside test/development')
}

const CAPABILITIES = [
  'commercial_runtime',
  'commercial_work_order_ingestor',
  'commercial_approver',
  'commercial_safety_operator',
  'commercial_observer',
  'commercial_approval_evidence',
] as const
const EXPECTED_FUNCTIONS: Record<
  (typeof CAPABILITIES)[number],
  Array<string>
> = {
  commercial_runtime: [
    'catalog.mission_versions_exist(text,text,text,text,text,text)',
    'mail.delivery_policy_allows(text,text,text,text,integer)',
    'control.runtime_ready()',
    'control.get_portfolio_read_model()',
    'control.list_shadow_reviews()',
    'control.get_shadow_review(uuid)',
    'control.record_shadow_review_decision(uuid,integer,text,text,text,text,integer,text,text,text)',
    'control.complete_shadow_review(uuid,integer,text,text,text)',
    'control.list_draft_reviews()',
    'control.get_draft_review(uuid)',
    'control.record_draft_review_item(uuid,integer,text,text,text,text,integer,text,text,text)',
    'control.complete_draft_review(uuid,integer,text,text,text)',
    'control.build_a1_research_dossier(uuid)',
    'control.build_a1_research_authorization_state(uuid,text)',
    'control.record_a1_research_authorization(uuid,uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,jsonb,text,text)',
    'control.get_a1_research_order_authorization(uuid)',
    'control.record_a1_research_order_authorization(uuid,uuid,uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid,text,jsonb,text,text)',
    'control.get_a1_dispatch_authorization(uuid)',
    'control.record_a1_dispatch_authorization(uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,text,text,jsonb,text,text)',
    'control.is_global_kill_switch_active()',
    'control.get_a1_assignment_enqueue_authorization(uuid)',
    'control.record_a1_assignment_enqueue_authorization(uuid,uuid,uuid,text,uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,text,text,jsonb,text,text)',
    'control.get_a1_assignment_execution_authorization(uuid)',
    'control.record_a1_assignment_execution_authorization(uuid,uuid,uuid,text,uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,text,text,uuid[],numeric,text,jsonb,text,text)',
    'control.get_a1_dispatch_execution_arm(uuid)',
    'control.record_a1_dispatch_execution_arm(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,text,uuid[],text,integer,numeric,text,jsonb,text,text)',
    'control.get_a1_dispatch_execution_window(uuid)',
    'control.create_pilot_cohort(uuid,text,text)',
    'control.add_pilot_target(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamp with time zone,text)',
    'control.get_mission(uuid)',
    'control.is_mission_a3(uuid)',
    'mail.store_webhook_event(text,text,timestamptz,text,boolean,jsonb)',
    'control.request_approval(uuid,jsonb,text,timestamptz)',
    'control.consume_approval(text,text,text,timestamptz)',
    'control.is_kill_switch_active(text,text)',
    'mail.claim_external_action(uuid,text,text,text)',
    'mail.complete_external_action(uuid,text,text,text,uuid)',
    'control.record_audit_event(jsonb)',
    'control.enqueue_dispatch(uuid,uuid,uuid,text,text,text,text,uuid[],numeric,bigint,integer,integer)',
    'control.recover_dispatch_leases()',
    'control.terminalize_failed_dispatch_dependencies()',
    'control.claim_dispatch(text,integer,integer)',
    'control.fail_dispatch(uuid,text,text,boolean,text,bigint)',
    'control.complete_dispatch(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)',
    'control.external_actions_blocked()',
    'control.get_mission_execution(uuid)',
    'control.get_dispatch_dependency_evidence(uuid)',
    'control.build_policy_review_state()',
    'control.record_policy_human_review(text,text,text,text,text,timestamp with time zone,text,jsonb,text,text)',
    'control.build_policy_activation_dossier_state()',
  ],
  commercial_work_order_ingestor: [
    'control.save_mission(uuid,text,jsonb)',
    'control.create_instruction_request(uuid,text,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,jsonb)',
    'control.list_instruction_requests()',
    'control.get_instruction_request(uuid)',
    'control.review_instruction_request(uuid,text,text,text,timestamp with time zone,text,text,text,uuid,text,jsonb)',
  ],
  commercial_approver: [
    'control.get_pending_approval(uuid)',
    'control.decide_approval(uuid,text,text,timestamptz,text,text,timestamptz,jsonb,text,timestamptz)',
  ],
  commercial_safety_operator: [
    'control.set_kill_switch(text,text,boolean)',
    'control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)',
    'control.add_pilot_suppression(text,text,text)',
    'mail.attest_internal_mail_test(uuid,text,uuid,text,uuid,text,text,text)',
  ],
  commercial_observer: [],
  commercial_approval_evidence: [
    'control.record_approval_channel_evidence(uuid,text,text,text,text,timestamp with time zone)',
    'control.list_approval_channel_evidence(uuid)',
  ],
}

function noDispatchQueue(): DispatchQueuePort {
  return {
    enqueue: async () => {
      throw new Error('DISPATCH_PERSISTENCE_UNAVAILABLE')
    },
    getMissionExecution: async () => {
      throw new Error('DISPATCH_PERSISTENCE_UNAVAILABLE')
    },
    claim: async () => null,
    recover: async () => undefined,
    fail: async () => {
      throw new Error('DISPATCH_PERSISTENCE_UNAVAILABLE')
    },
    complete: async () => {
      throw new Error('DISPATCH_PERSISTENCE_UNAVAILABLE')
    },
  }
}
export async function verifyProductionDatabasePrincipals(
  entries: Array<{
    pool: Pick<Pool, 'query'>
    expected: string
    capability: (typeof CAPABILITIES)[number]
  }>,
): Promise<void> {
  for (const entry of entries) {
    const identityResult = await entry.pool.query<{
      current_user: string
      memberships: Array<string>
      rolcanlogin: boolean
      unsafe: boolean
    }>(
      `SELECT current_user,r.rolcanlogin,(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)AS unsafe,ARRAY(SELECT parent.rolname::text FROM pg_roles parent WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'MEMBER') ORDER BY parent.rolname)::text[] AS memberships FROM pg_roles r WHERE r.rolname=current_user`,
    )
    const identity = identityResult.rows.at(0)
    if (
      !identity ||
      identity.current_user !== entry.expected ||
      !identity.rolcanlogin ||
      identity.unsafe ||
      identity.memberships.length !== 1 ||
      identity.memberships[0] !== entry.capability
    )
      throw new Error(
        `DATABASE_PRINCIPAL_CAPABILITY_MISMATCH:${entry.capability}:identity`,
      )
    const result = await entry.pool.query<{
      current_user: string
      memberships: Array<string>
      rolcanlogin: boolean
      unsafe: boolean
      unsafe_effective: boolean
      unexpected_functions: Array<string>
      missing_functions: Array<string>
    }>(
      `
      SELECT current_user,r.rolcanlogin,
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS unsafe,
        ARRAY(SELECT parent.rolname::text FROM pg_roles parent WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'MEMBER') ORDER BY parent.rolname)::text[] AS memberships,
        ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.oid<>ALL(ARRAY(SELECT to_regprocedure(expected.name)::oid FROM unnest($1::text[]) AS expected(name))) ORDER BY p.oid::regprocedure::text) AS unexpected_functions,
        ARRAY(SELECT expected.name FROM unnest($1::text[]) AS expected(name) WHERE (to_regprocedure(expected.name) IS NULL AND expected.name<>'control.get_portfolio_read_model()') OR (to_regprocedure(expected.name) IS NOT NULL AND NOT coalesce(has_function_privilege(current_user,to_regprocedure(expected.name),'EXECUTE'),false)) ORDER BY expected.name) AS missing_functions,
        (
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND c.relkind IN('r','p','v','m','f') AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR has_table_privilege(current_user,c.oid,'REFERENCES') OR has_table_privilege(current_user,c.oid,'TRIGGER')))
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND c.relkind IN('r','p','v','m','f') AND (has_any_column_privilege(current_user,c.oid,'SELECT') OR has_any_column_privilege(current_user,c.oid,'INSERT') OR has_any_column_privilege(current_user,c.oid,'UPDATE') OR has_any_column_privilege(current_user,c.oid,'REFERENCES')))
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND c.relkind='S' AND (has_sequence_privilege(current_user,c.oid,'SELECT') OR has_sequence_privilege(current_user,c.oid,'USAGE') OR has_sequence_privilege(current_user,c.oid,'UPDATE')))
          OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND has_schema_privilege(current_user,n.oid,'CREATE'))
          OR has_database_privilege(current_user,current_database(),'CREATE') OR has_database_privilege(current_user,current_database(),'TEMP')
          OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid AND m.admin_option)
          OR EXISTS(SELECT 1 FROM pg_roles parent WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'MEMBER') AND (parent.rolsuper OR parent.rolcreatedb OR parent.rolcreaterole OR parent.rolreplication OR parent.rolbypassrls))
          OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.datdba=r.oid)
          OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND n.nspowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND c.relowner=r.oid)
        ) AS unsafe_effective
      FROM pg_roles r WHERE r.rolname=current_user`,
      [EXPECTED_FUNCTIONS[entry.capability]],
    )
    const row = result.rows.at(0)
    const details = row
      ? JSON.stringify({
          current_user: row.current_user,
          rolcanlogin: row.rolcanlogin,
          unsafe: row.unsafe,
          unsafe_effective: row.unsafe_effective,
          memberships: row.memberships,
          unexpected_functions: row.unexpected_functions,
          missing_functions: row.missing_functions,
        })
      : 'no-row'
    if (
      !row ||
      row.current_user !== entry.expected ||
      !row.rolcanlogin ||
      row.unsafe ||
      row.unsafe_effective ||
      row.unexpected_functions.length !== 0 ||
      row.missing_functions.length !== 0 ||
      row.memberships.length !== 1 ||
      row.memberships[0] !== entry.capability
    )
      throw new Error(
        `DATABASE_PRINCIPAL_CAPABILITY_MISMATCH:${entry.capability}:${details}`,
      )
  }
}
function principal(connectionString: string, label: string): string {
  let username: string
  try {
    username = decodeURIComponent(new URL(connectionString).username)
  } catch {
    throw new Error(`${label}_INVALID`)
  }
  if (!username) throw new Error(`${label}_USERNAME_REQUIRED`)
  return username
}
