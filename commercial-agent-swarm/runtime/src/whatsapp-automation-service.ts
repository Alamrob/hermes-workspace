import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { createChatwootIngressHandler } from './comms/chatwoot-http.js'
import { ChatwootOutboundClient, ChatwootHttpError } from './comms/chatwoot-outbound.js'
import { createChatwootWebhookAdapter } from './comms/chatwoot-webhook.js'
import { liveBusinessContext } from './business/proptimiza-live-context.js'
import { applyConversationGuardrails } from './business/conversation-guardrails.js'
import { HermesConversationProcess } from './hermes-conversation-process.js'
import { conversationPricingSnapshotState } from './opencode-go-conversation-pricing.js'
import { NodeProcessRunner } from './hermes-executor.js'
import { createPlatformAdmission } from './platform/admission.js'
import { buildConversationTranscriptRequest, conversationAffinity } from './platform/conversation-request.js'
import { readGroupSecretFile } from './secret-file.js'
import { WhatsAppReplyStore, type ReplyEventRecord } from './whatsapp-automation-store.js'
import {
  automaticReplyResponseAllowed,
  decideAutomaticReplyPolicy,
  parseAutomaticReplyPolicy,
  type AutomaticReplyPolicy,
} from './automatic-reply-policy.js'

const ROUTE = '/webhooks/chatwoot/proptimiza'

export interface WhatsAppAutomationConfig {
  bindHost: string
  port: number
  accountId: string
  inboxId: string
  handoffTeamId: string
  stateFile: string
  webhookSecretFile: string
  agentBotTokenFile: string
  readerTokenFile: string
  openCodeKeyFile: string
  expectedSecretGid: number
  chatwootBaseUrl: string
  hermesPython: string
  hermesChildScript: string
  hermesCwd: string
  httpProxy: string
  noProxy: string
  childTimeoutSeconds: number
  maximumOutputTokens: number
  maximumTotalTokens: number
  maximumUsd: number
  killSwitchFile: string
  automaticReplyPolicyFile: string
}
export class WhatsAppAutomationService {
  private readonly store: WhatsAppReplyStore
  private readonly outbound: ChatwootOutboundClient
  private server: Server | undefined
  private working = false
  private stopping = false

  constructor(private readonly config: WhatsAppAutomationConfig) {
    validateConfig(config)
    this.store = new WhatsAppReplyStore(config.stateFile)
    this.outbound = new ChatwootOutboundClient({
      baseUrl: config.chatwootBaseUrl,
      accountId: config.accountId,
      inboxId: config.inboxId,
      readToken: () => readGroupSecretFile(config.readerTokenFile, config.expectedSecretGid),
      sendToken: () => readGroupSecretFile(config.agentBotTokenFile, config.expectedSecretGid),
      machineSecret: () => readGroupSecretFile(config.webhookSecretFile, config.expectedSecretGid),
    })
  }

  async start(): Promise<void> {
    await this.store.initialize()
    const [secret, botToken, readerToken, providerKey, replyGate, automaticReplyPolicy] = await Promise.all([
      readGroupSecretFile(this.config.webhookSecretFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.agentBotTokenFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.readerTokenFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.openCodeKeyFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.killSwitchFile, this.config.expectedSecretGid),
      readGroupSecretFile(this.config.automaticReplyPolicyFile, this.config.expectedSecretGid),
    ])
    if (secret.length < 32 || secret.length > 4096
      || botToken.length < 24 || botToken.length > 8192 || /\s/.test(botToken)
      || readerToken.length < 24 || readerToken.length > 8192 || /\s/.test(readerToken)
      || readerToken === botToken
      || providerKey.length < 16 || providerKey.length > 8192 || /\s/.test(providerKey)
      || !isValidReplyGateValue(replyGate)) throw new Error('WHATSAPP_AUTOMATION_STARTUP_SECRET_INVALID')
    const startupPolicy = parseAutomaticReplyPolicy(automaticReplyPolicy)
    if (startupPolicy.scope.account_id !== this.config.accountId
      || startupPolicy.scope.inbox_id !== this.config.inboxId)
      throw new Error('AUTOMATIC_REPLY_POLICY_SCOPE_MISMATCH')
    const pair = generateKeyPairSync('ed25519')
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const platform = productionPlatformConfig(this.config.accountId, this.config.inboxId)
    const admission = createPlatformAdmission(platform, { resolveKey: request => ({
      ...request,
      public_key_pem: publicKey,
    }) })
    const source = {
      deployment_id: 'chatwoot-production',
      connector_id: 'whatsapp-agentbot',
      account_id: this.config.accountId,
      inbox_id: this.config.inboxId,
      principal_id: 'hermes-conversation',
    }
    const adapter = createChatwootWebhookAdapter({
      admission,
      source,
      webhookSecret: Buffer.from(secret, 'utf8'),
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
        response.end(JSON.stringify({ status: this.stopping ? 'stopping' : 'ok',
          conversation_pricing_snapshot: conversationPricingSnapshotState(new Date()), ...snapshot }))
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
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()))
  }

  private kick(): void {
    if (this.working || this.stopping) return
    this.working = true
    void this.drain().finally(() => { this.working = false })
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const event = await this.store.nextPending()
      if (!event) return
      try { await this.process(event) }
      catch (error) {
        const code = safeCode(error)
        const current = await this.store.get(event.event_id)
        if (current && ['pending', 'model_running', 'ready', 'sending'].includes(current.status)) {
          const uncertain = current.status === 'sending' || code.uncertain
          try { await this.store.transition(event.event_id, current.status, uncertain ? 'uncertain' : 'failed', { stop_code: code.code }) }
          catch { /* A later durable state already owns the result. */ }
        }
      }
    }
  }

  private async process(event: Readonly<ReplyEventRecord>): Promise<void> {
    const priorHold = await this.store.conversationHoldReason(event.conversation_id)
    if (priorHold) {
      await this.store.transition(event.event_id, 'pending', 'held', { stop_code: 'CONVERSATION_REQUIRES_HUMAN' })
      return
    }
    if (!(await this.replyGateAllows())) {
      await this.store.transition(event.event_id, 'pending', 'held', { stop_code: 'AUTOMATION_KILL_SWITCH_ACTIVE' })
      return
    }
    const entryPolicy = await this.automaticReplyPolicyDecision(event.account_id, event.inbox_id)
    if (!entryPolicy.allowed || entryPolicy.policy === null) {
      await this.store.transition(event.event_id, 'pending', 'held', { stop_code: entryPolicy.stop_code })
      return
    }
    const sentSince = new Date(Date.now() - 24 * 60 * 60 * 1000)
    if (await this.store.automatedReplyCountSince(event.conversation_id, sentSince)
      >= entryPolicy.policy.runtime_contract.maximum_automated_replies_per_conversation_per_24h) {
      await this.store.transition(event.event_id, 'pending', 'held', {
        stop_code: 'AUTOMATIC_REPLY_DAILY_LIMIT_REACHED',
      })
      return
    }
    const first = await this.outbound.snapshot(event.conversation_id, event.message_id, event.content_sha256)
    if (!first.current || first.human_replied) {
      await this.store.transition(event.event_id, 'pending', 'held', {
        stop_code: first.human_replied ? 'HUMAN_REPLY_OBSERVED' : 'NEWER_MESSAGE_OBSERVED',
      })
      return
    }
    await this.store.transition(event.event_id, 'pending', 'model_running')
    const reply = applyConversationGuardrails(first.target.content, await this.infer(event, first.transcript), first.transcript)
    if (!automaticReplyResponseAllowed(reply.response, entryPolicy.policy)) {
      await this.store.transition(event.event_id, 'model_running', 'held', {
        response_sha256: digest(reply.response),
        handoff_reason: reply.handoff_reason,
        stop_code: 'AUTOMATIC_REPLY_RESPONSE_POLICY_REJECTED',
      })
      return
    }
    await this.store.transition(event.event_id, 'model_running', 'ready', {
      response_sha256: digest(reply.response),
      handoff_reason: reply.handoff_reason,
      stop_code: 'MODEL_COMPLETED',
    })
    if (!(await this.replyGateAllows())) {
      await this.store.transition(event.event_id, 'ready', 'held', { stop_code: 'AUTOMATION_KILL_SWITCH_ACTIVE' })
      return
    }
    const sendPolicy = await this.automaticReplyPolicyDecision(event.account_id, event.inbox_id)
    if (!sendPolicy.allowed || sendPolicy.policy === null) {
      await this.store.transition(event.event_id, 'ready', 'held', { stop_code: sendPolicy.stop_code })
      return
    }
    if (!automaticReplyResponseAllowed(reply.response, sendPolicy.policy)) {
      await this.store.transition(event.event_id, 'ready', 'held', {
        stop_code: 'AUTOMATIC_REPLY_RESPONSE_POLICY_REJECTED',
      })
      return
    }
    if (await this.store.automatedReplyCountSince(event.conversation_id, new Date(Date.now() - 24 * 60 * 60 * 1000))
      >= sendPolicy.policy.runtime_contract.maximum_automated_replies_per_conversation_per_24h) {
      await this.store.transition(event.event_id, 'ready', 'held', {
        stop_code: 'AUTOMATIC_REPLY_DAILY_LIMIT_REACHED',
      })
      return
    }
    const current = await this.outbound.snapshot(event.conversation_id, event.message_id, event.content_sha256)
    if (!current.current || current.human_replied) {
      await this.store.transition(event.event_id, 'ready', 'held', {
        stop_code: current.human_replied ? 'HUMAN_REPLY_OBSERVED' : 'NEWER_MESSAGE_OBSERVED',
      })
      return
    }
    if (!(await this.replyGateAllows())) {
      await this.store.transition(event.event_id, 'ready', 'held', { stop_code: 'AUTOMATION_KILL_SWITCH_ACTIVE' })
      return
    }
    const finalPolicy = await this.automaticReplyPolicyDecision(event.account_id, event.inbox_id)
    if (!finalPolicy.allowed || finalPolicy.policy === null) {
      await this.store.transition(event.event_id, 'ready', 'held', { stop_code: finalPolicy.stop_code })
      return
    }
    if (!automaticReplyResponseAllowed(reply.response, finalPolicy.policy)) {
      await this.store.transition(event.event_id, 'ready', 'held', {
        stop_code: 'AUTOMATIC_REPLY_RESPONSE_POLICY_REJECTED',
      })
      return
    }
    if (await this.store.automatedReplyCountSince(event.conversation_id, new Date(Date.now() - 24 * 60 * 60 * 1000))
      >= finalPolicy.policy.runtime_contract.maximum_automated_replies_per_conversation_per_24h) {
      await this.store.transition(event.event_id, 'ready', 'held', {
        stop_code: 'AUTOMATIC_REPLY_DAILY_LIMIT_REACHED',
      })
      return
    }
    await this.store.transition(event.event_id, 'ready', 'sending')
    await this.deliver(event, reply)
  }

  private async replyGateAllows(): Promise<boolean> {
    return killSwitchAllows(this.config.killSwitchFile, this.config.expectedSecretGid)
  }

  private async automaticReplyPolicyDecision(accountId: string, inboxId: string): Promise<{
    allowed: boolean
    stop_code: string
    policy: Readonly<AutomaticReplyPolicy> | null
  }> {
    return loadAutomaticReplyPolicyDecision(this.config, accountId, inboxId)
  }

  private async deliver(event: Readonly<ReplyEventRecord>, reply: {
    response: string; handoff_reason: string
  }): Promise<void> {
    let sent: { message_id: string }
    try {
      sent = await this.outbound.send(event.conversation_id, reply.response)
    } catch (error) {
      const known = error instanceof ChatwootHttpError && error.status >= 400 && error.status < 500
      await this.store.transition(event.event_id, 'sending', known ? 'failed' : 'uncertain', {
        stop_code: known ? `CHATWOOT_REJECTED_${error.status}` : 'CHATWOOT_SEND_UNCERTAIN',
      })
      return
    }
    if (reply.handoff_reason === 'none') {
      await this.store.transition(event.event_id, 'sending', 'sent', {
        outbound_message_id: sent.message_id,
        stop_code: 'REPLY_SENT',
      })
      return
    }
    try {
      await this.outbound.assignTeam(event.conversation_id, this.config.handoffTeamId)
      await this.store.transition(event.event_id, 'sending', 'sent', {
        outbound_message_id: sent.message_id,
        stop_code: 'REPLY_SENT_HANDOFF_ASSIGNED',
      })
    } catch (error) {
      const known = error instanceof ChatwootHttpError && error.status >= 400 && error.status < 500
      await this.store.transition(event.event_id, 'sending', 'held', {
        outbound_message_id: sent.message_id,
        stop_code: known ? `REPLY_SENT_HANDOFF_ASSIGNMENT_REJECTED_${error.status}`
          : 'REPLY_SENT_HANDOFF_ASSIGNMENT_UNCERTAIN',
      })
    }
  }

  private async infer(event: Readonly<ReplyEventRecord>, transcript: ReadonlyArray<{
    message_id: string; sequence: number; kind: 'incoming' | 'assistant'; content: string
  }>): Promise<{ response: string; handoff_reason: string }> {
    const context = liveBusinessContext()
    const scope = conversationAffinity({
      tenant_id: 'proptimiza',
      deployment_id: 'chatwoot-production',
      connector_id: 'whatsapp-agentbot',
      binding_id: 'proptimiza-whatsapp-live',
      account_id: event.account_id,
      inbox_id: event.inbox_id,
      conversation_id: event.conversation_id,
      conversation_generation: randomUUID(),
    })
    const request = buildConversationTranscriptRequest({
      scope,
      contextJson: context.json,
      contextHash: context.sha256,
      messages: transcript.map((message) => ({ ...message })),
      maximumOutputTokens: this.config.maximumOutputTokens,
      timeoutSeconds: this.config.childTimeoutSeconds,
      nowSeconds: Math.floor(Date.now() / 1000),
    })
    const apiKey = await readGroupSecretFile(this.config.openCodeKeyFile, this.config.expectedSecretGid)
    const processRunner = new HermesConversationProcess(new NodeProcessRunner(), {
      command: this.config.hermesPython,
      args: ['-I', '-B', this.config.hermesChildScript],
      env: {
        PATH: '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin',
        HOME: '/tmp',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED: '1',
        OPENCODE_GO_API_KEY: apiKey,
        HTTP_PROXY: this.config.httpProxy,
        HTTPS_PROXY: this.config.httpProxy,
        NO_PROXY: this.config.noProxy,
      },
      uid: process.getuid?.() ?? 10000,
      gid: process.getgid?.() ?? 10000,
      shell: false,
      detached: true,
      cwd: this.config.hermesCwd,
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.childTimeoutSeconds * 1000)
    try {
      const result = await processRunner.run(request.request_json, {
        signal: controller.signal,
        leaseLive: () => !controller.signal.aborted,
        maximumTokens: this.config.maximumTotalTokens,
        maximumUsd: this.config.maximumUsd,
      })
      if (result.executionState !== 'finished' || result.stopCode !== null || !result.reply
        || result.reply.send_permitted !== false || typeof result.reply.response !== 'string'
        || typeof result.reply.handoff_reason !== 'string') throw new Error(result.stopCode ?? 'HERMES_REPLY_INVALID')
      return { response: result.reply.response, handoff_reason: result.reply.handoff_reason }
    } finally {
      clearTimeout(timeout)
    }
  }
}

async function killSwitchAllows(path: string, expectedGid: number): Promise<boolean> {
  try { return replyGateAllowsReplies(await readGroupSecretFile(path, expectedGid)) } catch { return false }
}

async function loadAutomaticReplyPolicyDecision(
  config: Readonly<WhatsAppAutomationConfig>,
  accountId: string,
  inboxId: string,
): Promise<{
  allowed: boolean
  stop_code: string
  policy: Readonly<AutomaticReplyPolicy> | null
}> {
  try {
    const policy = parseAutomaticReplyPolicy(await readGroupSecretFile(
      config.automaticReplyPolicyFile,
      config.expectedSecretGid,
    ))
    return decideAutomaticReplyPolicy(policy, accountId, inboxId)
  } catch {
    return Object.freeze({
      allowed: false,
      stop_code: 'AUTOMATIC_REPLY_POLICY_INVALID',
      policy: null,
    })
  }
}

export function isValidReplyGateValue(value: string): boolean {
  return value === 'enabled' || value === 'disabled'
}

export function replyGateAllowsReplies(value: string): boolean {
  return value === 'enabled'
}

function productionPlatformConfig(accountId: string, inboxId: string) {
  return {
    schema_version: 'platform-config.v1',
    config_revision: 'whatsapp-live-v1',
    bindings: [{
      binding_id: 'proptimiza-whatsapp-live', tenant_id: 'proptimiza', project_id: 'proptimiza',
      project_version: 'v1', policy_version: 'whatsapp-inbound-v1', deployment_id: 'chatwoot-production',
      connector_id: 'whatsapp-agentbot', account_id: accountId, inbox_id: inboxId, active: true,
      issuer: 'proptimiza-control-plane', audience: 'whatsapp-automation',
      keys: [{ key_id: 'startup-only', algorithm: 'Ed25519', key_ref: 'keyref:v1:proptimiza:chatwoot-production:startup-only' }],
      principals: [{ principal_id: 'hermes-conversation', requested_by: 'whatsapp-agentbot', key_ids: ['startup-only'], grant: {
        actions: ['conversation.model.prepare'], tools: [], channels: ['internal'], autonomy_levels: ['A1'],
        budget: { currency: 'USD', maximum: 0.05 },
      } }],
    }],
  }
}

function validateConfig(config: WhatsAppAutomationConfig): void {
  if (!config || typeof config !== 'object' || config.bindHost !== '0.0.0.0'
    || !Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535
    || !/^[1-9][0-9]{0,18}$/.test(config.accountId) || !/^[1-9][0-9]{0,18}$/.test(config.inboxId)
    || config.handoffTeamId !== '1'
    || config.expectedSecretGid !== 10000 || config.hermesCwd !== '/tmp'
    || config.httpProxy !== 'http://egress-proxy:3128'
    || config.noProxy !== 'proptimiza-chatwoot-web-1,localhost,127.0.0.1'
    || config.automaticReplyPolicyFile !== '/run/controls/whatsapp-automatic-reply-policy.json'
    || !Number.isSafeInteger(config.childTimeoutSeconds) || config.childTimeoutSeconds < 10 || config.childTimeoutSeconds > 300
    || !Number.isSafeInteger(config.maximumOutputTokens) || config.maximumOutputTokens < 64 || config.maximumOutputTokens > 2000
    || config.maximumTotalTokens !== 8192 || config.maximumTotalTokens < config.maximumOutputTokens
    || !Number.isFinite(config.maximumUsd) || config.maximumUsd < 0.01 || config.maximumUsd > 0.1)
    throw new Error('WHATSAPP_AUTOMATION_CONFIG_INVALID')
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function safeCode(error: unknown): { code: string; uncertain: boolean } {
  const raw = error instanceof Error ? error.message : 'WHATSAPP_AUTOMATION_FAILED'
  const code = /^[A-Z][A-Z0-9_:-]{2,128}$/.test(raw) ? raw : 'WHATSAPP_AUTOMATION_FAILED'
  return { code, uncertain: !/INVALID|REJECTED|DENIED|NOT_STARTED|EXPIRED/.test(code) }
}
