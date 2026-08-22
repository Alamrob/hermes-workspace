import { pathToFileURL } from 'node:url'
import { createWorkspaceInstructionGateway } from './workspace-instruction-gateway.js'
import { readGroupSecretFile } from './secret-file.js'

const SERVICE_UID = 10015
const SERVICE_GID = 10015

export function loadWorkspaceInstructionGatewayConfig(environment: Record<string, string | undefined>) {
  if (environment.NODE_ENV !== 'production' || environment.COMMERCIAL_MODE !== 'simulation')
    throw new Error('WORKSPACE_GATEWAY_MODE_INVALID')
  if (environment.A3_ENABLED !== 'false' || environment.EXTERNAL_ACTION_KILL_SWITCH !== 'true')
    throw new Error('WORKSPACE_GATEWAY_EXTERNAL_GUARD_INVALID')
  if (environment.WORKSPACE_API_BEARER !== undefined || environment.BROKER_INSTRUCTION_BEARER !== undefined)
    throw new Error('WORKSPACE_GATEWAY_RAW_SECRET_FORBIDDEN')
  const workspaceBearerFile = requiredSecretPath(environment.WORKSPACE_API_BEARER_FILE)
  const brokerBearerFile = requiredSecretPath(environment.BROKER_INSTRUCTION_BEARER_FILE)
  if (workspaceBearerFile === brokerBearerFile) throw new Error('WORKSPACE_GATEWAY_SECRET_PATH_REUSE')
  if (environment.WORKSPACE_GATEWAY_HOST !== '0.0.0.0' || environment.WORKSPACE_GATEWAY_PORT !== '8642')
    throw new Error('WORKSPACE_GATEWAY_LISTENER_INVALID')
  if (environment.BROKER_API_BASE !== 'http://broker:8080') throw new Error('WORKSPACE_GATEWAY_BROKER_INVALID')
  if (environment.WORKSPACE_REQUESTED_BY !== 'proptimizaspa@gmail.com')
    throw new Error('WORKSPACE_GATEWAY_REQUESTER_INVALID')
  return {
    host: '0.0.0.0' as const,
    port: 8642,
    workspaceBearerFile,
    brokerBearerFile,
    brokerBase: 'http://broker:8080' as const,
    requestedBy: environment.WORKSPACE_REQUESTED_BY,
  }
}

export async function startWorkspaceInstructionGateway(
  environment: Record<string, string | undefined> = process.env,
) {
  assertIdentity()
  const config = loadWorkspaceInstructionGatewayConfig(environment)
  const [workspaceBearer, brokerBearer] = await Promise.all([
    readGroupSecretFile(config.workspaceBearerFile, SERVICE_GID),
    readGroupSecretFile(config.brokerBearerFile, SERVICE_GID),
  ])
  const server = createWorkspaceInstructionGateway({
    ...config,
    workspaceBearer,
    brokerBearer,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  }
}

function requiredSecretPath(value: string | undefined): string {
  if (!value?.startsWith('/run/secrets/')) throw new Error('WORKSPACE_GATEWAY_SECRET_FILE_REQUIRED')
  return value
}

function assertIdentity() {
  if (process.platform === 'win32') return
  if (process.getuid?.() !== SERVICE_UID || process.getgid?.() !== SERVICE_GID)
    throw new Error('WORKSPACE_GATEWAY_IDENTITY_INVALID')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await startWorkspaceInstructionGateway()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void service.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

