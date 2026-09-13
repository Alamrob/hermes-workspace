import {
  PosixA0ArtifactSnapshotVerifier,
  type A0ReadSealedInput,
} from './posix-a0-artifact-snapshot-verifier.js'
import {
  PostgresA0BehaviorLedger,
  type A0BehaviorLedgerDatabasePort,
} from './postgres-a0-behavior-ledger.js'
import type { ProcessIdentity } from './secret-file.js'
import {
  Ed25519A0BatchAuthorizationVerifier,
  type Ed25519A0BatchAuthorizationVerifierOptions,
} from './a0-batch-authorization.js'

export interface A0BehaviorAuthorityAdapterOptions {
  database: A0BehaviorLedgerDatabasePort
  expectedPrincipal: string
  expectedSealedInputGid: number
  sealedInputIdentity?: ProcessIdentity
  readSealed?: A0ReadSealedInput
  authorization: Ed25519A0BatchAuthorizationVerifierOptions
}

/** Constructs the three narrow A0 authority adapters without performing I/O. */
export function createA0BehaviorAuthorityAdapters(
  options: A0BehaviorAuthorityAdapterOptions,
) {
  return {
    ledger: new PostgresA0BehaviorLedger({
      database: options.database,
      expectedPrincipal: options.expectedPrincipal,
    }),
    authorizationVerifier: new Ed25519A0BatchAuthorizationVerifier(
      options.authorization,
    ),
    artifactSnapshotVerifier: new PosixA0ArtifactSnapshotVerifier({
      expectedGid: options.expectedSealedInputGid,
      ...(options.sealedInputIdentity
        ? { identity: options.sealedInputIdentity }
        : {}),
      ...(options.readSealed ? { readSealed: options.readSealed } : {}),
    }),
  }
}
