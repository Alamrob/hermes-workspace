import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type {
  A0ArtifactSnapshotVerification,
  A0ArtifactSnapshotVerifierPort,
  A0SealedArtifactReference,
  A0SealedArtifactSnapshot,
} from './a0-behavior-batch-admission.js'
import {
  readSealedInputFile,
  type SealedInputFileOptions,
} from './sealed-input-file.js'
import type { ProcessIdentity } from './secret-file.js'

export const A0_SEALED_ARTIFACT_ROOT = '/run/proptimiza-a0-sealed'
const HANDLE = /^a0-sealed:([A-Za-z0-9._-]{16,200})$/

export type A0ReadSealedInput = (
  path: string,
  options: SealedInputFileOptions,
) => Promise<Buffer>

export interface PosixA0ArtifactSnapshotVerifierOptions {
  expectedGid: number
  identity?: ProcessIdentity
  readSealed?: A0ReadSealedInput
}

/**
 * Resolves only opaque A0 handles below the fixed read-only POSIX mount. The
 * default reader enforces root ownership, group 0440, one link and O_NOFOLLOW.
 */
export class PosixA0ArtifactSnapshotVerifier implements A0ArtifactSnapshotVerifierPort {
  private readonly readSealed: A0ReadSealedInput
  private readonly expectedGid: number
  private readonly identity:
    | Readonly<{ uid: number; gid: number; groups: readonly number[] }>
    | undefined

  constructor(options: PosixA0ArtifactSnapshotVerifierOptions) {
    if (!Number.isSafeInteger(options.expectedGid) || options.expectedGid < 1)
      throw new Error('A0_ARTIFACT_VERIFIER_CONFIGURATION_INVALID')
    this.readSealed = options.readSealed ?? readSealedInputFile
    this.expectedGid = options.expectedGid
    this.identity = options.identity
      ? Object.freeze({
          uid: options.identity.uid,
          gid: options.identity.gid,
          groups: Object.freeze([...options.identity.groups]),
        })
      : undefined
  }

  async verify(
    input: A0SealedArtifactSnapshot,
  ): Promise<A0ArtifactSnapshotVerification> {
    try {
      const claimedSnapshotSha256 = input.snapshot_sha256
      const references = [
        ...input.fixture_artifacts,
        ...input.profile_artifacts,
      ]
      const handles = references.map((reference) => reference.sealed_handle)
      handles.push(input.snapshot_handle)
      if (new Set(handles).size !== handles.length)
        throw new Error('HANDLE_ALIAS')

      const prepared = references.map((reference) =>
        this.prepareReference(reference),
      )
      const { snapshot_sha256: _claim, ...snapshotBody } = input
      const snapshotBodyBytes = Buffer.from(
        `${JSON.stringify(normalize(snapshotBody))}\n`,
      )
      const expectedSnapshotBytes = Buffer.from(
        `${JSON.stringify(normalize(input))}\n`,
      )
      const snapshotPath = sealedPath(input.snapshot_handle)
      if (digest(snapshotBodyBytes) !== claimedSnapshotSha256)
        throw new Error('SNAPSHOT_DIGEST')

      for (const item of prepared) {
        const bytes = await this.read(item.path, item.bytes)
        if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
          throw new Error('ARTIFACT_DIGEST')
      }
      const snapshotBytes = await this.read(
        snapshotPath,
        expectedSnapshotBytes.length,
      )
      if (!snapshotBytes.equals(expectedSnapshotBytes))
        throw new Error('SNAPSHOT_BYTES')
      return { status: 'verified', snapshot_sha256: claimedSnapshotSha256 }
    } catch {
      return {
        status: 'rejected',
        reason: 'sealed_artifact_verification_failed',
      }
    }
  }

  private prepareReference(reference: A0SealedArtifactReference) {
    if (
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(reference.sha256)
    )
      throw new Error('REFERENCE_INVALID')
    return {
      path: sealedPath(reference.sealed_handle),
      bytes: reference.bytes,
      sha256: reference.sha256,
    }
  }

  private read(path: string, maximumBytes: number) {
    return this.readSealed(path, {
      root: A0_SEALED_ARTIFACT_ROOT,
      expectedGid: this.expectedGid,
      maximumBytes,
      ...(this.identity
        ? {
            identity: {
              uid: this.identity.uid,
              gid: this.identity.gid,
              groups: [...this.identity.groups],
            },
          }
        : {}),
    })
  }
}

function sealedPath(handle: string): string {
  const match = HANDLE.exec(handle)
  if (!match) throw new Error('HANDLE_INVALID')
  const path = posix.join(A0_SEALED_ARTIFACT_ROOT, match[1]!)
  if (!path.startsWith(`${A0_SEALED_ARTIFACT_ROOT}/`))
    throw new Error('HANDLE_INVALID')
  return path
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    )
  return value
}
