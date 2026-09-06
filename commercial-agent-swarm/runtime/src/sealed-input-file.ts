import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, posix } from 'node:path'
import {
  currentProcessIdentity,
  type ProcessIdentity,
  type SecretFileMetadata,
} from './secret-file.js'

export interface SealedInputFileOptions {
  root: string
  expectedGid: number
  maximumBytes: number
  identity?: ProcessIdentity
}

export function validateSealedInputFileMetadata(
  metadata: SecretFileMetadata,
  options: Pick<SealedInputFileOptions, 'expectedGid' | 'maximumBytes'>,
  identity: ProcessIdentity,
): void {
  if (
    identity.gid !== options.expectedGid &&
    !identity.groups.includes(options.expectedGid)
  ) throw new Error('SEALED_INPUT_GROUP_MEMBERSHIP_REQUIRED')
  if (
    !metadata.isFile || metadata.isSymbolicLink || metadata.uid !== 0 ||
    metadata.gid !== options.expectedGid || (metadata.mode & 0o777) !== 0o440 ||
    metadata.nlink !== 1 || !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 || metadata.size > options.maximumBytes
  ) throw new Error('UNSAFE_SEALED_INPUT_FILE')
}

/**
 * Reads exact bytes from one root-owned, single-link, read-only file. The
 * caller supplies a narrow mount root; paths outside that root, aliases and
 * symlinks are rejected before any bytes are accepted.
 */
export async function readSealedInputFile(
  path: string,
  options: SealedInputFileOptions,
): Promise<Buffer> {
  if (process.platform === 'win32' || !isAbsolute(path) || !isAbsolute(options.root))
    throw new Error('UNSAFE_SEALED_INPUT_PATH')
  const root = posix.resolve(options.root)
  const normalized = posix.resolve(path)
  if (
    root !== options.root || normalized !== path ||
    !normalized.startsWith(`${root}/`) ||
    !Number.isSafeInteger(options.expectedGid) || options.expectedGid < 1 ||
    !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1
  ) throw new Error('UNSAFE_SEALED_INPUT_PATH')
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    validateSealedInputFileMetadata({
      isFile: metadata.isFile(),
      isSymbolicLink: metadata.isSymbolicLink(),
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
      size: metadata.size,
      nlink: metadata.nlink,
    }, options, options.identity ?? currentProcessIdentity())
    const value = await handle.readFile()
    if (value.includes(0)) throw new Error('UNSAFE_SEALED_INPUT_FILE')
    return value
  } finally {
    await handle.close()
  }
}
