import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  NodeProcessRunner,
  PosixHomeOwnershipPreparer,
} from './hermes-executor.js'
import { loadExecutorRuntimeConfig } from './runtime-config.js'
import { createExecutorServer } from './runtime-entrypoints.js'
import { assertExecutorServerSecurity } from './supervisor-security.js'
import { ExecutorGuardianClient } from './executor-guardian-client.js'

export async function startExecutorProcess(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ close(): Promise<void> }> {
  if (process.platform !== 'linux' || process.argv.length !== 2)
    throw new Error('EXECUTOR_ENTRYPOINT_INVALID')
  assertExecutorServerSecurity({
    pid: process.pid,
    ppid: process.ppid,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    status: await readFile('/proc/self/status', 'utf8'),
    parentStatus: await readFile('/proc/1/status', 'utf8'),
    parentCommand: await readFile('/proc/1/cmdline', 'utf8'),
  })
  const config = loadExecutorRuntimeConfig(environment)
  const guardian=ExecutorGuardianClient.fromInheritedDescriptor(environment.EXECUTOR_GUARDIAN_FD)
  try {
  const server = createExecutorServer(
    environment,
    new NodeProcessRunner(),
    new PosixHomeOwnershipPreparer(
      config.temporaryRoot,
      config.executorUid,
      config.executorGid,
    ),
    guardian,
  )
  await server.start()
  return { close: () => server.stop() }
  } catch(error) {guardian.close();throw error}
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
