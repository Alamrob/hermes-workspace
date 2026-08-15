import { join } from 'node:path'
import { validateCommercialSwarm } from '../src/server/commercial-swarm-validator'

const packageRoot = join(process.cwd(), 'commercial-agent-swarm')
const result = validateCommercialSwarm(packageRoot)

console.log(JSON.stringify(result, null, 2))

if (result.errors.length > 0) process.exitCode = 1
