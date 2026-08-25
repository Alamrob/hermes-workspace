import { hashAction } from './canonical.js';

const draft = {
  projectId: 'proptimiza',
  planVersion: 'internal-mail-test-v1',
  state: 'draft_only',
  actionType: 'mail.send',
  channel: 'email',
  sender: 'ventas@proptimiza.com',
  recipient: 'contacto@proptimiza.com',
  displayName: 'Equipo Proptimiza',
  subject: 'Prueba interna de correo Proptimiza',
  content: 'Hola,\n\nEste es un mensaje interno de verificación técnica del sistema comercial de Proptimiza. No contiene una oferta comercial y no requiere respuesta.\n\nEquipo Proptimiza',
  contentVersion: 'internal-mail-test-v1',
  volume: 1,
  projectVersion: 'v1',
  offerVersion: 'offer-v1',
  policyVersion: 'policy-v1',
  trackingPixels: false,
  trackingLinks: false,
  automaticFollowUp: false,
  executionAllowed: false,
  requiredGates: [
    'mail_dns_ready',
    'hostinger_credentials_metadata_valid',
    'hostinger_transport_read_only',
    'global_kill_switch_active',
    'email_kill_switch_active',
    'qa_approved',
    'one_exact_a3_mission',
    'single_use_approval_token',
  ],
} as const;

export type InternalMailTestPlan = typeof draft & {
  planHash: string;
  provenance: {
    source: 'control-broker';
    sourceId: 'internal-mail-test-plan:proptimiza:v1';
    observedAt: string;
    synthetic: false;
  };
};

export function buildInternalMailTestPlan(now = new Date()): InternalMailTestPlan {
  return {
    ...draft,
    requiredGates: [...draft.requiredGates],
    planHash: hashAction(draft),
    provenance: {
      source: 'control-broker',
      sourceId: 'internal-mail-test-plan:proptimiza:v1',
      observedAt: now.toISOString(),
      synthetic: false,
    },
  } as InternalMailTestPlan;
}
