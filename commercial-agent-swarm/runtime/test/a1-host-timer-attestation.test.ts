import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  A1HostTimerAttestationError,
  FileA1HostTimerAttestation,
} from '../src/a1-host-timer-attestation.js'

const REQUEST = 'a3800000-0000-4380-8380-000000000001'
const MISSION = 'a3800000-0000-4380-8380-000000000002'
const DIGEST = 'a'.repeat(64)
const NOW = new Date('2026-09-06T21:00:10.000Z')

function value() {
  return {
    schema_version: 1,
    type: 'a1_host_timer_attestation_v1',
    request_id: REQUEST,
    mission_id: MISSION,
    authorization_digest_sha256: DIGEST,
    unit: 'proptimiza-commercial-automation.timer',
    source: 'systemctl-host-masked-probe',
    enabled_state: 'masked',
    active_state: 'inactive',
    generated_at: '2026-09-06T21:00:00.000Z',
    expires_at: '2026-09-06T21:20:00.000Z',
    nonce: 'a3800000-0000-4380-8380-000000000003',
  }
}

function create(input = value(), now = NOW) {
  return new FileA1HostTimerAttestation({
    read: async () => Buffer.from(JSON.stringify(input)),
    binding: {
      requestId: REQUEST,
      missionId: MISSION,
      authorizationDigestSha256: DIGEST,
      requestExpiresAt: '2026-09-06T21:30:00.000Z',
    },
    now: () => now,
  })
}

describe('host timer attestation', () => {
  it('accepts a fresh exact attestation and returns only two booleans', async () => {
    assert.deepEqual(await create().inspect(), { enabled: false, active: false })
  })

  it('re-reads on every inspection and rejects drift without retry', async () => {
    const input = value()
    let reads = 0
    const timer = new FileA1HostTimerAttestation({
      read: async () => {
        reads += 1
        return Buffer.from(JSON.stringify(reads === 1 ? input : { ...input, active_state: 'active' }))
      },
      binding: {
        requestId: REQUEST,
        missionId: MISSION,
        authorizationDigestSha256: DIGEST,
        requestExpiresAt: '2026-09-06T21:30:00.000Z',
      },
      now: () => NOW,
    })
    await timer.inspect()
    await assert.rejects(timer.inspect(), /A1_TIMER_ATTESTATION_INVALID/)
    assert.equal(reads, 2)
  })

  it('rejects stale, overlong, unmasked, expanded and mismatched attestations', async () => {
    const cases: Array<Record<string, unknown>> = [
      { generated_at: '2026-09-06T20:59:00.000Z' },
      { expires_at: '2026-09-06T21:30:00.001Z' },
      { enabled_state: 'disabled' },
      { request_id: MISSION },
      { untrusted: true },
    ]
    for (const mutation of cases) {
      const timer = create({ ...value(), ...mutation })
      await assert.rejects(timer.inspect(), (error) =>
        error instanceof A1HostTimerAttestationError &&
        !error.message.includes('proptimiza-commercial-automation.timer'))
    }
  })

  it('does not leak unreadable file errors', async () => {
    const timer = new FileA1HostTimerAttestation({
      read: async () => { throw new Error('root-only-path') },
      binding: {
        requestId: REQUEST,
        missionId: MISSION,
        authorizationDigestSha256: DIGEST,
        requestExpiresAt: '2026-09-06T21:30:00.000Z',
      },
      now: () => NOW,
    })
    await assert.rejects(timer.inspect(), (error) =>
      error instanceof A1HostTimerAttestationError &&
      error.code === 'A1_TIMER_ATTESTATION_UNREADABLE' &&
      !error.message.includes('root-only-path'))
  })
})
