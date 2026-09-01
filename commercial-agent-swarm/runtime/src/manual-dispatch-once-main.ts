import { pathToFileURL } from 'node:url'
import {
  assertSimulationSafetyBoundary,
  brokerDispatcherEnvironment,
  recordDispatchPhase,
} from './broker-main.js'
import { createBrokerDispatcher } from './runtime-entrypoints.js'
import { createRuntimePersistence } from './production.js'
import {
  assertBrokerServiceIdentity,
  expandDatabaseSecretFiles,
  loadBrokerConfig,
} from './simulation-entrypoint.js'
import type { DeterministicDispatcher } from './dispatch-queue.js'

export interface ManualDispatchOnceDependencies {
  mode: 'manual' | 'automatic'
  a3AdmissionEnabled: boolean
  repository: { externalActionsBlocked(): Promise<boolean> }
  dispatcher: Pick<DeterministicDispatcher, 'runOnce'>
  close(): Promise<void>
}

export async function executeManualDispatchOnce(
  dependencies: ManualDispatchOnceDependencies,
): Promise<{ status: 'processed' | 'idle'; processed: boolean; external_actions: 0 }> {
  try {
    if (dependencies.mode !== 'manual')
      throw new Error('MANUAL_DISPATCH_MODE_REQUIRED')
    await assertSimulationSafetyBoundary(
      dependencies.repository,
      dependencies.a3AdmissionEnabled,
    )
    const processed = await dependencies.dispatcher.runOnce()
    return {
      status: processed ? 'processed' : 'idle',
      processed,
      external_actions: 0,
    }
  } finally {
    await dependencies.close()
  }
}

export async function runManualDispatchOnce(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ status: 'processed' | 'idle'; processed: boolean; external_actions: 0 }> {
  assertBrokerServiceIdentity()
  const config = loadBrokerConfig(environment)
  if (config.mode !== 'simulation' || config.dispatchLoopMode !== 'manual')
    throw new Error('MANUAL_DISPATCH_MODE_REQUIRED')
  const databaseEnvironment = await expandDatabaseSecretFiles(config, environment)
  const persistence = await createRuntimePersistence(databaseEnvironment)
  const dispatcher = createBrokerDispatcher(
    brokerDispatcherEnvironment(environment),
    undefined,
    'broker-dispatcher-1',
    { queue: persistence.dispatchQueue, onPhase: recordDispatchPhase },
  )
  return executeManualDispatchOnce({
    mode: config.dispatchLoopMode,
    a3AdmissionEnabled: config.a3AdmissionEnabled,
    repository: persistence.repository,
    dispatcher,
    close: persistence.close,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runManualDispatchOnce()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stderr.write(`${JSON.stringify({ status: 'failed', external_actions: 0 })}\n`)
    process.exitCode = 1
  }
}
