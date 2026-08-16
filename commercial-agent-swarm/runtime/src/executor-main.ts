import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  NodeProcessRunner,
  PosixHomeOwnershipPreparer,
} from './hermes-executor.js'
import { loadExecutorRuntimeConfig } from './runtime-config.js'
import { createExecutorServer } from './runtime-entrypoints.js'
import { assertExecutorSupervisorSecurity } from './supervisor-security.js'

export async function startExecutorProcess(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ close(): Promise<void> }> {
  if (process.platform !== 'linux' || process.argv.length !== 2)
    throw new Error('EXECUTOR_ENTRYPOINT_INVALID')
  assertExecutorSupervisorSecurity({
    pid: process.pid,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    status: await readFile('/proc/self/status', 'utf8'),
  })
  const config = loadExecutorRuntimeConfig(environment)
  const server = createExecutorServer(
    environment,
    new NodeProcessRunner(),
    new PosixHomeOwnershipPreparer(
      config.temporaryRoot,
      config.executorUid,
      config.executorGid,
    ),
  )
  await server.start()
  return { close: () => server.stop() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const processHandle = await startExecutorProcess()
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await processHandle.close()
  }
  process.once('SIGTERM', () => void close())
  process.once('SIGINT', () => void close())
}
