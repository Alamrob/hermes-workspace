import { createHash } from 'node:crypto'
import { validateHermesUsage, type ConversationTrustedUsage, type TrustedUsage } from './executor-contract.js'
import { assertConversationPricingPreflight, priceConversationUsage } from './opencode-go-conversation-pricing.js'
import { type ProcessInvocation, type ProcessRunner } from './hermes-executor.js'

const SCHEMA = 'proptimiza-conversation-child.v1'
type RecordValue = Record<string, any>

function childFailureCode(code: unknown): string {
  if (code === 'HERMES_CONVERSATION_INPUT_INVALID') return 'HERMES_CHILD_INPUT_REJECTED'
  if (code === 'HERMES_CONVERSATION_MODEL_FAILED') return 'HERMES_CHILD_MODEL_REJECTED'
  if (['HERMES_CONVERSATION_CHILD_FAILED', 'HERMES_CONVERSATION_EXECUTION_FAILED'].includes(String(code)))
    return 'HERMES_CHILD_EXECUTION_REJECTED'
  if (['HERMES_CONVERSATION_ATTEMPT_INVALID', 'HERMES_CONVERSATION_RESULT_INVALID',
    'HERMES_CONVERSATION_CLEANUP_FAILED'].includes(String(code))) return 'HERMES_CHILD_RESULT_REJECTED'
  if (['HERMES_CONVERSATION_CLIENT_DENIED', 'HERMES_CONVERSATION_REQUEST_DENIED',
    'HERMES_CONVERSATION_REPLAY_DENIED'].includes(String(code))) return 'HERMES_CHILD_TRANSPORT_REJECTED'
  if (code === 'HERMES_CONVERSATION_LEASE_EXPIRED') return code
  return 'HERMES_CONVERSATION_CHILD_REJECTED'
}

export interface ConversationProcessResult {
  executionState: 'not_started' | 'unknown' | 'finished'
  reply: RecordValue | null
  usage: ConversationTrustedUsage | TrustedUsage | null
  usageRecordId: string | null
  stopCode: string | null
  sendPermitted: false
}
export interface ConversationProcessPermit {
  signal: AbortSignal
  leaseLive: () => boolean
  maximumTokens: number
  maximumUsd: number
}
function closed(value: unknown, keys: string[]): asserts value is RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw Error('PROTOCOL_INVALID')
}
function parse(raw: string, maximum: number): RecordValue {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) throw Error('PROTOCOL_INVALID')
  const value = JSON.parse(raw)
  // The child writes compact JSON. Round-trip rejects duplicate keys, banners,
  // non-finite numbers and alternate encodings without a permissive extractor.
  if (JSON.stringify(value) !== raw) throw Error('PROTOCOL_INVALID')
  return value
}
function requestBinding(raw: string) {
  const r = parse(raw, 131072)
  closed(r, ['schema', 'scope', 'context_json', 'context_sha256', 'transcript',
    'turn_sha256', 'maximum_output_tokens', 'timeout_seconds'])
  closed(r.scope, ['schema', 'source', 'gateway_session_key'])
  if (r.schema !== SCHEMA || r.scope.schema !== 'proptimiza-hermes-affinity.v1' ||
      r.scope.source !== 'proptimiza-whatsapp' || !/^pcw1_[0-9a-f]{64}$/.test(r.scope.gateway_session_key) ||
      !/^[0-9a-f]{64}$/.test(r.turn_sha256) || !/^[0-9a-f]{64}$/.test(r.context_sha256) ||
      typeof r.context_json !== 'string' || Buffer.byteLength(r.context_json) > 8192 ||
      createHash('sha256').update(r.context_json).digest('hex') !== r.context_sha256 ||
      !Number.isSafeInteger(r.maximum_output_tokens) || r.maximum_output_tokens < 1 || r.maximum_output_tokens > 8192 ||
      !Number.isSafeInteger(r.timeout_seconds) || r.timeout_seconds < 1 || r.timeout_seconds > 600) throw Error('PROTOCOL_INVALID')
  const context = parse(r.context_json, 8192)
  closed(context, ['schema', 'revision', 'valid_from', 'valid_until', 'facts'])
  if (!Array.isArray(context.facts) || !context.facts.length || context.facts.length > 24) throw Error('PROTOCOL_INVALID')
  const factIds = context.facts.map(f => {
    closed(f, ['id', 'text'])
    if (typeof f.id !== 'string') throw Error('PROTOCOL_INVALID')
    return f.id
  })
  closed(r.transcript, ['schema', 'scope', 'messages'])
  if (!Array.isArray(r.transcript.messages) || !r.transcript.messages.length || r.transcript.messages.length > 20)
    throw Error('PROTOCOL_INVALID')
  const last = r.transcript.messages.at(-1)
  if (typeof last?.message_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(last.message_id)) throw Error('PROTOCOL_INVALID')
  return { key: r.scope.gateway_session_key, message: last.message_id, turn: r.turn_sha256,
    context: r.context_sha256, factIds, timeoutMs: r.timeout_seconds * 1000, maximumOutputTokens: r.maximum_output_tokens }
}

/** Low-level transport, not an admission endpoint. Existing profile/IPC gates
 * stay unchanged. Its trusted caller must own the immutable program/home/env,
 * durable reservation and lease-to-AbortSignal binding before calling run. */
export class HermesConversationProcess {
  private consumed = false
  private readonly invocation: Omit<ProcessInvocation, 'stdin' | 'signal' | 'timeoutMs' | 'stdoutLimitBytes' | 'stderrLimitBytes'>
  constructor(private readonly runner: ProcessRunner,
    invocation: Omit<ProcessInvocation, 'stdin' | 'signal' | 'timeoutMs' | 'stdoutLimitBytes' | 'stderrLimitBytes'>,
    private readonly clock: () => Date = () => new Date()) {
    this.invocation = { ...invocation, args: [...invocation.args], env: { ...invocation.env } }
  }

  async run(requestJson: string, permit: ConversationProcessPermit): Promise<ConversationProcessResult> {
    if (this.consumed) throw Error('HERMES_CONVERSATION_PROCESS_CONSUMED')
    this.consumed = true
    const result: ConversationProcessResult = { executionState: 'not_started', reply: null,
      usage: null, usageRecordId: null, stopCode: null, sendPermitted: false }
    const deny = (code: string) => { result.reply = null; result.stopCode = code; return result }
    let binding, signal: AbortSignal, leaseLive: () => boolean
    let reservation: { maximum_tokens: number; maximum_api_calls: number; budget_reservation: { currency: 'USD'; amount: number } }
    try {
      binding = requestBinding(requestJson)
      signal = permit.signal
      leaseLive = permit.leaseLive
      reservation = { maximum_tokens: permit.maximumTokens, maximum_api_calls: 1,
        budget_reservation: { currency: 'USD' as const, amount: permit.maximumUsd } }
      if (!(signal instanceof AbortSignal) || typeof leaseLive !== 'function' ||
          !Number.isSafeInteger(reservation.maximum_tokens) || reservation.maximum_tokens < binding.maximumOutputTokens)
        throw Error('PERMIT_INVALID')
      assertConversationPricingPreflight(reservation, this.clock())
    } catch (error) {
      return deny(error instanceof Error && error.message === 'OPENCODE_GO_CONVERSATION_PRICING_REVALIDATION_REQUIRED'
        ? 'HERMES_CONVERSATION_PRICING_EXPIRED' : 'HERMES_CONVERSATION_INPUT_INVALID')
    }
    let revoked = false
    const live = () => {
      try { revoked ||= signal.aborted || leaseLive() !== true } catch { revoked = true }
      return !revoked
    }
    if (!live()) return deny('HERMES_CONVERSATION_LEASE_EXPIRED')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const poll = setInterval(() => { if (!live()) abort() }, 25)
    try {
      // Copy trusted invocation fields before yielding to the process runner.
      const invocation = { ...this.invocation, args: [...this.invocation.args], env: { ...this.invocation.env },
        stdin: requestJson, signal: controller.signal, timeoutMs: binding.timeoutMs,
        stdoutLimitBytes: 32768, stderrLimitBytes: 1024 }
      if (!live()) return deny('HERMES_CONVERSATION_LEASE_EXPIRED')
      result.executionState = 'unknown'
      const output = await this.runner.run(invocation)
      if (output.timedOut || output.cancelled || output.exitCode !== 0)
        return deny(output.cancelled ? 'HERMES_CONVERSATION_CANCELLED' : 'HERMES_CONVERSATION_PROCESS_FAILED')
      if (!output.stdout.endsWith('\n')) return deny('HERMES_CONVERSATION_PROTOCOL_INVALID')
      const value = parse(output.stdout.slice(0, -1), 32768)
      closed(value, ['schema', 'status', 'execution_state', 'reply', 'native_usage_json', 'stop_code', 'transport_attempts'])
      if (value.schema !== SCHEMA || !['completed', 'failed'].includes(value.status) ||
          !['not_started', 'unknown', 'finished'].includes(value.execution_state) ||
          !Number.isInteger(value.transport_attempts) || value.transport_attempts < 0 || value.transport_attempts > 1 ||
          (value.execution_state === 'not_started' && value.transport_attempts !== 0)) throw Error('PROTOCOL_INVALID')
      result.executionState = value.execution_state
      if (value.native_usage_json !== null) {
        if (value.execution_state !== 'finished' || value.transport_attempts !== 1) throw Error('PROTOCOL_INVALID')
        // Native usage export is not required to use this stdio JSON encoding.
        if (typeof value.native_usage_json !== 'string' || Buffer.byteLength(value.native_usage_json) > 8192) throw Error('USAGE_INVALID')
        const nativeUsage = JSON.parse(value.native_usage_json)
        const trustedUsage = validateHermesUsage(nativeUsage, reservation, 'glm-5.3-flash')
        result.usage = priceConversationUsage(trustedUsage, this.clock())
        if (typeof nativeUsage.session_id === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(nativeUsage.session_id))
          result.usageRecordId = `opencode-session:${nativeUsage.session_id}`
      }
      if (!live()) return deny('HERMES_CONVERSATION_LEASE_EXPIRED')
      if (value.status !== 'completed') return deny(childFailureCode(value.stop_code))
      if (value.stop_code !== null || value.execution_state !== 'finished' || value.transport_attempts !== 1 || !result.usage)
        throw Error('PROTOCOL_INVALID')
      const reply = value.reply
      try { closed(reply, ['conversation_key', 'last_message_id', 'turn_sha256', 'context_sha256',
        'response', 'fact_ids', 'handoff_reason', 'send_permitted']) }
      catch { return deny('HERMES_CONVERSATION_REPLY_INVALID') }
      if (reply.conversation_key !== binding.key || reply.last_message_id !== binding.message ||
          reply.turn_sha256 !== binding.turn || reply.context_sha256 !== binding.context || reply.send_permitted !== false ||
          typeof reply.response !== 'string' || !reply.response.trim() || reply.response.includes('\0') ||
          Buffer.from(reply.response, 'utf8').toString('utf8') !== reply.response ||
          Buffer.byteLength(reply.response) > 2000 || !Array.isArray(reply.fact_ids) ||
          new Set(reply.fact_ids).size !== reply.fact_ids.length || reply.fact_ids.some(id => !binding.factIds.includes(id)) ||
          !['none', 'missing_context', 'human_requested', 'sensitive_request', 'out_of_scope'].includes(reply.handoff_reason))
        return deny('HERMES_CONVERSATION_REPLY_INVALID')
      if (result.usage.tokens.total > reservation.maximum_tokens || result.usage.api_calls > 1 ||
          result.usage.cost.status !== 'known' || result.usage.cost.usage_value_usd > reservation.budget_reservation.amount)
        return deny('HERMES_CONVERSATION_BUDGET_EXCEEDED')
      result.reply = reply
      return live() ? result : deny('HERMES_CONVERSATION_LEASE_EXPIRED')
    } catch { return deny('HERMES_CONVERSATION_PROTOCOL_INVALID') }
    finally { clearInterval(poll); signal.removeEventListener('abort', abort) }
  }
}
