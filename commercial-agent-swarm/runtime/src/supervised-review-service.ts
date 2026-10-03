import { createHash, generateKeyPairSync } from 'node:crypto'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createChatwootIngressHandler } from './comms/chatwoot-http.js'
import {
  CHATWOOT_OWNED_OPERATIONAL_LABELS,
  ChatwootHttpError,
  ChatwootReviewClient,
  chatwootOwnedLabelsForSha256,
  chatwootOwnedLabelsSha256,
  type ChatwootConversationSnapshot,
  type ChatwootOwnedOperationalLabel,
} from './comms/chatwoot-outbound.js'
import { createChatwootWebhookAdapter } from './comms/chatwoot-webhook.js'
import { createPlatformAdmission } from './platform/admission.js'
import { readGroupSecretFile } from './secret-file.js'
import {
  parseCommercialFactCatalog,
  resolveCommercialFacts,
  type CommercialFact,
} from './commercial-fact-authority.js'
import { runSupervisedConversationPilot } from './supervised-conversation-pilot.js'
import {
  SupervisedReviewStore,
  type SupervisedReviewRecord,
  type SupervisedReviewStatus,
} from './supervised-review-store.js'

const ROUTE = '/webhooks/chatwoot/proptimiza-review'
const DECIMAL = /^[1-9][0-9]{0,18}$/

export interface SupervisedReviewConfig {
  bindHost: string
  port: number
  accountId: string
  inboxId: string
  handoffTeamId: string
  stateFile: string
  webhookSecretFile: string
  reviewerTokenFile: string
  reviewerMachineSecretFile: string
  pilotGateFile: string
  pilotScopeFile: string
  commercialFactCatalogFile: string
  expectedSecretGid: number
  chatwootBaseUrl: string
}

export interface SupervisedReviewClientPort {
  snapshot(conversationId: string, messageId: string, expectedContentSha256: string): Promise<ChatwootConversationSnapshot>
  createPrivateNote(conversationId: string, content: string): Promise<{ message_id: string }>
  ownedLabelState(conversationId: string): Promise<{ owned_labels_sha256: string }>
  mergeOwnedLabels(conversationId: string, add: readonly ChatwootOwnedOperationalLabel[],
    remove: readonly ChatwootOwnedOperationalLabel[], expectedOwnedLabelsSha256: string):
    Promise<{ owned_labels_sha256: string }>
  assignTeam(conversationId: string, teamId: string): Promise<{ team_id: string }>
}

export async function processSupervisedReviewEvent(
  store: SupervisedReviewStore,
  client: SupervisedReviewClientPort,
  event: Readonly<SupervisedReviewRecord>,
  pilotEnabled: boolean,
  conversationAllowed: boolean,
  authorizedFacts: readonly Readonly<CommercialFact>[] = [],
): Promise<void> {
  if (!pilotEnabled) {
    await store.transition(event.event_id, 'pending', 'held', { stop_code: 'SUPERVISED_REVIEW_GATE_DISABLED' })
    return
  }
  if (!conversationAllowed) {
    await store.transition(event.event_id, 'pending', 'held', { stop_code: 'SUPERVISED_REVIEW_OUT_OF_SCOPE' })
    return
  }
  const priorHold = await store.conversationHoldReason(event.conversation_id)
  if (priorHold) {
    await store.transition(event.event_id, 'pending', 'held', { stop_code: 'CONVERSATION_REQUIRES_HUMAN' })
    return
  }
  await store.transition(event.event_id, 'pending', 'preparing')
  let result: Awaited<ReturnType<typeof runSupervisedConversationPilot>>
  try {
    result = await runSupervisedConversationPilot(client, {
      conversation_id: event.conversation_id,
      message_id: event.message_id,
      content_sha256: event.content_sha256,
      authorized_facts: authorizedFacts,
      capabilities: {
        internal_notes: true,
        labels: true,
        assignments: true,
        saved_drafts: false,
        hermes_dispatch: false,
        hermes_profiles: [],
      },
    })
  } catch (error) {
    const outcome = classifyFailure(error, 'PREPARATION')
    await store.transition(event.event_id, 'preparing', outcome.status, { stop_code: outcome.code })
    return
  }
  if (result.status === 'held') {
    await store.transition(event.event_id, 'preparing', 'held', {
      stop_code: result.reason === 'human_already_replied' ? 'HUMAN_REPLY_OBSERVED' : 'TARGET_NOT_CURRENT',
    })
    return
  }
  await store.transition(event.event_id, 'preparing', 'writing', {
    review_note_sha256: digest(result.review_note),
    handoff_reason: result.case_file.handoff_reason,
    stop_code: 'REVIEW_NOTE_WRITE_PENDING',
  })
  let note: { message_id: string }
  try {
    note = await client.createPrivateNote(event.conversation_id, result.review_note)
  } catch (error) {
    const outcome = classifyFailure(error, 'REVIEW_NOTE')
    await store.transition(event.event_id, 'writing', outcome.status, { stop_code: outcome.code })
    return
  }
  if (!DECIMAL.test(note.message_id)) {
    await store.transition(event.event_id, 'writing', 'uncertain', { stop_code: 'REVIEW_NOTE_RESULT_UNCERTAIN' })
    return
  }
  const desiredLabel: ChatwootOwnedOperationalLabel = result.case_file.next_action === 'human_handoff'
    ? 'proptimiza-human-handoff' : 'proptimiza-supervised-review'
  await store.transition(event.event_id, 'writing', 'labeling', {
    private_note_message_id: note.message_id,
    operational_label: desiredLabel,
    team_assigned: false,
    stop_code: 'OWNED_LABEL_MERGE_PENDING',
  })
  let observedOwnedLabelsSha256: string
  let currentOwnedLabels: readonly ChatwootOwnedOperationalLabel[]
  try {
    const observed = await client.ownedLabelState(event.conversation_id)
    const current = chatwootOwnedLabelsForSha256(observed.owned_labels_sha256)
    if (!current) {
      await store.transition(event.event_id, 'labeling', 'failed', { stop_code: 'OWNED_LABEL_STATE_UNKNOWN' })
      return
    }
    observedOwnedLabelsSha256 = observed.owned_labels_sha256
    currentOwnedLabels = current
  } catch (error) {
    const outcome = classifyLabelStateFailure(error)
    await store.transition(event.event_id, 'labeling', outcome.status, { stop_code: outcome.code })
    return
  }
  const targetDigest = chatwootOwnedLabelsSha256([desiredLabel])
  let ownedLabelsSha256 = targetDigest
  if (observedOwnedLabelsSha256 !== targetDigest) {
    try {
      const otherLabels = CHATWOOT_OWNED_OPERATIONAL_LABELS.filter(label => label !== desiredLabel)
      const receipt = await client.mergeOwnedLabels(event.conversation_id,
        currentOwnedLabels.includes(desiredLabel) ? [] : [desiredLabel],
        otherLabels.filter(label => currentOwnedLabels.includes(label)), observedOwnedLabelsSha256)
      if (receipt.owned_labels_sha256 !== targetDigest) {
        await store.transition(event.event_id, 'labeling', 'uncertain', {
          stop_code: 'OWNED_LABEL_MERGE_RESULT_UNCERTAIN',
        })
        return
      }
      ownedLabelsSha256 = receipt.owned_labels_sha256
    } catch (error) {
      const outcome = classifyLabelMutationFailure(error)
      await store.transition(event.event_id, 'labeling', outcome.status, { stop_code: outcome.code })
      return
    }
  }
  if (result.case_file.next_action !== 'human_handoff') {
    await store.transition(event.event_id, 'labeling', 'staged', {
      owned_labels_sha256: ownedLabelsSha256,
      stop_code: 'REVIEW_NOTE_STAGED_AND_LABELED',
    })
    return
  }
  await store.transition(event.event_id, 'labeling', 'assigning', {
    owned_labels_sha256: ownedLabelsSha256,
    stop_code: 'REVIEW_NOTE_LABELED_ASSIGNMENT_PENDING',
  })
  try {
    const assignment = await client.assignTeam(event.conversation_id, '1')
    if (assignment.team_id !== '1') {
      await store.transition(event.event_id, 'assigning', 'uncertain', {
        team_assigned: false,
        stop_code: 'HUMAN_HANDOFF_ASSIGNMENT_UNCERTAIN',
      })
      return
    }
  } catch (error) {
    const outcome = classifyAssignmentFailure(error)
    await store.transition(event.event_id, 'assigning', outcome.status, {
      team_assigned: false,
      stop_code: outcome.code,
    })
    return
  }
  await store.transition(event.event_id, 'assigning', 'staged', {
    team_assigned: true,
    stop_code: 'REVIEW_NOTE_STAGED_HANDOFF_ASSIGNED',
  })
}

export class SupervisedReviewService {
  private readonly store: SupervisedReviewStore
  private readonly client: ChatwootReviewClient
  private server: Server | undefined
  private working = false
  private stopping = false
  private fatal = false

  constructor(private readonly config: SupervisedReviewConfig) {
    validateConfig(config)
    this.store = new SupervisedReviewStore(config.stateFile)
    this.client = new ChatwootReviewClient({
      baseUrl: config.chatwootBaseUrl,
      accountId: config.accountId,
      inboxId: config.inboxId,
      readToken: () => readGroupSecretFile(config.reviewerTokenFile, config.expectedSecretGid),
      machineSecret: () => readGroupSecretFile(config.reviewerMachineSecretFile, config.expectedSecretGid),
    })
  }

  async start(): Promise<void> {
    await this.store.initialize()
    const [webhookSecret, reviewerToken, reviewerMachineSecret, gate, rawScope] = await Promise.all([
      readGroupSecretFile(this.config.webhookSecretFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.reviewerTokenFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.reviewerMachineSecretFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.pilotGateFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.pilotScopeFile, this.config.expectedSecretGid),
    ])
    if (webhookSecret.length < 32 || webhookSecret.length > 4096
      || reviewerToken.length < 24 || reviewerToken.length > 8192 || /\s/.test(reviewerToken)
      || reviewerMachineSecret.length < 32 || reviewerMachineSecret.length > 4096
      || reviewerMachineSecret === webhookSecret || reviewerToken === reviewerMachineSecret
      || reviewerToken === webhookSecret
      || !isValidSupervisedReviewGateValue(gate))
      throw new Error('SUPERVISED_REVIEW_STARTUP_SECRET_INVALID')
    const scope = parseSupervisedReviewScope(rawScope, this.config.accountId, this.config.inboxId)
    await this.resolveScopeFacts(scope)
    const pair = generateKeyPairSync('ed25519')
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const admission = createPlatformAdmission(platformConfig(this.config.accountId, this.config.inboxId), {
      resolveKey: request => ({ ...request, public_key_pem: publicKey }),
    })
    const adapter = createChatwootWebhookAdapter({
      admission,
      source: {
        deployment_id: 'chatwoot-production',
        connector_id: 'whatsapp-supervised-review',
        account_id: this.config.accountId,
        inbox_id: this.config.inboxId,
        principal_id: 'supervised-review',
      },
      webhookSecret: Buffer.from(webhookSecret, 'utf8'),
    })
    const ingress = createChatwootIngressHandler([{
      path: ROUTE,
      adapter,
      commit: async (_context, event) => {
        const receipt = await this.store.commit(event)
        if (receipt.outcome === 'inserted') this.kick()
        return receipt
      },
    }], { acknowledgeUnsupportedEvents: true })

    this.server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        const snapshot = this.store.snapshot()
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ status: this.fatal ? 'degraded' : this.stopping ? 'stopping' : 'ok', ...snapshot }))
        return
      }
      void ingress(request, response)
    })
    this.server.requestTimeout = 15_000
    this.server.headersTimeout = 5_000
    this.server.keepAliveTimeout = 2_000
    this.server.maxHeadersCount = 32
    await new Promise<void>((resolve, reject) => {
      const error = (reason: Error) => reject(reason)
      this.server!.once('error', error)
      this.server!.listen(this.config.port, this.config.bindHost, () => {
        this.server!.off('error', error)
        resolve()
      })
    })
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (!this.server) return
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()))
  }

  private kick(): void {
    if (this.working || this.stopping || this.fatal) return
    this.working = true
    void this.drain().catch(() => { this.fatal = true }).finally(() => { this.working = false })
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const event = await this.store.nextPending()
      if (!event) return
      try {
        const [gate, rawScope] = await Promise.all([
          readGroupSecretFile(this.config.pilotGateFile, this.config.expectedSecretGid),
          readGroupSecretFile(this.config.pilotScopeFile, this.config.expectedSecretGid),
        ])
        const scope = parseSupervisedReviewScope(rawScope, this.config.accountId, this.config.inboxId)
        const authorizedFacts = await this.resolveScopeFacts(scope)
        await processSupervisedReviewEvent(this.store, this.client, event,
          supervisedReviewGateAllowsStaging(gate), scope.conversation_ids.includes(event.conversation_id), authorizedFacts)
      } catch (error) {
        await this.failSafe(event.event_id, error)
      }
    }
  }

  private async resolveScopeFacts(scope: SupervisedReviewScope): Promise<readonly Readonly<CommercialFact>[]> {
    if (scope.authorized_fact_ids.length === 0) return Object.freeze([])
    const rawCatalog = await readGroupSecretFile(this.config.commercialFactCatalogFile, this.config.expectedSecretGid)
    const catalog = parseCommercialFactCatalog(rawCatalog)
    if (catalog.catalog_sha256 !== scope.commercial_fact_catalog_sha256)
      throw new Error('COMMERCIAL_FACT_CATALOG_BINDING_INVALID')
    return resolveCommercialFacts(catalog, scope.authorized_fact_ids)
  }

  private async failSafe(eventId: string, error: unknown): Promise<void> {
    const current = await this.store.get(eventId)
    if (!current || ['staged', 'held', 'failed', 'uncertain'].includes(current.status)) return
    if (current.status === 'pending') {
      try {
        await this.store.transition(eventId, 'pending', 'held', { stop_code: 'SUPERVISED_REVIEW_GATE_UNAVAILABLE' })
      } catch { /* A durable terminal state already owns the event. */ }
      return
    }
    const outcome = classifyFailure(error, 'SERVICE')
    const terminal = allowedTerminal(current.status, outcome.status)
    if (!terminal) return
    try { await this.store.transition(eventId, current.status, terminal, { stop_code: outcome.code }) }
    catch { /* A durable terminal state already owns the event. */ }
  }
}

export function isValidSupervisedReviewGateValue(value: string): boolean {
  return value === 'enabled' || value === 'disabled'
}

export function supervisedReviewGateAllowsStaging(value: string): boolean {
  return value === 'enabled'
}

export interface SupervisedReviewScope {
  scope_id: string
  conversation_ids: readonly string[]
  authorized_fact_ids: readonly string[]
  commercial_fact_catalog_sha256: string | null
  expires_at: string
}

export function parseSupervisedReviewScope(raw: string, accountId: string, inboxId: string,
  now: () => Date = () => new Date()): Readonly<SupervisedReviewScope> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('SUPERVISED_REVIEW_SCOPE_INVALID') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SUPERVISED_REVIEW_SCOPE_INVALID')
  const value = parsed as Record<string, unknown>
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== ['account_id', 'authorized_fact_ids', 'commercial_fact_catalog_sha256', 'conversation_ids',
    'expires_at', 'inbox_id', 'issued_at', 'schema', 'scope_id'].sort().join(',')
    || value.schema !== 'proptimiza-supervised-review-scope.v2'
    || typeof value.scope_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.scope_id)
    || value.account_id !== accountId || value.inbox_id !== inboxId
    || !Array.isArray(value.conversation_ids) || value.conversation_ids.length < 1 || value.conversation_ids.length > 10
    || value.conversation_ids.some(id => typeof id !== 'string' || !DECIMAL.test(id))
    || new Set(value.conversation_ids).size !== value.conversation_ids.length
    || !Array.isArray(value.authorized_fact_ids) || value.authorized_fact_ids.length > 24
    || value.authorized_fact_ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
    || new Set(value.authorized_fact_ids).size !== value.authorized_fact_ids.length
    || (value.authorized_fact_ids.length === 0
      ? value.commercial_fact_catalog_sha256 !== null
      : typeof value.commercial_fact_catalog_sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(value.commercial_fact_catalog_sha256))
    || typeof value.issued_at !== 'string' || typeof value.expires_at !== 'string')
    throw new Error('SUPERVISED_REVIEW_SCOPE_INVALID')
  const issued = Date.parse(value.issued_at as string)
  const expires = Date.parse(value.expires_at as string)
  const current = now()
  if (!(current instanceof Date) || !Number.isFinite(current.getTime()) || !Number.isFinite(issued) || !Number.isFinite(expires)
    || issued > current.getTime() + 60_000 || expires <= current.getTime() || expires - issued > 8 * 60 * 60 * 1000)
    throw new Error('SUPERVISED_REVIEW_SCOPE_INVALID')
  return Object.freeze({ scope_id: value.scope_id as string,
    conversation_ids: Object.freeze([...(value.conversation_ids as string[])]),
    authorized_fact_ids: Object.freeze([...(value.authorized_fact_ids as string[])]),
    commercial_fact_catalog_sha256: value.commercial_fact_catalog_sha256 as string | null,
    expires_at: value.expires_at as string })
}

function allowedTerminal(status: SupervisedReviewStatus, preferred: 'failed' | 'uncertain'): 'failed' | 'uncertain' | null {
  if (status === 'preparing' || status === 'writing') return preferred
  if (status === 'labeling' || status === 'assigning') return 'uncertain'
  return null
}

function classifyLabelStateFailure(error: unknown): { status: 'held' | 'failed'; code: string } {
  if (error instanceof ChatwootHttpError && error.status >= 400 && error.status < 500)
    return { status: 'held', code: `OWNED_LABEL_STATE_REJECTED_${error.status}` }
  const code = safeCode(error, 'OWNED_LABEL_STATE_READ_FAILED')
  return { status: 'failed', code: /INVALID|REJECTED|DENIED/.test(code) ? code : 'OWNED_LABEL_STATE_READ_FAILED' }
}

function classifyLabelMutationFailure(error: unknown): { status: 'held' | 'failed' | 'uncertain'; code: string } {
  if (error instanceof ChatwootHttpError && error.status >= 400 && error.status < 500)
    return { status: 'held', code: `OWNED_LABEL_MERGE_REJECTED_${error.status}` }
  const code = safeCode(error, 'OWNED_LABEL_MERGE_RESULT_UNCERTAIN')
  if (code === 'CHATWOOT_REVIEW_LABEL_RECEIPT_INVALID')
    return { status: 'uncertain', code: 'OWNED_LABEL_MERGE_RESULT_UNCERTAIN' }
  if (/INVALID|REJECTED|DENIED|UNKNOWN/.test(code)) return { status: 'failed', code }
  return { status: 'uncertain', code: 'OWNED_LABEL_MERGE_RESULT_UNCERTAIN' }
}

function classifyFailure(error: unknown, prefix: string): { status: 'failed' | 'uncertain'; code: string } {
  const httpStatus = error instanceof ChatwootHttpError ? error.status : null
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500)
    return { status: 'failed', code: `${prefix}_REJECTED_${httpStatus}` }
  const code = safeCode(error, `${prefix}_FAILED`)
  const deterministic = /INVALID|REJECTED|DENIED|UNSUPPORTED/.test(code)
  return { status: deterministic ? 'failed' : 'uncertain', code: deterministic ? code : `${prefix}_RESULT_UNCERTAIN` }
}

function classifyAssignmentFailure(error: unknown): { status: 'held' | 'uncertain'; code: string } {
  if (error instanceof ChatwootHttpError && error.status >= 400 && error.status < 500)
    return { status: 'held', code: `HUMAN_HANDOFF_ASSIGNMENT_REJECTED_${error.status}` }
  const code = safeCode(error, 'HUMAN_HANDOFF_ASSIGNMENT_UNCERTAIN')
  if (/INVALID|REJECTED|DENIED/.test(code)) return { status: 'held', code }
  return { status: 'uncertain', code: 'HUMAN_HANDOFF_ASSIGNMENT_UNCERTAIN' }
}

function platformConfig(accountId: string, inboxId: string) {
  return {
    schema_version: 'platform-config.v1',
    config_revision: 'supervised-review-v1',
    bindings: [{
      binding_id: 'proptimiza-supervised-review', tenant_id: 'proptimiza', project_id: 'proptimiza',
      project_version: 'v1', policy_version: 'supervised-review-v1', deployment_id: 'chatwoot-production',
      connector_id: 'whatsapp-supervised-review', account_id: accountId, inbox_id: inboxId, active: true,
      issuer: 'proptimiza-control-plane', audience: 'supervised-review',
      keys: [{ key_id: 'startup-only', algorithm: 'Ed25519',
        key_ref: 'keyref:v1:proptimiza:chatwoot-production:startup-only' }],
      principals: [{ principal_id: 'supervised-review', requested_by: 'whatsapp-supervised-review',
        key_ids: ['startup-only'], grant: {
          actions: ['conversation.review.prepare'], tools: [], channels: ['internal'], autonomy_levels: ['A0'],
          budget: { currency: 'USD', maximum: 0 },
        } }],
    }],
  }
}

function validateConfig(config: SupervisedReviewConfig): void {
  if (!config || typeof config !== 'object' || config.bindHost !== '0.0.0.0'
    || config.port !== 8788 || !DECIMAL.test(config.accountId) || !DECIMAL.test(config.inboxId)
    || config.handoffTeamId !== '1' || config.expectedSecretGid !== 10000
    || config.stateFile !== '/var/lib/proptimiza/supervised-review/state.json'
    || config.webhookSecretFile !== '/run/secrets/chatwoot_supervised_webhook_secret'
    || config.reviewerTokenFile !== '/run/secrets/chatwoot_reviewer_token'
    || config.reviewerMachineSecretFile !== '/run/secrets/proptimiza_chatwoot_review_ingress_secret'
    || config.pilotGateFile !== '/run/controls/supervised-review-enabled'
    || config.pilotScopeFile !== '/run/controls/supervised-review-scope.json'
    || config.commercialFactCatalogFile !== '/run/controls/commercial-fact-catalog.json'
    || config.chatwootBaseUrl !== 'http://proptimiza-chatwoot-web-1:3000')
    throw new Error('SUPERVISED_REVIEW_CONFIG_INVALID')
}

function safeCode(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : fallback
  return /^[A-Z][A-Z0-9_:-]{2,160}$/.test(value) ? value : fallback
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
