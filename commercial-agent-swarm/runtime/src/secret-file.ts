import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export interface SecretFileMetadata {
  isFile: boolean
  isSymbolicLink: boolean
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
}

export interface ProcessIdentity {
  uid: number
  gid: number
  groups: number[]
}

export function currentProcessIdentity(): ProcessIdentity {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined)
    throw new Error('POSIX_IDENTITY_REQUIRED')
  return { uid, gid, groups: process.getgroups?.() ?? [gid] }
}

export function assertPrimaryServiceGid(
  expectedGid: number,
  actualGid = process.getgid?.(),
): number {
  if (!Number.isSafeInteger(expectedGid) || expectedGid < 1 || actualGid !== expectedGid)
    throw new Error('SERVICE_PRIMARY_GID_INVALID')
  return expectedGid
}

export function validateGroupSecretFileMetadata(
  metadata: SecretFileMetadata,
  expectedGid: number,
  identity: ProcessIdentity,
): void {
  if (
    identity.gid !== expectedGid &&
    !identity.groups.includes(expectedGid)
  )
    throw new Error('SECRET_GROUP_MEMBERSHIP_REQUIRED')
  if (
    !metadata.isFile ||
    metadata.isSymbolicLink ||
    metadata.uid !== 0 ||
    metadata.gid !== expectedGid ||
    (metadata.mode & 0o777) !== 0o440 ||
    metadata.nlink !== 1 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > 16_384
  )
    throw new Error('UNSAFE_SECRET_FILE')
}

export async function readGroupSecretFile(
  path: string,
  expectedGid = 10000,
  identity = currentProcessIdentity(),
): Promise<string> {
  if (!isAbsolute(path) || process.platform === 'win32')
    throw new Error('UNSAFE_SECRET_FILE')
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  )
  try {
    const metadata = await handle.stat()
    validateGroupSecretFileMetadata(
      {
        isFile: metadata.isFile(),
        isSymbolicLink: metadata.isSymbolicLink(),
        uid: metadata.uid,
        gid: metadata.gid,
        mode: metadata.mode,
        size: metadata.size,
        nlink: metadata.nlink,
      },
      expectedGid,
      identity,
    )
    const value = (await handle.readFile('utf8')).trim()
    if (!value || value.includes('\u0000')) throw new Error('UNSAFE_SECRET_FILE')
    return value
  } finally {
    await handle.close()
  }
}
