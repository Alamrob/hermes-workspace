import type { A1SingleApprovalTimerAttestation } from './postgres-a1-single-approval-control.js'

export interface A1HostTimerAttestationBinding {
  requestId: string
  missionId: string
  authorizationDigestSha256: string
  requestExpiresAt: string
}

export interface A1HostTimerAttestationOptions {
  read: () => Promise<Buffer>
  binding: A1HostTimerAttestationBinding
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const MAX_ATTESTATION_LIFETIME_MS = 30 * 60_000
const MAX_INITIAL_AGE_MS = 30_000
const MAX_CLOCK_SKEW_MS = 5_000

export class A1HostTimerAttestationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'A1HostTimerAttestationError'
  }
}

/**
 * Re-reads a host-produced timer attestation for every control inspection.
 * The host launcher must keep the named timer masked for the entire window.
 * This class never executes systemctl, a shell, a URL or an arbitrary command.
 */
export class FileA1HostTimerAttestation
implements A1SingleApprovalTimerAttestation {
  private firstInspection = true

  constructor(private readonly options: A1HostTimerAttestationOptions) {
    if (typeof options.read !== 'function')
      throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_CONFIGURATION_INVALID')
    validateBinding(options.binding)
  }

  async inspect(): Promise<{ enabled: false; active: false }> {
    let value: unknown
    try {
      const bytes = await this.options.read()
      if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > 4096)
        throw new Error('bytes')
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_UNREADABLE')
    }
    const input = record(value)
    exactKeys(input, [
      'schema_version', 'type', 'request_id', 'mission_id',
      'authorization_digest_sha256', 'unit', 'source', 'enabled_state',
      'active_state', 'generated_at', 'expires_at', 'nonce',
    ])
    const generatedAt = exactIso(input.generated_at)
    const expiresAt = exactIso(input.expires_at)
    const now = (this.options.now ?? (() => new Date()))()
    const requestExpiry = exactIso(this.options.binding.requestExpiresAt)
    if (
      input.schema_version !== 1 || input.type !== 'a1_host_timer_attestation_v1' ||
      input.request_id !== this.options.binding.requestId ||
      input.mission_id !== this.options.binding.missionId ||
      input.authorization_digest_sha256 !== this.options.binding.authorizationDigestSha256 ||
      input.unit !== 'proptimiza-commercial-automation.timer' ||
      input.source !== 'systemctl-host-masked-probe' ||
      input.enabled_state !== 'masked' || input.active_state !== 'inactive' ||
      !UUID.test(String(input.nonce)) ||
      generatedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS ||
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() > generatedAt.getTime() + MAX_ATTESTATION_LIFETIME_MS ||
      expiresAt.getTime() > requestExpiry.getTime() ||
      (this.firstInspection && now.getTime() - generatedAt.getTime() > MAX_INITIAL_AGE_MS)
    ) throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_INVALID')
    this.firstInspection = false
    return { enabled: false, active: false }
  }
}

function validateBinding(binding: A1HostTimerAttestationBinding): void {
  if (
    !UUID.test(binding.requestId) || !UUID.test(binding.missionId) ||
    !SHA256.test(binding.authorizationDigestSha256) ||
    !Number.isFinite(Date.parse(binding.requestExpiresAt))
  ) throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_CONFIGURATION_INVALID')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_INVALID')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_INVALID')
}

function exactIso(value: unknown): Date {
  if (typeof value !== 'string')
    throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_INVALID')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    throw new A1HostTimerAttestationError('A1_TIMER_ATTESTATION_INVALID')
  return parsed
}
