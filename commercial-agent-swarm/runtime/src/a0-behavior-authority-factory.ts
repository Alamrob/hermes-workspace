import {
  PosixA0ArtifactSnapshotVerifier,
  type A0ReadSealedInput,
} from './posix-a0-artifact-snapshot-verifier.js'
import {
  PostgresA0BehaviorLedger,
  type A0BehaviorLedgerDatabasePort,
} from './postgres-a0-behavior-ledger.js'
import type { ProcessIdentity } from './secret-file.js'

export interface A0BehaviorAuthorityAdapterOptions {
  database: A0BehaviorLedgerDatabasePort
  expectedPrincipal: string
  expectedSealedInputGid: number
  sealedInputIdentity?: ProcessIdentity
  readSealed?: A0ReadSealedInput
}

/** Constructs the two narrow A0 authority adapters without performing I/O. */
export function createA0BehaviorAuthorityAdapters(
  options: A0BehaviorAuthorityAdapterOptions,
) {
  return {
    ledger: new PostgresA0BehaviorLedger({
      database: options.database,
      expectedPrincipal: options.expectedPrincipal,
    }),
    artifactSnapshotVerifier: new PosixA0ArtifactSnapshotVerifier({
      expectedGid: options.expectedSealedInputGid,
      ...(options.sealedInputIdentity
        ? { identity: options.sealedInputIdentity }
        : {}),
      ...(options.readSealed ? { readSealed: options.readSealed } : {}),
    }),
  }
}
