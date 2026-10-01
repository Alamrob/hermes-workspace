import type { DeepReadonly, PlatformConfig, AuthenticatedSource } from './types.js'
import { closed, deny, freezeDeep, IDENTIFIER, list, snapshotJson, string, strings, unique } from './validation.js'

const INVALID = 'INVALID_PLATFORM_CONFIG'
const BINDING_FIELDS = ['binding_id', 'tenant_id', 'project_id', 'project_version', 'policy_version', 'deployment_id', 'connector_id', 'account_id', 'inbox_id', 'active', 'issuer', 'audience', 'keys', 'principals'] as const
const SOURCE_FIELDS = ['deployment_id', 'connector_id', 'account_id', 'inbox_id', 'principal_id'] as const
const CHANNELS = new Set(['none', 'internal', 'public_web', 'crm', 'email', 'whatsapp', 'calendar', 'web_chat', 'telephone'])

/** Whole configuration is accepted atomically, including disabled bindings. */
export function validatePlatformConfig(input: unknown): DeepReadonly<PlatformConfig> {
  const config = closed(snapshotJson(input, INVALID), ['schema_version', 'config_revision', 'bindings'], INVALID)
  if (config.schema_version !== 'platform-config.v1') deny(INVALID)
  string(config.config_revision, INVALID, IDENTIFIER)
  list(config.bindings, INVALID)
  const bindingIds = new Set<string>()
  const sourceIds = new Set<string>()
  const scopedKeys = new Map<string, string>()
  const scopedProjects = new Map<string, string>()
  for (const value of config.bindings) {
    const binding = closed(value, BINDING_FIELDS, INVALID)
    for (const name of ['binding_id', 'tenant_id', 'project_id', 'deployment_id', 'connector_id']) string(binding[name], INVALID, IDENTIFIER)
    for (const name of ['project_version', 'policy_version', 'account_id', 'inbox_id', 'issuer', 'audience']) string(binding[name], INVALID)
    if (typeof binding.active !== 'boolean') deny(INVALID)
    unique(binding.binding_id as string, bindingIds, INVALID)
    unique(sourceTuple(binding), sourceIds, 'AMBIGUOUS_BINDING')
    const projectScope = JSON.stringify([binding.tenant_id, binding.deployment_id])
    const project = JSON.stringify([binding.project_id, binding.project_version, binding.policy_version])
    if (scopedProjects.has(projectScope) && scopedProjects.get(projectScope) !== project) deny('INCOMPATIBLE_BINDING')
    scopedProjects.set(projectScope, project)
    list(binding.keys, INVALID)
    const keyIds = new Set<string>()
    const keyRefs = new Set<string>()
    for (const value of binding.keys) {
      const key = closed(value, ['key_id', 'algorithm', 'key_ref'], INVALID)
      string(key.key_id, INVALID, IDENTIFIER)
      string(key.key_ref, INVALID, undefined, 512)
      if (key.algorithm !== 'Ed25519') deny(INVALID)
      const prefix = `keyref:v1:${binding.tenant_id}:${binding.deployment_id}:`
      if (!key.key_ref.startsWith(prefix) || !IDENTIFIER.test(key.key_ref.slice(prefix.length))) deny('KEY_SCOPE_MISMATCH')
      unique(key.key_id, keyIds, INVALID)
      unique(key.key_ref, keyRefs, INVALID)
      const scope = JSON.stringify([binding.tenant_id, binding.deployment_id, key.key_id])
      if (scopedKeys.has(scope) && scopedKeys.get(scope) !== key.key_ref) deny('KEY_SCOPE_MISMATCH')
      scopedKeys.set(scope, key.key_ref)
    }
    list(binding.principals, INVALID)
    const principalIds = new Set<string>()
    for (const value of binding.principals) {
      const principal = closed(value, ['principal_id', 'requested_by', 'key_ids', 'grant'], INVALID)
      string(principal.principal_id, INVALID, IDENTIFIER)
      string(principal.requested_by, INVALID)
      unique(principal.principal_id, principalIds, INVALID)
      strings(principal.key_ids, INVALID, IDENTIFIER, 1)
      if (principal.key_ids.some(key => !keyIds.has(key))) deny(INVALID)
      const grant = closed(principal.grant, ['actions', 'tools', 'channels', 'autonomy_levels', 'budget'], INVALID)
      strings(grant.actions, INVALID, /^[a-z][a-z0-9._:-]{1,127}$/)
      strings(grant.tools, INVALID, /^[a-z][a-z0-9._:-]{0,127}$/)
      strings(grant.channels, INVALID)
      if (grant.channels.some(channel => !CHANNELS.has(channel))) deny(INVALID)
      strings(grant.autonomy_levels, INVALID, undefined, 1)
      if (grant.autonomy_levels.some(level => !['A0', 'A1', 'A2'].includes(level))) deny(INVALID)
      const budget = closed(grant.budget, ['currency', 'maximum'], INVALID)
      string(budget.currency, INVALID, /^[A-Z]{3}$/)
      if (typeof budget.maximum !== 'number' || !Number.isFinite(budget.maximum) || budget.maximum < 0) deny(INVALID)
    }
  }
  return freezeDeep(config) as unknown as DeepReadonly<PlatformConfig>
}
export function validateAuthenticatedSource(input: unknown): AuthenticatedSource {
  const source = closed(snapshotJson(input, 'INVALID_AUTHENTICATED_SOURCE'), SOURCE_FIELDS, 'INVALID_AUTHENTICATED_SOURCE')
  for (const field of SOURCE_FIELDS) string(source[field], 'INVALID_AUTHENTICATED_SOURCE', ['account_id', 'inbox_id'].includes(field) ? undefined : IDENTIFIER)
  return source as unknown as AuthenticatedSource
}

export function sourceTuple(source: { [key: string]: unknown } | AuthenticatedSource): string {
  return JSON.stringify([source.deployment_id, source.connector_id, source.account_id, source.inbox_id])
}
