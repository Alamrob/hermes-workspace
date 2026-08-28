BEGIN;

CREATE OR REPLACE FUNCTION control.build_a1_research_dossier(uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  review control.draft_review_sessions%ROWTYPE;
  accounts jsonb := '[]'::jsonb;
  eligible_count integer := 0;
  review_completed boolean := false;
  dossier_status text := 'review_incomplete';
BEGIN
  SELECT * INTO review FROM control.draft_review_sessions WHERE review_id=$1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  review_completed := review.status='completed' AND review.internal_review_gate='complete' AND
    review.production_gate='blocked' AND review.external_actions=0 AND review.reviewer_id IS NOT NULL AND
    review.completed_at IS NOT NULL AND
    (SELECT count(*) FROM control.draft_review_items WHERE review_id=$1 AND human_decision IS NOT NULL)=3;

  IF review_completed THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'slot',item_slot,
      'companyName',company_name,
      'sourceUrl',source_url,
      'decision',human_decision,
      'decisionVersion',version
    ) ORDER BY item_slot),'[]'::jsonb), count(*)::integer
    INTO accounts,eligible_count
    FROM control.draft_review_items
    WHERE review_id=$1 AND human_decision IN('accepted_internal','revised_internal') AND
      approval_state='internal_reviewed' AND external_action_eligible=false AND version>=1;
    dossier_status := CASE WHEN eligible_count>0 THEN 'authorization_required' ELSE 'no_eligible_accounts' END;
  END IF;

  RETURN jsonb_build_object(
    'reviewId',review.review_id,
    'projectId',review.project_id,
    'offerId',review.offer_id,
    'offerVersion',review.offer_version,
    'status',dossier_status,
    'reviewCompleted',review_completed,
    'eligibleAccountCount',eligible_count,
    'accounts',accounts,
    'autonomyLevel','A1',
    'allowedActions',jsonb_build_array('analysis.internal','research.public.read'),
    'prohibitedActions',jsonb_build_array(
      'credit.consume','personal_contact.discover','personal_email.infer','crm.write',
      'mail.send','message.send','campaign.activate','a3.enable'
    ),
    'approvedChannels',jsonb_build_array('internal','public_web'),
    'requestedTools',jsonb_build_array('hermes.analysis','hermes.web'),
    'allowedDataCategories',jsonb_build_array(
      'public_company_identity','public_business_information','public_source_provenance',
      'published_role_based_corporate_channel'
    ),
    'maximumAccounts',eligible_count,
    'maximumContacts',0,
    'maximumExternalActions',0,
    'maximumBudgetUsd',0.5,
    'providerCreditSpendAllowed',false,
    'internetAccessAllowed',false,
    'contactPermitted',false,
    'crmWriteAllowed',false,
    'authorizationRequired',review_completed AND eligible_count>0,
    'missionCreated',false,
    'productionGate','blocked',
    'externalActions',0,
    'provenance',jsonb_build_object(
      'source','control-broker',
      'sourceId','a1-research-dossier:'||review.review_id::text,
      'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'synthetic',false
    )
  );
END$$;

REVOKE ALL ON FUNCTION control.build_a1_research_dossier(uuid)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.build_a1_research_dossier(uuid) TO commercial_runtime;

COMMIT;
