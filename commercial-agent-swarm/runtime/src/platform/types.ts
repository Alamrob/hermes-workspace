import type { WorkOrder } from '../work-orders.js'

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type FoundationAutonomy = 'A0' | 'A1' | 'A2'

export interface PlatformGrant {
  actions: string[]
  tools: string[]
  channels: string[]
  autonomy_levels: FoundationAutonomy[]
  budget: { currency: string; maximum: number }
}
export interface PlatformPrincipal {
  principal_id: string
  requested_by: string
  key_ids: string[]
  grant: PlatformGrant
}
export interface PlatformKeyReference {
  key_id: string
  algorithm: 'Ed25519'
  key_ref: string
}
export interface PlatformBinding {
  binding_id: string
  tenant_id: string
  project_id: string
  project_version: string
  policy_version: string
  deployment_id: string
  connector_id: string
  account_id: string
  inbox_id: string
  active: boolean
  issuer: string
  audience: string
  keys: PlatformKeyReference[]
  principals: PlatformPrincipal[]
}
export interface PlatformConfig {
  schema_version: 'platform-config.v1'
  config_revision: string
  bindings: PlatformBinding[]
}
/** Construct only from a connector's verified identity, never from a request body. */
export interface AuthenticatedSource {
  deployment_id: string
  connector_id: string
  account_id: string
  inbox_id: string
  principal_id: string
}
export interface PlatformContext extends AuthenticatedSource {
  schema_version: 'platform-context.v1'
  config_revision: string
  config_hash: string
  binding_id: string
  tenant_id: string
  project_id: string
  project_version: string
  policy_version: string
}
export interface PlatformKeyRequest extends PlatformKeyReference {
  tenant_id: string
  deployment_id: string
}
export interface PlatformKeyMaterial extends PlatformKeyRequest {
  public_key_pem: string
}
export interface PlatformAdmissionResult {
  schema_version: 'platform-admission.v1'
  context: PlatformContext
  work_order: WorkOrder
}
export interface PlatformAdmission {
  resolveAuthenticatedContext(source: unknown): DeepReadonly<PlatformContext>
  admitWorkOrder(context: unknown, payload: unknown): DeepReadonly<PlatformAdmissionResult>
  namespaceExternalId(context: unknown, kind: 'conversation' | 'message' | 'event' | 'idempotency', externalId: string): string
}
