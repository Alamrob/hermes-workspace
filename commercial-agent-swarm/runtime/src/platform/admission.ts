import { createHash, createPublicKey } from 'node:crypto'
import { canonicalJson } from '../canonical.js'
import { verifyWorkOrderForProject } from '../security.js'
import { validateWorkOrder } from '../work-orders.js'
import { sourceTuple, validateAuthenticatedSource, validatePlatformConfig } from './config.js'
import type { DeepReadonly, PlatformAdmission, PlatformBinding, PlatformContext, PlatformKeyRequest, PlatformPrincipal } from './types.js'
import { closed, deny, freezeDeep, snapshotJson, string } from './validation.js'

interface ResolvedBinding {
  binding: DeepReadonly<PlatformBinding>
  publicKeys: Record<string, string>
}
interface ContextOwner extends ResolvedBinding {
  principal: DeepReadonly<PlatformPrincipal>
}
export interface PlatformAdmissionDependencies {
  /** Trusted, synchronous key-store adapter. Called only at startup, never with payload data. */
  resolveKey(request: DeepReadonly<PlatformKeyRequest>): unknown
  now?: () => Date
}
/** An internal admission boundary, with no HTTP listener, persistence or execution side effects. */
export function createPlatformAdmission(input: unknown, dependencies: PlatformAdmissionDependencies): PlatformAdmission {
  const config = validatePlatformConfig(input)
  const configHash = createHash('sha256').update(canonicalJson(config)).digest('hex')
  const resolveKey = dependencies.resolveKey
  const clock = dependencies.now ?? (() => new Date())
  if (typeof resolveKey !== 'function' || typeof clock !== 'function') deny('INVALID_PLATFORM_DEPENDENCIES')
  const fingerprints = new Map<string, string>()
  const keyCache = new Map<string, string>()
  const resolved = new Map<string, ResolvedBinding>()
  // Eager snapshots prevent a mutable resolver/keyring from changing authority after startup.
  for (const binding of config.bindings) {
    const publicKeys = Object.create(null) as Record<string, string>
    for (const reference of binding.keys) {
      const request = freezeDeep({ ...reference, tenant_id: binding.tenant_id, deployment_id: binding.deployment_id })
      const cacheId = canonicalJson(request)
      let publicKey = keyCache.get(cacheId)
      if (!publicKey) {
        let raw: unknown
        try { raw = resolveKey(request) } catch { deny('INVALID_KEY_MATERIAL') }
        const key = closed(snapshotJson(raw, 'INVALID_KEY_MATERIAL'), ['tenant_id', 'deployment_id', 'key_id', 'key_ref', 'algorithm', 'public_key_pem'], 'INVALID_KEY_MATERIAL')
        for (const field of ['tenant_id', 'deployment_id', 'key_id', 'key_ref', 'algorithm'] as const) {
          if (key[field] !== request[field]) deny('KEY_SCOPE_MISMATCH')
        }
        if (typeof key.public_key_pem !== 'string' || key.public_key_pem.length > 16384) deny('INVALID_KEY_MATERIAL')
        if (!key.public_key_pem.startsWith('-----BEGIN PUBLIC KEY-----') || key.public_key_pem.includes('PRIVATE KEY')) deny('INVALID_KEY_MATERIAL')
        try {
          const parsed = createPublicKey(key.public_key_pem)
          if (parsed.asymmetricKeyType !== 'ed25519') deny('INVALID_KEY_MATERIAL')
          const fingerprint = createHash('sha256').update(parsed.export({ format: 'der', type: 'spki' })).digest('hex')
          const scope = JSON.stringify([binding.tenant_id, binding.deployment_id])
          if (fingerprints.has(fingerprint) && fingerprints.get(fingerprint) !== scope) deny('KEY_SCOPE_MISMATCH')
          fingerprints.set(fingerprint, scope)
          publicKey = parsed.export({ format: 'pem', type: 'spki' }).toString()
        } catch (error) {
          if (error instanceof Error && error.message === 'KEY_SCOPE_MISMATCH') throw error
          deny('INVALID_KEY_MATERIAL')
        }
        keyCache.set(cacheId, publicKey)
      }
      publicKeys[reference.key_id] = publicKey
    }
    resolved.set(sourceTuple(binding), { binding, publicKeys: Object.freeze(publicKeys) })
  }

  const owners = new WeakMap<object, ContextOwner>()
  function ownerOf(context: unknown): ContextOwner {
    if (context === null || typeof context !== 'object') deny('INVALID_PLATFORM_CONTEXT')
    const owner = owners.get(context)
    if (!owner) deny('INVALID_PLATFORM_CONTEXT')
    return owner
  }

  return Object.freeze({
    resolveAuthenticatedContext(input: unknown): DeepReadonly<PlatformContext> {
      const source = validateAuthenticatedSource(input)
      const selected = resolved.get(sourceTuple(source))
      if (!selected) deny('BINDING_NOT_FOUND')
      const { binding } = selected
      if (!binding.active) deny('BINDING_INACTIVE')
      const principal = binding.principals.find(entry => entry.principal_id === source.principal_id)
      if (!principal) deny('PRINCIPAL_NOT_GRANTED')
      const context: PlatformContext = {
        schema_version: 'platform-context.v1', config_revision: config.config_revision, config_hash: configHash,
        binding_id: binding.binding_id, tenant_id: binding.tenant_id,
        project_id: binding.project_id, project_version: binding.project_version, policy_version: binding.policy_version,
        ...source,
      }
      freezeDeep(context)
      owners.set(context, { ...selected, principal })
      return context
    },

    admitWorkOrder(context: unknown, payload: unknown) {
      const { binding, principal, publicKeys } = ownerOf(context)
      const order = validateWorkOrder(snapshotJson(payload, 'INVALID_WORK_ORDER_JSON'))
      // validateWorkOrder handles the legacy shape; this boundary also rejects calendar overflow.
      if (!strictTimestamp(order.created_at) || !strictTimestamp(order.expires_at)) deny('INVALID_AUTHORITY_TIME')
      let now: Date
      try { now = clock() } catch { deny('INVALID_AUTHORITY_TIME') }
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) deny('INVALID_AUTHORITY_TIME')
      const authority = order.authority as Record<string, string>
      if (authority.algorithm !== 'Ed25519' || !principal.key_ids.includes(authority.key_id)) deny('PRINCIPAL_KEY_NOT_GRANTED')
      verifyWorkOrderForProject(order, {
        issuer: binding.issuer, audience: binding.audience, keys: {}, ed25519PublicKeys: publicKeys,
      }, new Date(now.getTime()), binding.project_id)
      if (order.project_version !== binding.project_version || order.policy_version !== binding.policy_version) deny('INCOMPATIBLE_BINDING')
      if (order.requested_by !== principal.requested_by) deny('PRINCIPAL_MISMATCH')
      const contact = order.contact_policy as Record<string, unknown>
      const volume = order.volume_limits as Record<string, unknown>
      // F1 prepares drafts only. This is not an action execution permit or a new autonomy policy.
      if (!order.dry_run || contact.contact_permitted !== false || volume.maximum_external_actions !== 0 || order.autonomy_level === 'A3' || order.autonomy_level === 'A4') deny('FOUNDATION_DRAFT_ONLY')
      const grant = principal.grant
      const budget = order.budget_limit as { currency: string; maximum: number }
      if (!grant.autonomy_levels.includes(order.autonomy_level) || budget.currency !== grant.budget.currency || budget.maximum > grant.budget.maximum) deny('INSUFFICIENT_GRANT')
      const subset = (requested: unknown, permitted: readonly string[]) => (requested as string[]).every(value => permitted.includes(value))
      if (!subset(order.allowed_actions, grant.actions) || !subset(order.approved_tools, grant.tools) || !subset(order.approved_channels, grant.channels)) deny('INSUFFICIENT_GRANT')
      if ((order.allowed_actions as string[]).some(action => (order.prohibited_actions as string[]).includes(action))) deny('CONFLICTING_ACTIONS')
      return freezeDeep({
        schema_version: 'platform-admission.v1' as const,
        context: context as PlatformContext,
        work_order: order,
      })
    },

    namespaceExternalId(context: unknown, kind: 'conversation' | 'message' | 'event' | 'idempotency', externalId: string): string {
      const { binding } = ownerOf(context)
      if (!['conversation', 'message', 'event', 'idempotency'].includes(kind)) deny('INVALID_EXTERNAL_ID')
      string(externalId, 'INVALID_EXTERNAL_ID', undefined, 512)
      const fields = [binding.tenant_id, binding.deployment_id, binding.connector_id, binding.account_id, binding.inbox_id, kind, externalId]
      try { return 'platform:v1:' + fields.map(value => encodeURIComponent(value)).join(':') } catch { deny('INVALID_EXTERNAL_ID') }
    },
  })
}

function strictTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  const calendar = new Date(0)
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  return calendar.getUTCFullYear() === Number(year) && calendar.getUTCMonth() === Number(month) - 1 && calendar.getUTCDate() === Number(day)
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60))
}
