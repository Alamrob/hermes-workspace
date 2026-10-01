import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPlatformAdmission } from '../src/platform/admission.js'
import { validatePlatformConfig } from '../src/platform/config.js'
import { PlatformAdmissionError } from '../src/platform/validation.js'
import type { PlatformConfig, PlatformKeyMaterial, PlatformKeyRequest } from '../src/platform/types.js'
import { signWorkOrder, signWorkOrderEd25519, verifyWorkOrder } from '../src/security.js'
import { validateWorkOrder, type WorkOrder } from '../src/work-orders.js'
import { validWorkOrder } from './fixtures.js'

const NOW = new Date('2026-08-15T19:00:00.000Z')
const loadConfig = (): PlatformConfig => JSON.parse(readFileSync(new URL('../../config/platform/synthetic-tenants.json', import.meta.url), 'utf8'))
function harness(config = loadConfig()) {
  const privateKeys = new Map<string, string>()
  const material = new Map<string, PlatformKeyMaterial>()
  for (const binding of config.bindings) {
    for (const reference of binding.keys) {
      if (material.has(reference.key_ref)) continue
      const pair = generateKeyPairSync('ed25519')
      privateKeys.set(reference.key_ref, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
      material.set(reference.key_ref, { ...reference, tenant_id: binding.tenant_id, deployment_id: binding.deployment_id, public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    }
  }
  const dependencies = {
    resolveKey: (request: Readonly<PlatformKeyRequest>): unknown => material.get(request.key_ref),
    now: () => new Date(NOW),
  }
  const admission = createPlatformAdmission(config, dependencies)
  function source(index = 0) {
    const binding = config.bindings[index]
    return { deployment_id: binding.deployment_id, connector_id: binding.connector_id, account_id: binding.account_id, inbox_id: binding.inbox_id, principal_id: binding.principals[0].principal_id }
  }
  function sign(order: WorkOrder, index = 0, keyIndex = 0): WorkOrder {
    ;(order.authority as Record<string, string>).signature = signWorkOrderEd25519(order, privateKeys.get(config.bindings[index].keys[keyIndex].key_ref)!)
    return order
  }
  function order(index = 0): WorkOrder {
    const binding = config.bindings[index]
    const value = {
      ...validWorkOrder(), project_id: binding.project_id, project_version: binding.project_version,
      policy_version: binding.policy_version, requested_by: binding.principals[0].requested_by,
      autonomy_level: 'A0', dry_run: true, allowed_actions: ['draft.prepare'], approved_tools: ['knowledge.read'],
      approved_channels: ['internal'], prohibited_actions: ['mail.send'],
      contact_policy: { ...validWorkOrder().contact_policy, contact_permitted: false },
      volume_limits: { ...validWorkOrder().volume_limits, maximum_external_actions: 0 },
      metadata: { fixture: true },
      authority: { issuer: binding.issuer, audience: binding.audience, key_id: binding.keys[0].key_id, algorithm: 'Ed25519', signature: '0'.repeat(128) },
    } as WorkOrder
    return sign(value, index)
  }
  return { config, admission, material, privateKeys, dependencies, source, order, sign }
}
function rejectsCode(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => error instanceof Error && error.message === code)
}

describe('platform configuration fails closed at startup', () => {
  it('validates, clones and deeply freezes the versioned fixture without keys', () => {
    const raw = loadConfig()
    const snapshot = validatePlatformConfig(raw)
    assert.deepEqual(snapshot, raw)
    raw.bindings[0].principals[0].grant.actions.push('mail.send')
    assert.deepEqual(snapshot.bindings[0].principals[0].grant.actions, ['draft.prepare'])
    assert.ok(Object.isFrozen(snapshot.bindings[0].principals[0].grant.actions))
    assert.equal(JSON.stringify(snapshot).includes('PUBLIC KEY'), false)
  })
  const invalid: Array<[string, (config: any) => void, string?]> = [
    ['unsupported version', config => { config.schema_version = 'platform-config.v2' }],
    ['missing version', config => { delete config.schema_version }],
    ['unknown field', config => { config.secrets = {} }],
    ['embedded key material', config => { config.bindings[0].keys[0].public_key_pem = 'untrusted' }],
    ['empty bindings', config => { config.bindings = [] }],
    ['bad active type', config => { config.bindings[0].active = 'true' }],
    ['bad identifier', config => { config.bindings[0].tenant_id = '../other' }],
    ['duplicate binding id', config => { config.bindings[1].binding_id = config.bindings[0].binding_id }],
    ['duplicate source even when inactive', config => { config.bindings[1].connector_id = config.bindings[0].connector_id; config.bindings[1].active = false }, 'AMBIGUOUS_BINDING'],
    ['project conflict within deployment', config => { const b = structuredClone(config.bindings[0]); b.binding_id = 'extra'; b.connector_id = 'extra'; b.project_id = 'other'; config.bindings.push(b) }, 'INCOMPATIBLE_BINDING'],
    ['foreign tenant key ref', config => { config.bindings[0].keys[0].key_ref = config.bindings[1].keys[0].key_ref }, 'KEY_SCOPE_MISMATCH'],
    ['foreign deployment key ref', config => { config.bindings[0].keys[0].key_ref = 'keyref:v1:proptimiza:other:signing-v1' }, 'KEY_SCOPE_MISMATCH'],
    ['ungranted key reference', config => { config.bindings[0].principals[0].key_ids = ['absent'] }],
    ['duplicate key id', config => { config.bindings[0].keys.push({ ...config.bindings[0].keys[0] }) }],
    ['duplicate principal', config => { config.bindings[0].principals.push({ ...config.bindings[0].principals[0] }) }],
    ['missing grant', config => { delete config.bindings[0].principals[0].grant }],
    ['wildcard grant', config => { config.bindings[0].principals[0].grant.actions = ['*'] }],
    ['duplicate grant', config => { config.bindings[0].principals[0].grant.tools = ['knowledge.read', 'knowledge.read'] }],
    ['A3 grant', config => { config.bindings[0].principals[0].grant.autonomy_levels = ['A3'] }],
    ['unknown channel', config => { config.bindings[0].principals[0].grant.channels = ['arbitrary'] }],
    ['negative budget', config => { config.bindings[0].principals[0].grant.budget.maximum = -1 }],
    ['HMAC in new config', config => { config.bindings[0].keys[0].algorithm = 'HMAC-SHA256' }],
    ['prototype field', config => { config.bindings[0].__proto__ = { tenant_id: 'other' } }],
  ]
  for (const [name, change, code] of invalid) it(name, () => {
    const config = loadConfig(); change(config)
    rejectsCode(() => validatePlatformConfig(config), code ?? 'INVALID_PLATFORM_CONFIG')
  })
  it('rejects JSON-hostile config without executing getters', () => {
    const config = loadConfig()
    let called = false
    Object.defineProperty(config, 'schema_version', { enumerable: true, get() { called = true; return 'platform-config.v1' } })
    rejectsCode(() => validatePlatformConfig(config), 'INVALID_PLATFORM_CONFIG')
    assert.equal(called, false)
    const cyclic: any = loadConfig(); cyclic.bindings.push(cyclic)
    rejectsCode(() => validatePlatformConfig(cyclic), 'INVALID_PLATFORM_CONFIG')
  })
})

describe('trusted binding and context ownership', () => {
  it('admits two tenants through the same code with distinct keys and the same key_id and mission_id', () => {
    const h = harness()
    const first = h.admission.admitWorkOrder(h.admission.resolveAuthenticatedContext(h.source(0)), h.order(0))
    const second = h.admission.admitWorkOrder(h.admission.resolveAuthenticatedContext(h.source(1)), h.order(1))
    assert.equal(first.context.tenant_id, 'proptimiza')
    assert.equal(second.context.tenant_id, 'mallaguardian')
    assert.equal(first.work_order.mission_id, second.work_order.mission_id)
    assert.deepEqual(first.work_order.authority && (first.work_order.authority as any).key_id, (second.work_order.authority as any).key_id)
    assert.equal(first.schema_version, 'platform-admission.v1')
    assert.match(first.context.config_hash, /^[0-9a-f]{64}$/)
    assert.equal(first.context.config_hash, second.context.config_hash)
    assert.equal(Object.isFrozen(first.work_order.contact_policy), true)
  })
  for (const dimension of ['deployment_id', 'connector_id', 'account_id', 'inbox_id']) it('rejects an unknown ' + dimension, () => {
    const h = harness()
    rejectsCode(() => h.admission.resolveAuthenticatedContext({ ...h.source(), [dimension]: 'missing' }), 'BINDING_NOT_FOUND')
  })
  it('rejects inactive binding and unknown principal', () => {
    const config = loadConfig(); config.bindings[0].active = false
    const h = harness(config)
    rejectsCode(() => h.admission.resolveAuthenticatedContext(h.source()), 'BINDING_INACTIVE')
    rejectsCode(() => h.admission.resolveAuthenticatedContext({ ...h.source(1), principal_id: 'impostor' }), 'PRINCIPAL_NOT_GRANTED')
  })
  for (const field of ['tenant_id', 'authenticated', 'grant', 'keyring', 'config_revision']) it('rejects source authority field ' + field, () => {
    const h = harness()
    rejectsCode(() => h.admission.resolveAuthenticatedContext({ ...h.source(), [field]: true }), 'INVALID_AUTHENTICATED_SOURCE')
  })
  it('rejects forged, serialized, cloned and foreign-instance contexts', () => {
    const h = harness(), other = harness()
    const context = h.admission.resolveAuthenticatedContext(h.source())
    for (const forged of [null, 'context', {}, { ...context }, structuredClone(context), JSON.parse(JSON.stringify(context)), other.admission.resolveAuthenticatedContext(other.source())]) {
      rejectsCode(() => h.admission.admitWorkOrder(forged, h.order()), 'INVALID_PLATFORM_CONTEXT')
      rejectsCode(() => h.admission.namespaceExternalId(forged, 'message', 'same'), 'INVALID_PLATFORM_CONTEXT')
    }
    assert.throws(() => Object.assign(context, { tenant_id: 'mallaguardian' }), TypeError)
  })
  it('namespaces external IDs across tenant/deployment/connector/account/inbox and kind without delimiter collisions', () => {
    const h = harness()
    const a = h.admission.resolveAuthenticatedContext(h.source()), b = h.admission.resolveAuthenticatedContext(h.source(1))
    const id = h.admission.namespaceExternalId(a, 'message', 'x:y/z%')
    assert.notEqual(id, h.admission.namespaceExternalId(b, 'message', 'x:y/z%'))
    assert.notEqual(id, h.admission.namespaceExternalId(a, 'event', 'x:y/z%'))
    assert.match(id, /x%3Ay%2Fz%25$/)
    rejectsCode(() => h.admission.namespaceExternalId(a, 'message', ''), 'INVALID_EXTERNAL_ID')
    rejectsCode(() => h.admission.namespaceExternalId(a, 'bad' as any, 'id'), 'INVALID_EXTERNAL_ID')
    rejectsCode(() => h.admission.namespaceExternalId(a, 'message', '\ud800'), 'INVALID_EXTERNAL_ID')
  })
})

describe('key scopes and immutable authority', () => {
  it('rejects cross-tenant signed work orders and keys even when key_id is identical', () => {
    const h = harness()
    const a = h.admission.resolveAuthenticatedContext(h.source()), b = h.admission.resolveAuthenticatedContext(h.source(1))
    rejectsCode(() => h.admission.admitWorkOrder(b, h.order(0)), 'INVALID_PROJECT')
    const foreign = h.order(1); foreign.project_id = 'proptimiza'; h.sign(foreign, 1)
    rejectsCode(() => h.admission.admitWorkOrder(a, foreign), 'INVALID_SIGNATURE')
  })
  for (const field of ['tenant_id', 'deployment_id', 'key_id', 'key_ref', 'algorithm']) it('rejects resolver mismatch in ' + field, () => {
    const h = harness()
    rejectsCode(() => createPlatformAdmission(h.config, { ...h.dependencies, resolveKey: request => ({ ...h.material.get(request.key_ref), [field]: 'foreign' }) }), 'KEY_SCOPE_MISMATCH')
  })
  it('rejects absent, malformed, private, wrong key type or asynchronous resolver results', () => {
    const h = harness()
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const invalid: unknown[] = [undefined, Promise.resolve(null), { ...h.material.values().next().value, public_key_pem: 'invalid' }, { ...h.material.values().next().value, public_key_pem: h.privateKeys.values().next().value }, { ...h.material.values().next().value, public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
    for (const result of invalid) rejectsCode(() => createPlatformAdmission(h.config, { ...h.dependencies, resolveKey: () => result }), 'INVALID_KEY_MATERIAL')
    rejectsCode(() => createPlatformAdmission(h.config, { ...h.dependencies, resolveKey: () => { throw new Error('sensitive provider detail') } }), 'INVALID_KEY_MATERIAL')
  })
  it('rejects reuse of public key material across tenants and deployments', () => {
    const h = harness()
    const shared = h.material.values().next().value!.public_key_pem
    rejectsCode(() => createPlatformAdmission(h.config, { ...h.dependencies, resolveKey: request => ({ ...request, public_key_pem: shared }) }), 'KEY_SCOPE_MISMATCH')
    const config = loadConfig()
    const extra = structuredClone(config.bindings[0])
    extra.binding_id = 'extra'; extra.deployment_id = 'other-local'; extra.keys[0].key_ref = 'keyref:v1:proptimiza:other-local:signing-v1'
    config.bindings = [config.bindings[0], extra]
    rejectsCode(() => createPlatformAdmission(config, { ...h.dependencies, resolveKey: request => ({ ...request, public_key_pem: shared }) }), 'KEY_SCOPE_MISMATCH')
  })
  it('snapshots config and resolver values before any payload and preserves signed nested data', () => {
    const h = harness()
    const source = h.source()
    const context = h.admission.resolveAuthenticatedContext(source)
    const original = h.order()
    const originalHash = context.config_hash
    h.config.bindings[0].tenant_id = 'mallaguardian'
    h.config.bindings[0].principals[0].grant.actions.push('mail.send')
    for (const key of h.material.values()) key.public_key_pem = 'invalid'
    h.dependencies.resolveKey = () => { throw new Error('must not run after creation') }
    h.dependencies.now = () => new Date('invalid')
    source.account_id = 'foreign'
    const accepted = h.admission.admitWorkOrder(context, original)
    ;(original.contact_policy as any).contact_permitted = true
    ;(original.metadata as any).fixture = false
    assert.equal(accepted.context.tenant_id, 'proptimiza')
    assert.equal(accepted.context.config_hash, originalHash)
    assert.equal((accepted.work_order.contact_policy as any).contact_permitted, false)
    assert.equal((accepted.work_order.metadata as any).fixture, true)
    assert.throws(() => { (accepted.work_order.approved_tools as any).push('mail.send') }, TypeError)
    const escalation = structuredClone(accepted.work_order) as WorkOrder
    escalation.allowed_actions = ['mail.send']
    ;(escalation.authority as any).signature = signWorkOrderEd25519(escalation, h.privateKeys.values().next().value!)
    rejectsCode(() => h.admission.admitWorkOrder(context, escalation), 'INSUFFICIENT_GRANT')
  })
})

describe('signed authority, timestamps and grants', () => {
  const changes: Array<[string, (order: any) => void, string]> = [
    ['wrong issuer', order => { order.authority.issuer = 'foreign' }, 'INVALID_AUTHORITY'],
    ['wrong audience', order => { order.authority.audience = 'foreign' }, 'INVALID_AUTHORITY'],
    ['unknown key id', order => { order.authority.key_id = 'unknown' }, 'PRINCIPAL_KEY_NOT_GRANTED'],
    ['prototype key id', order => { order.authority.key_id = 'constructor' }, 'PRINCIPAL_KEY_NOT_GRANTED'],
    ['wrong project', order => { order.project_id = 'mallaguardian' }, 'INVALID_PROJECT'],
    ['wrong project version', order => { order.project_version = 'v99' }, 'INCOMPATIBLE_BINDING'],
    ['wrong policy version', order => { order.policy_version = 'other' }, 'INCOMPATIBLE_BINDING'],
    ['wrong principal', order => { order.requested_by = 'other-principal' }, 'PRINCIPAL_MISMATCH'],
    ['not yet valid', order => { order.created_at = '2026-08-15T19:00:00.001Z' }, 'AUTHORITY_NOT_YET_VALID'],
    ['expiry at now', order => { order.created_at = '2026-08-15T18:00:00Z'; order.expires_at = NOW.toISOString() }, 'EXPIRED_AUTHORITY'],
    ['calendar overflow', order => { order.created_at = '2026-02-30T00:00:00Z' }, 'INVALID_AUTHORITY_TIME'],
    ['24h timestamp', order => { order.created_at = '2026-08-14T24:00:00Z' }, 'INVALID_AUTHORITY_TIME'],
    ['action escalation', order => { order.allowed_actions = ['crm.write'] }, 'INSUFFICIENT_GRANT'],
    ['tool escalation', order => { order.approved_tools = ['crm.write'] }, 'INSUFFICIENT_GRANT'],
    ['channel escalation', order => { order.approved_channels = ['email'] }, 'INSUFFICIENT_GRANT'],
    ['budget escalation', order => { order.budget_limit.maximum = 1 }, 'INSUFFICIENT_GRANT'],
    ['currency mismatch', order => { order.budget_limit.currency = 'USD' }, 'INSUFFICIENT_GRANT'],
    ['external volume', order => { order.volume_limits.maximum_external_actions = 1 }, 'FOUNDATION_DRAFT_ONLY'],
    ['contact allowed', order => { order.contact_policy.contact_permitted = true }, 'FOUNDATION_DRAFT_ONLY'],
    ['live order', order => { order.dry_run = false }, 'FOUNDATION_DRAFT_ONLY'],
    ['A3', order => { order.autonomy_level = 'A3' }, 'FOUNDATION_DRAFT_ONLY'],
    ['A4', order => { order.autonomy_level = 'A4' }, 'FOUNDATION_DRAFT_ONLY'],
    ['conflicting action', order => { order.prohibited_actions = ['draft.prepare'] }, 'CONFLICTING_ACTIONS'],
  ]
  for (const [name, change, code] of changes) it(name, () => {
    const h = harness(), order = h.order(); change(order); h.sign(order)
    rejectsCode(() => h.admission.admitWorkOrder(h.admission.resolveAuthenticatedContext(h.source()), order), code)
  })
  it('denies insufficient autonomy and principal key grant separately', () => {
    const config = loadConfig(); config.bindings[0].principals[0].grant.autonomy_levels = ['A0']
    config.bindings[0].keys.push({ key_id: 'other-key', algorithm: 'Ed25519', key_ref: 'keyref:v1:proptimiza:local-fixture:other-key' })
    const h = harness(config), context = h.admission.resolveAuthenticatedContext(h.source())
    const order = h.order(); order.autonomy_level = 'A1'; h.sign(order)
    rejectsCode(() => h.admission.admitWorkOrder(context, order), 'INSUFFICIENT_GRANT')
    order.autonomy_level = 'A0'; (order.authority as any).key_id = 'other-key'; h.sign(order, 0, 1)
    rejectsCode(() => h.admission.admitWorkOrder(context, order), 'PRINCIPAL_KEY_NOT_GRANTED')
  })
  it('rejects invalid time, reversed lifetime, invalid signature shape and malformed payload before verification', () => {
    const h = harness(), context = h.admission.resolveAuthenticatedContext(h.source())
    for (const changes of [
      { created_at: 'invalid' }, { created_at: '2026-08-16T00:00:00Z' },
      { tenant_id: 'mallaguardian' }, { authenticated: true }, { grants: ['*'] },
    ]) assert.throws(() => h.admission.admitWorkOrder(context, { ...h.order(), ...changes }))
    const order = h.order(); (order.authority as any).signature = '0'.repeat(64)
    assert.throws(() => h.admission.admitWorkOrder(context, order))
    const tampered = h.order(); (tampered.data_policy as any).retention_days = 99
    rejectsCode(() => h.admission.admitWorkOrder(context, tampered), 'INVALID_SIGNATURE')
    const expiredConfig = createPlatformAdmission(h.config, { ...h.dependencies, now: () => new Date('invalid') })
    rejectsCode(() => expiredConfig.admitWorkOrder(expiredConfig.resolveAuthenticatedContext(h.source()), h.order()), 'INVALID_AUTHORITY_TIME')
  })
  it('preserves the created_at inclusive and expires_at exclusive boundaries with valid offsets', () => {
    const h = harness(), order = h.order()
    order.created_at = '2026-08-15T16:00:00-03:00'; order.expires_at = '2026-08-15T19:00:00.001Z'; h.sign(order)
    assert.doesNotThrow(() => h.admission.admitWorkOrder(h.admission.resolveAuthenticatedContext(h.source()), order))
  })
  it('never treats signed metadata as tenant configuration or grants', () => {
    const h = harness(), context = h.admission.resolveAuthenticatedContext(h.source()), order = h.order()
    order.metadata = { tenant_id: 'mallaguardian', authenticated: true, keyring: { 'signing-v1': 'foreign' }, grant: { actions: ['mail.send'] }, a3_enabled: true, config_revision: 'injected' }
    h.sign(order)
    const result = h.admission.admitWorkOrder(context, order)
    assert.equal(result.context.tenant_id, 'proptimiza')
    assert.equal(result.context.config_revision, 'synthetic-v1')
    order.allowed_actions = ['mail.send']; order.prohibited_actions = ['prospect.contact']; h.sign(order)
    rejectsCode(() => h.admission.admitWorkOrder(context, order), 'INSUFFICIENT_GRANT')
  })
  it('rejects a signed HMAC order in new admission while retaining legacy HMAC', () => {
    const h = harness(), order = h.order(), secret = randomBytes(32).toString('hex')
    ;(order.authority as any).algorithm = 'HMAC-SHA256'
    ;(order.authority as any).signature = signWorkOrder(order, secret)
    rejectsCode(() => h.admission.admitWorkOrder(h.admission.resolveAuthenticatedContext(h.source()), order), 'PRINCIPAL_KEY_NOT_GRANTED')
  })
})

describe('legacy verifier compatibility', () => {
  for (const algorithm of ['HMAC-SHA256', 'Ed25519']) it(algorithm + ' retains Proptimiza-only admission and error boundaries', () => {
    const pair = generateKeyPairSync('ed25519'), secret = randomBytes(32).toString('hex')
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const sign = (order: WorkOrder) => { (order.authority as any).signature = algorithm === 'Ed25519' ? signWorkOrderEd25519(order, privateKey) : signWorkOrder(order, secret) }
    const order = validWorkOrder() as unknown as WorkOrder
    ;(order.authority as any).algorithm = algorithm; sign(order)
    const config = { issuer: 'codex', audience: 'hermes-commercial-orchestrator', keys: { 'control-key-1': secret }, ed25519PublicKeys: { 'control-key-1': publicKey } }
    assert.doesNotThrow(() => verifyWorkOrder(validateWorkOrder(order), config, NOW))
    order.project_id = 'mallaguardian'; sign(order)
    rejectsCode(() => verifyWorkOrder(validateWorkOrder(order), config, NOW), 'INVALID_PROJECT')
    order.project_id = 'proptimiza'; (order.authority as any).issuer = 'wrong'; sign(order)
    rejectsCode(() => verifyWorkOrder(validateWorkOrder(order), config, NOW), 'INVALID_AUTHORITY')
    ;(order.authority as any).issuer = 'codex'; order.created_at = '2026-08-15T19:00:00.001Z'; sign(order)
    rejectsCode(() => verifyWorkOrder(validateWorkOrder(order), config, NOW), 'AUTHORITY_NOT_YET_VALID')
    order.created_at = '2026-08-15T18:00:00Z'; order.expires_at = NOW.toISOString(); sign(order)
    rejectsCode(() => verifyWorkOrder(validateWorkOrder(order), config, NOW), 'EXPIRED_AUTHORITY')
    order.expires_at = '2026-08-15T21:00:00Z'; sign(order); order.objective = 'tamper'
    rejectsCode(() => verifyWorkOrder(validateWorkOrder(order), config, NOW), 'INVALID_SIGNATURE')
  })
})
