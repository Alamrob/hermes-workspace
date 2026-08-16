BEGIN;

CREATE TABLE IF NOT EXISTS catalog.project_inventory (
  project_id text PRIMARY KEY REFERENCES catalog.projects(project_id) ON DELETE RESTRICT,
  operating_state text NOT NULL CHECK (operating_state IN ('inactive','read_only')),
  activatable boolean NOT NULL,
  maturity_status text NOT NULL CHECK (maturity_status = 'unknown'),
  provenance text NOT NULL CHECK (provenance = 'user-approved-inventory-2026-08-16'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((project_id = 'proptimiza' AND activatable) OR (project_id <> 'proptimiza' AND NOT activatable))
);

WITH inventory(project_id,display_name) AS (VALUES
  ('proptimiza','Proptimiza'),
  ('proptimiza-divi-factory','Proptimiza Divi Factory'),
  ('proptimiza-metodologia','Proptimiza Metodología'),
  ('proptimiza-brain','Proptimiza Brain'),
  ('xg-systems','XG Systems'),
  ('vendia','VendIA'),
  ('prospecta360','Prospecta360'),
  ('diagnostico360','Diagnóstico360'),
  ('altiropay','AltiroPay'),
  ('mallaguardian','MallaGuardian'),
  ('regalorapido','Regalorapido'),
  ('pickerwheel','PickerWheel'),
  ('afilia2','Afilia2'),
  ('bellezapro','BellezaPro'),
  ('compactcompute','CompactCompute'),
  ('content-factory','Content Factory'),
  ('fabrica-ideas-virales','Fábrica de Ideas Virales'),
  ('ia-viva','IA Viva'),
  ('minimundos','MiniMundos'),
  ('pixyourbrain','PixYourBrain'),
  ('precioalerta','PrecioAlerta'),
  ('trackingpro','TrackingPro'),
  ('traderbotcl','TraderBotCL'),
  ('vozpropiaia','VozPropiaIA'),
  ('workagent','WorkAgent'),
  ('wspro','WSPro')
)
INSERT INTO catalog.projects(project_id,display_name)
SELECT project_id,display_name FROM inventory ON CONFLICT DO NOTHING;

WITH inventory(project_id) AS (VALUES
  ('proptimiza'),('proptimiza-divi-factory'),('proptimiza-metodologia'),
  ('proptimiza-brain'),('xg-systems'),('vendia'),('prospecta360'),
  ('diagnostico360'),('altiropay'),('mallaguardian'),('regalorapido'),
  ('pickerwheel'),('afilia2'),('bellezapro'),('compactcompute'),
  ('content-factory'),('fabrica-ideas-virales'),('ia-viva'),('minimundos'),
  ('pixyourbrain'),('precioalerta'),('trackingpro'),('traderbotcl'),
  ('vozpropiaia'),('workagent'),('wspro')
)
INSERT INTO catalog.project_inventory(project_id,operating_state,activatable,maturity_status,provenance)
SELECT project_id,CASE WHEN project_id='proptimiza' THEN 'read_only' ELSE 'inactive' END,
       project_id='proptimiza','unknown','user-approved-inventory-2026-08-16'
FROM inventory ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM catalog.project_inventory
      WHERE provenance='user-approved-inventory-2026-08-16') <> 26 THEN
    RAISE EXCEPTION 'PORTFOLIO_INVENTORY_SEED_CONFLICT';
  END IF;
  IF EXISTS(
    SELECT 1 FROM catalog.project_inventory i JOIN catalog.projects p USING(project_id)
    WHERE (i.project_id='proptimiza') IS DISTINCT FROM i.activatable
       OR btrim(p.display_name)=''
  ) THEN RAISE EXCEPTION 'PORTFOLIO_INVENTORY_SEED_CONFLICT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION catalog.mission_versions_exist(text,text,text,text,text,text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM catalog.current_version_activation a
    JOIN catalog.project_inventory i USING(project_id)
    WHERE a.project_id=$1 AND a.project_version=$2 AND a.offer_id=$3
      AND a.offer_version=$4 AND a.icp_version=$5 AND a.policy_version=$6
      AND i.activatable
  )
$$;

CREATE OR REPLACE FUNCTION control.get_portfolio_read_model() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT jsonb_build_object(
  'portfolio',jsonb_build_object(
    'status','known','projectCount',(SELECT count(*) FROM catalog.project_inventory),
    'provenance','user-approved-inventory-2026-08-16'),
  'projects',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'projectId',i.project_id,'displayName',p.display_name,
    'operatingState',i.operating_state,'activatable',i.activatable,
    'maturityStatus',i.maturity_status,
    'offerEvidence',CASE WHEN EXISTS(SELECT 1 FROM catalog.offer_versions o WHERE o.project_id=i.project_id) THEN 'versioned-catalog' ELSE NULL END,
    'icpEvidence',CASE WHEN EXISTS(SELECT 1 FROM catalog.icp_versions c WHERE c.project_id=i.project_id) THEN 'versioned-catalog' ELSE NULL END,
    'policyEvidence',CASE WHEN EXISTS(SELECT 1 FROM catalog.policy_versions v WHERE v.project_id=i.project_id) THEN 'versioned-catalog' ELSE NULL END,
    'provenance',i.provenance) ORDER BY p.display_name),'[]'::jsonb)
    FROM catalog.project_inventory i JOIN catalog.projects p USING(project_id)),
  'missions',jsonb_build_object('status','known','count',(SELECT count(*) FROM control.missions),'provenance','postgres'),
  'missionDrafts',jsonb_build_object('status','unknown','count',NULL,'provenance','not-modeled'),
  'approvals',jsonb_build_object('status','known','count',(SELECT count(*) FROM control.approvals),'provenance','postgres'),
  'qa',jsonb_build_object('status','unknown','count',NULL,'provenance','not-modeled'),
  'agents',jsonb_build_object('status','unknown','count',NULL,'provenance','not-modeled'),
  'experiments',jsonb_build_object('status','unknown','count',NULL,'provenance','not-modeled'),
  'costs',jsonb_build_object('status','unknown','usageValueMicroCents',NULL,'cashCostMicroCents',NULL,'provenance','not-aggregated'),
  'audit',jsonb_build_object('status','known','count',(SELECT count(*) FROM control.audit_events),'provenance','postgres'),
  'control',jsonb_build_object('killSwitch',jsonb_build_object(
    'status','known','active',EXISTS(SELECT 1 FROM control.kill_switches WHERE scope='global' AND scope_id='*' AND active),
    'provenance','postgres'))
)
$$;

CREATE OR REPLACE FUNCTION integration.get_crm_summary() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT jsonb_build_object(
  'status','known',
  'connector','twenty',
  'outbox',jsonb_build_object(
    'pending',(SELECT count(*) FROM integration.crm_outbox WHERE status='pending'),
    'leased',(SELECT count(*) FROM integration.crm_outbox WHERE status='leased'),
    'confirmed',(SELECT count(*) FROM integration.crm_outbox WHERE status='confirmed'),
    'failed',(SELECT count(*) FROM integration.crm_outbox WHERE status='failed'),
    'outcomeUnknown',(SELECT count(*) FROM integration.crm_outbox WHERE status='outcome_unknown')),
  'inboxCount',(SELECT count(*) FROM integration.crm_inbox),
  'entityLinkCount',(SELECT count(*) FROM integration.crm_entity_links),
  'cursorCount',(SELECT count(*) FROM integration.crm_sync_cursors),
  'lastSuccessfulSyncAt',(SELECT max(updated_at) FROM integration.crm_sync_cursors),
  'provenance','postgres'
)
$$;

REVOKE ALL ON catalog.project_inventory FROM PUBLIC,commercial_runtime,commercial_crm_sync,commercial_observer;
REVOKE ALL ON FUNCTION control.get_portfolio_read_model(),integration.get_crm_summary() FROM PUBLIC,commercial_runtime,commercial_crm_sync,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_portfolio_read_model() TO commercial_runtime;
GRANT EXECUTE ON FUNCTION integration.get_crm_summary() TO commercial_crm_sync;
REVOKE ALL ON ALL TABLES IN SCHEMA catalog FROM PUBLIC;
COMMIT;
