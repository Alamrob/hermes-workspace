import { hashAction } from './canonical.js'
import type { ApprovalAction } from './approvals.js'
import type { WorkOrder } from './work-orders.js'

const PLAN_HASH = '18fe59be00a1b5dd5f4e3bb81f77ef41d69f17024cc2797e7b1ecacc3f34f348'
const SENDER = 'ventas@proptimiza.com'
const RECIPIENT = 'contacto@proptimiza.com'
const SUBJECT = 'Prueba interna de correo Proptimiza'
const CONTENT = 'Hola,\n\nEste es un mensaje interno de verificación técnica del sistema comercial de Proptimiza. No contiene una oferta comercial y no requiere respuesta.\n\nEquipo Proptimiza'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/

export interface InternalMailReadiness {
  status: 'ready_for_a3_request'
  qa_approved: true
  execution_allowed: false
  checked_at: string
  plan_hash: typeof PLAN_HASH
  action: { sender: typeof SENDER; recipient: typeof RECIPIENT; volume: 1 }
  failures: []
}

export interface HumanInternalMailAuthorization {
  approved_by: 'proptimizaspa@gmail.com'
  authorized_at: string
  authorized_plan_hash: typeof PLAN_HASH
  instruction_sha256: string
}

export interface InternalMailOneShotPorts {
  createWorkOrder(unsigned: WorkOrder): Promise<void>
  requestApproval(action: ApprovalAction): Promise<{ approval_id: string; action_hash: string }>
  approve(input: {
    approval_id: string
    action_hash: string
    actor_id: 'proptimizaspa@gmail.com'
    decided_at: string
    expires_at: string
  }): Promise<{ token: string }>
  isGlobalKillSwitchActive(): Promise<boolean>
  setGlobalKillSwitch(active: boolean): Promise<void>
  send(input: { action: ApprovalAction; approval_token: string }): Promise<{ receipt_id: string; approval_reference: string }>
  record(event: { type: string; at: string; mission_id: string; details: Record<string, string | boolean> }): Promise<void>
}

export class InternalMailOneShotError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'InternalMailOneShotError'
  }
}

export class InternalMailOneShot {
  constructor(private readonly options: {
    ports: InternalMailOneShotPorts
    now?: () => Date
    uuid?: () => string
  }) {}

  async run(input: {
    readiness: InternalMailReadiness
    authorization: HumanInternalMailAuthorization
  }): Promise<{ mission_id: string; receipt_id: string; approval_reference: string }> {
    const now = (this.options.now ?? (() => new Date()))()
    validateInput(input, now)
    const missionId = (this.options.uuid ?? (() => crypto.randomUUID()))()
    const traceId = (this.options.uuid ?? (() => crypto.randomUUID()))()
    if (!UUID.test(missionId) || !UUID.test(traceId) || missionId === traceId)
      throw new InternalMailOneShotError('IDENTIFIERS_INVALID')
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString()
    const action: ApprovalAction = {
      mission_id: missionId,
      project_id: 'proptimiza',
      project_version: 'v1',
      action_type: 'mail.send',
      channel: 'email',
      sender: SENDER,
      recipients: [RECIPIENT],
      subject: SUBJECT,
      content: CONTENT,
      content_version: 'internal-mail-test-v1',
      volume: 1,
      offer_version: 'offer-v1',
      policy_version: 'policy-v1',
      idempotency_key: `internal-mail-test:${missionId}`,
    }
    const actionHash = hashAction(action)
    const workOrder = buildWorkOrder({
      missionId, traceId, createdAt, expiresAt,
      authorization: input.authorization, actionHash,
    })
    const ports = this.options.ports
    await ports.createWorkOrder(workOrder)
    await ports.record({ type: 'mission.created', at: createdAt, mission_id: missionId, details: { plan_hash: PLAN_HASH } })
    const approval = await ports.requestApproval(action)
    if (!UUID.test(approval.approval_id) || approval.action_hash !== actionHash)
      throw new InternalMailOneShotError('APPROVAL_REQUEST_MISMATCH')
    const grant = await ports.approve({
      approval_id: approval.approval_id,
      action_hash: actionHash,
      actor_id: input.authorization.approved_by,
      decided_at: createdAt,
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
    })
    if (!/^APPROVAL::[^\s]{100,1024}$/.test(grant.token))
      throw new InternalMailOneShotError('APPROVAL_TOKEN_INVALID')
    if (!(await ports.isGlobalKillSwitchActive()))
      throw new InternalMailOneShotError('KILL_SWITCH_NOT_ACTIVE_BEFORE_SEND')

    let opened = false
    let outcome: { receipt_id: string; approval_reference: string }
    try {
      opened = true
      await ports.setGlobalKillSwitch(false)
      if (await ports.isGlobalKillSwitchActive())
        throw new InternalMailOneShotError('KILL_SWITCH_DID_NOT_OPEN')
      await ports.record({ type: 'kill_switch.opened_for_single_send', at: (this.options.now ?? (() => new Date()))().toISOString(), mission_id: missionId, details: { action_hash: actionHash } })
      outcome = await ports.send({ action, approval_token: grant.token })
    } catch (error) {
      throw new InternalMailOneShotError('SINGLE_SEND_FAILED', { cause: error })
    } finally {
      if (opened) {
        try {
          await ports.setGlobalKillSwitch(true)
          if (!(await ports.isGlobalKillSwitchActive())) throw new Error('verification_failed')
        } catch (error) {
          throw new InternalMailOneShotError('KILL_SWITCH_RESTORE_FAILED', { cause: error })
        }
      }
    }
    if (!outcome!.receipt_id || !outcome!.approval_reference)
      throw new InternalMailOneShotError('SEND_RECEIPT_INVALID')
    await ports.record({ type: 'mail.sent_once', at: (this.options.now ?? (() => new Date()))().toISOString(), mission_id: missionId, details: { receipt_recorded: true, approval_recorded: true } })
    return { mission_id: missionId, ...outcome! }
  }
}

function validateInput(input: { readiness: InternalMailReadiness; authorization: HumanInternalMailAuthorization }, now: Date): void {
  const readinessAt = Date.parse(input.readiness?.checked_at)
  const authorizationAt = Date.parse(input.authorization?.authorized_at)
  if (input.readiness?.status !== 'ready_for_a3_request' || input.readiness?.qa_approved !== true ||
      input.readiness?.execution_allowed !== false || input.readiness?.plan_hash !== PLAN_HASH ||
      input.readiness?.action?.sender !== SENDER || input.readiness?.action?.recipient !== RECIPIENT ||
      input.readiness?.action?.volume !== 1 || !Array.isArray(input.readiness?.failures) || input.readiness.failures.length !== 0 ||
      !Number.isFinite(readinessAt) || now.getTime() - readinessAt > 10 * 60_000 || readinessAt > now.getTime() + 60_000)
    throw new InternalMailOneShotError('READINESS_INVALID')
  if (input.authorization?.approved_by !== 'proptimizaspa@gmail.com' ||
      input.authorization?.authorized_plan_hash !== PLAN_HASH || !SHA256.test(input.authorization?.instruction_sha256 ?? '') ||
      !Number.isFinite(authorizationAt) || now.getTime() - authorizationAt > 10 * 60_000 || authorizationAt > now.getTime() + 60_000)
    throw new InternalMailOneShotError('HUMAN_AUTHORIZATION_INVALID')
}

function buildWorkOrder(input: {
  missionId: string
  traceId: string
  createdAt: string
  expiresAt: string
  actionHash: string
  authorization: HumanInternalMailAuthorization
}): WorkOrder {
  return {
    mission_id: input.missionId, trace_id: input.traceId, created_at: input.createdAt, expires_at: input.expiresAt,
    project_id: 'proptimiza', project_version: 'v1', offer_id: 'operacion-sin-planillas', offer_version: 'offer-v1',
    icp_version: 'icp-v1', policy_version: 'policy-v1', objective: 'Verificar una entrega interna de correo sin prospectos.',
    business_context: 'Prueba técnica interna autorizada; no contiene oferta comercial ni contacto a prospectos.',
    target_segment: 'Buzones internos Proptimiza', allowed_actions: ['mail.send'],
    prohibited_actions: ['prospect.contact','campaign.activate','followup.send','discount.offer','proposal.send'],
    approved_channels: ['email'], approved_tools: ['broker.mail'], autonomy_level: 'A3',
    budget_limit: { currency: 'CLP', maximum: 0 },
    volume_limits: { maximum_accounts: 1, maximum_contacts: 1, maximum_external_actions: 1, maximum_per_contact: 1, period: 'mission', channel_limits: { email: 1 } },
    success_criteria: ['Un correo interno entrega un recibo verificable y el kill switch vuelve a activo.'],
    stop_conditions: ['Cualquier discrepancia de contenido, identidad, aprobación, proveedor, recibo o kill switch.'],
    required_evidence: ['QA readiness vigente, autorización humana exacta, aprobación consumida, recibo y auditoría.'],
    approval_token: null, idempotency_key: `internal-mail-mission:${input.missionId}`, requested_by: 'codex-control-plane',
    authority: { issuer: 'proptimiza-commercial-broker', audience: 'proptimiza-hermes-executor', key_id: 'simulation-v1', algorithm: 'HMAC-SHA256', signature: '0'.repeat(64) },
    data_policy: { classification: 'internal', allowed_countries: ['CL'], legal_basis: ['none'], retention_days: 30, sensitive_data_allowed: false, allowed_data_categories: ['technical_delivery_evidence'] },
    contact_policy: { contact_permitted: true, suppression_check_required: true, consent_check_required: false, maximum_frequency_days: 30, quiet_hours_timezone: 'America/Santiago' },
    dry_run: false,
    metadata: { plan_hash: PLAN_HASH, action_hash: input.actionHash, human_authorization_sha256: input.authorization.instruction_sha256, execution_scope: 'single_internal_mail_only' },
  } as WorkOrder
}
