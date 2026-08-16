import { Pool } from 'pg'
import { InMemoryAuditSink, type AuditSink } from './observability.js'
import {
  PostgresAuditSink,
  PostgresRuntimeRepository,
} from './postgres-repository.js'
import {
  InMemoryRuntimeRepository,
  type RuntimeRepository,
} from './repository.js'

type RuntimeEnvironment = Record<string, string | undefined>

export interface RuntimePersistence {
  repository: RuntimeRepository
  audit: AuditSink
  close(): Promise<void>
  ready(): Promise<void>
}

export async function createRuntimePersistence(
  environment: RuntimeEnvironment = process.env,
): Promise<RuntimePersistence> {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (databaseUrl) {
    const approverUrl = environment.APPROVER_DATABASE_URL?.trim()
    const safetyUrl = environment.SAFETY_DATABASE_URL?.trim()
    if (environment.NODE_ENV === 'production' && !approverUrl) {
      throw new Error('APPROVER_DATABASE_URL is required in production')
    }
    if (environment.NODE_ENV === 'production' && !safetyUrl) {
      throw new Error('SAFETY_DATABASE_URL is required in production')
    }
    const principals=[principal(databaseUrl,'DATABASE_URL'),principal(approverUrl??databaseUrl,'APPROVER_DATABASE_URL'),principal(safetyUrl??databaseUrl,'SAFETY_DATABASE_URL')]
    if(environment.NODE_ENV==='production'&&new Set(principals).size!==3)throw new Error('PRODUCTION_DATABASE_PRINCIPALS_MUST_BE_DISTINCT')
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'proptimiza-commercial-runtime',
    })
    const approverPool = new Pool({
      connectionString: approverUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-approver',
    })
    const safetyPool = new Pool({
      connectionString: safetyUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-safety',
    })
    const persistence:RuntimePersistence = {
      repository: new PostgresRuntimeRepository(pool, { approverPool, safetyPool }),
      audit: new PostgresAuditSink(pool),
      ready: async()=>verifyProductionDatabasePrincipals([{pool,expected:principals[0]!,capability:'commercial_runtime'},{pool:approverPool,expected:principals[1]!,capability:'commercial_approver'},{pool:safetyPool,expected:principals[2]!,capability:'commercial_safety_operator'}]),
      close: async () => { await Promise.all([pool.end(), approverPool.end(), safetyPool.end()]) },
    }
    try{await persistence.ready();return persistence}catch(error){await persistence.close();throw error}
  }
  if (environment.NODE_ENV === 'test' || environment.NODE_ENV === 'development') {
    return {
      repository: new InMemoryRuntimeRepository(),
      audit: new InMemoryAuditSink(),
      ready: async()=>undefined,
      close: async () => undefined,
    }
  }
  throw new Error('DATABASE_URL is required outside test/development')
}

const CAPABILITIES=['commercial_runtime','commercial_approver','commercial_safety_operator','commercial_observer']as const
const EXPECTED_FUNCTIONS:Record<typeof CAPABILITIES[number],string[]>={
  commercial_runtime:['catalog.mission_versions_exist(text,text,text,text,text,text)','mail.delivery_policy_allows(text,text,text,text,integer)','control.runtime_ready()','control.save_mission(uuid,text,jsonb)','control.get_mission(uuid)','control.is_mission_a3(uuid)','mail.store_webhook_event(text,text,timestamptz,text,boolean,jsonb)','control.request_approval(uuid,jsonb,text,timestamptz)','control.consume_approval(text,text,text,timestamptz)','control.is_kill_switch_active(text,text)','mail.claim_external_action(uuid,text,text,text)','mail.complete_external_action(uuid,text,text,text,uuid)','control.record_audit_event(jsonb)','control.enqueue_dispatch(uuid,uuid,uuid,text,text,text,text,uuid[],numeric,bigint,integer,integer)','control.recover_dispatch_leases()','control.claim_dispatch(text,integer,integer)','control.fail_dispatch(uuid,text,text,boolean)','control.complete_dispatch(uuid,text,jsonb,text,numeric,bigint,integer)'],
  commercial_approver:['control.get_pending_approval(uuid)','control.decide_approval(uuid,text,text,timestamptz,text,text,timestamptz,jsonb,text,timestamptz)'],
  commercial_safety_operator:['control.set_kill_switch(text,text,boolean)'],
  commercial_observer:[],
}
export async function verifyProductionDatabasePrincipals(entries:Array<{pool:Pick<Pool,'query'>;expected:string;capability:typeof CAPABILITIES[number]}>):Promise<void>{
  for(const entry of entries){
    const identityResult=await entry.pool.query<{current_user:string;memberships:string[];rolcanlogin:boolean;unsafe:boolean}>(`SELECT current_user,r.rolcanlogin,(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)AS unsafe,ARRAY(SELECT parent.rolname::text FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member=r.oid ORDER BY parent.rolname)::text[] AS memberships FROM pg_roles r WHERE r.rolname=current_user`)
    const identity=identityResult.rows[0]
    if(!identity||identity.current_user!==entry.expected||!identity.rolcanlogin||identity.unsafe||identity.memberships.length!==1||identity.memberships[0]!==entry.capability)throw new Error(`DATABASE_PRINCIPAL_CAPABILITY_MISMATCH:${entry.capability}:identity`)
    const result=await entry.pool.query<{current_user:string;memberships:string[];rolcanlogin:boolean;unsafe:boolean;unsafe_effective:boolean;unexpected_functions:string[];missing_functions:string[]}>(`
      SELECT current_user,r.rolcanlogin,
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS unsafe,
        ARRAY(SELECT parent.rolname::text FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member=r.oid ORDER BY parent.rolname)::text[] AS memberships,
        ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.oid<>ALL(ARRAY(SELECT to_regprocedure(expected.name)::oid FROM unnest($1::text[]) AS expected(name))) ORDER BY p.oid::regprocedure::text) AS unexpected_functions,
        ARRAY(SELECT expected.name FROM unnest($1::text[]) AS expected(name) WHERE to_regprocedure(expected.name) IS NULL OR NOT coalesce(has_function_privilege(current_user,to_regprocedure(expected.name),'EXECUTE'),false) ORDER BY expected.name) AS missing_functions,
        (
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND c.relkind IN('r','p') AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE')))
          OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.datdba=r.oid)
          OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND n.nspowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY(ARRAY['catalog','control','mail']) AND c.relowner=r.oid)
        ) AS unsafe_effective
      FROM pg_roles r WHERE r.rolname=current_user`,[EXPECTED_FUNCTIONS[entry.capability]])
    const row=result.rows[0]
    if(!row||row.current_user!==entry.expected||!row.rolcanlogin||row.unsafe||row.unsafe_effective||(row.unexpected_functions?.length??0)!==0||(row.missing_functions?.length??0)!==0||row.memberships.length!==1||row.memberships[0]!==entry.capability)throw new Error(`DATABASE_PRINCIPAL_CAPABILITY_MISMATCH:${entry.capability}:${row?JSON.stringify({current_user:row.current_user,rolcanlogin:row.rolcanlogin,unsafe:row.unsafe,unsafe_effective:row.unsafe_effective,memberships:row.memberships,unexpected_functions:row.unexpected_functions,missing_functions:row.missing_functions}):'no-row'}`)
  }
}
function principal(connectionString:string,label:string):string{let username:string;try{username=decodeURIComponent(new URL(connectionString).username)}catch{throw new Error(`${label}_INVALID`)}if(!username)throw new Error(`${label}_USERNAME_REQUIRED`);return username}
