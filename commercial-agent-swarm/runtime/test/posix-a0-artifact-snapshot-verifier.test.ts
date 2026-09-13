import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { A0SealedArtifactSnapshot } from '../src/a0-behavior-batch-admission.js'
import {
  A0_SEALED_ARTIFACT_ROOT,
  PosixA0ArtifactSnapshotVerifier,
} from '../src/posix-a0-artifact-snapshot-verifier.js'

const digest = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
const fixtureBytes = Buffer.from('{"fixture":true}\n')
const profileBytes = Buffer.from('profile: safe\n')

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    )
  return value
}

function snapshot() {
  const body = {
    schema_version: 1 as const,
    type: 'commercial_swarm_a0_sealed_artifact_snapshot/v1' as const,
    status: 'sealed' as const,
    fixture_manifest_sha256: 'a'.repeat(64),
    profile_bundle_sha256: 'b'.repeat(64),
    fixture_artifacts: [
      {
        path: 'fixtures/T01/sales-orchestrator.json',
        sha256: digest(fixtureBytes),
        bytes: fixtureBytes.length,
        sealed_handle: 'a0-sealed:fixture-0000000000000001',
      },
    ],
    profile_artifacts: [
      {
        path: 'profiles/sales-orchestrator/SOUL.md',
        sha256: digest(profileBytes),
        bytes: profileBytes.length,
        sealed_handle: 'a0-sealed:profile-0000000000000001',
      },
    ],
    snapshot_handle: 'a0-sealed:snapshot-0000000000000001',
  }
  const snapshotBodyBytes = Buffer.from(`${JSON.stringify(normalize(body))}\n`)
  const value = {
    ...body,
    snapshot_sha256: digest(snapshotBodyBytes),
  } as A0SealedArtifactSnapshot
  const snapshotBytes = Buffer.from(`${JSON.stringify(normalize(value))}\n`)
  return {
    value,
    files: new Map([
      [`${A0_SEALED_ARTIFACT_ROOT}/fixture-0000000000000001`, fixtureBytes],
      [`${A0_SEALED_ARTIFACT_ROOT}/profile-0000000000000001`, profileBytes],
      [`${A0_SEALED_ARTIFACT_ROOT}/snapshot-0000000000000001`, snapshotBytes],
    ]),
  }
}

describe('POSIX A0 sealed artifact verifier', () => {
  it('verifies exact bytes and hashes through opaque handles only', async () => {
    const sealed = snapshot()
    assert.deepEqual(JSON.parse(sealed.files.get(
      `${A0_SEALED_ARTIFACT_ROOT}/snapshot-0000000000000001`,
    )!.toString('utf8')), normalize(sealed.value))
    const reads: string[] = []
    const verifier = new PosixA0ArtifactSnapshotVerifier({
      expectedGid: 10001,
      readSealed: async (path, options) => {
        reads.push(path)
        assert.equal(options.root, A0_SEALED_ARTIFACT_ROOT)
        const bytes = sealed.files.get(path)
        if (!bytes) throw new Error('not found')
        return Buffer.from(bytes)
      },
    })
    assert.deepEqual(await verifier.verify(sealed.value), {
      status: 'verified',
      snapshot_sha256: sealed.value.snapshot_sha256,
    })
    assert.equal(reads.length, 3)
    assert.equal(
      reads.every((path) => path.startsWith(`${A0_SEALED_ARTIFACT_ROOT}/`)),
      true,
    )
  })

  it('rejects byte, digest, alias and handle drift without leaking paths', async () => {
    for (const mutation of ['bytes', 'digest', 'alias', 'handle'] as const) {
      const sealed = snapshot()
      if (mutation === 'bytes') sealed.value.fixture_artifacts[0]!.bytes += 1
      if (mutation === 'digest')
        sealed.value.fixture_artifacts[0]!.sha256 = 'c'.repeat(64)
      if (mutation === 'alias')
        sealed.value.profile_artifacts[0]!.sealed_handle =
          sealed.value.fixture_artifacts[0]!.sealed_handle
      if (mutation === 'handle')
        sealed.value.fixture_artifacts[0]!.sealed_handle =
          'a0-sealed:../escape-0000000000000000'
      const verifier = new PosixA0ArtifactSnapshotVerifier({
        expectedGid: 10001,
        readSealed: async (path) =>
          Buffer.from(sealed.files.get(path) ?? Buffer.from('missing')),
      })
      assert.deepEqual(await verifier.verify(sealed.value), {
        status: 'rejected',
        reason: 'sealed_artifact_verification_failed',
      })
    }
  })
})
