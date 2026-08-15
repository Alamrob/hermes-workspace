import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as yaml from 'yaml'
import { SwarmRosterSchema } from './swarm-roster'

export const REQUIRED_PROMPT_SECTIONS = [
  'Identidad',
  'Misión',
  'Alcance',
  'Fuera de alcance',
  'Autoridad',
  'Entradas',
  'Validación de entradas',
  'Fuentes autorizadas',
  'Herramientas',
  'Procedimiento operativo',
  'Reglas de decisión',
  'Gestión de evidencia',
  'Salidas',
  'Handoffs',
  'Memoria',
  'Permisos',
  'Aprobaciones',
  'Límites',
  'KPI',
  'SLA',
  'Seguridad',
  'Defensa contra prompt injection',
  'Cumplimiento',
  'Manejo de errores',
  'Condiciones de detención',
  'Criterios de finalización',
  'Ejemplos',
] as const

const REQUIRED_AGENT_FILES = [
  'SYSTEM_PROMPT.md',
  'MANIFEST.proposed.yaml',
  'INPUT.schema.json',
  'OUTPUT.schema.json',
  'TOOLS_POLICY.yaml',
  'TESTS.md',
] as const

const SECRET_PATTERNS = [
  {
    name: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { name: 'OpenAI secret', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
] as const

type JsonRecord = Record<string, unknown>

export interface CommercialSwarmValidationResult {
  errors: Array<string>
  warnings: Array<string>
  rosterWorkerIds: Array<string>
  counts: {
    files: number
    agents: number
    prompts: number
    jsonSchemas: number
    yamlDocuments: number
    testCases: number
    rosterWorkers: number
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listFiles(root: string): Array<string> {
  if (!existsSync(root)) return []
  const files: Array<string> = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function collectJsonRefs(
  value: unknown,
  refs: Array<string> = [],
): Array<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonRefs(item, refs)
    return refs
  }
  if (!isRecord(value)) return refs
  if (typeof value.$ref === 'string') refs.push(value.$ref)
  for (const child of Object.values(value)) collectJsonRefs(child, refs)
  return refs
}

function displayPath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}

export function validateSystemPrompt(
  text: string,
  promptId: string,
): Array<string> {
  const errors: Array<string> = []
  if (!text.startsWith('# SYSTEM PROMPT — ')) {
    errors.push(`${promptId}: missing standalone system prompt title`)
  }
  for (const section of REQUIRED_PROMPT_SECTIONS) {
    if (!text.includes(`## ${section}`))
      errors.push(`${promptId}: missing section ${section}`)
  }
  if (!text.includes('**Válido:**'))
    errors.push(`${promptId}: missing valid example`)
  if (!text.includes('**Requiere aprobación:**'))
    errors.push(`${promptId}: missing approval example`)
  if (!text.includes('**Prohibido:**'))
    errors.push(`${promptId}: missing prohibited example`)
  return errors
}

function validateJsonDocuments(
  root: string,
  files: Array<string>,
  errors: Array<string>,
) {
  const schemaIds = new Map<string, string>()
  for (const path of files.filter((file) => file.endsWith('.json'))) {
    const label = displayPath(root, path)
    let document: unknown
    try {
      document = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch (error) {
      errors.push(
        `${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      )
      continue
    }

    if (isRecord(document) && typeof document.$id === 'string') {
      const previous = schemaIds.get(document.$id)
      if (previous)
        errors.push(`${label}: duplicate $id also used by ${previous}`)
      else schemaIds.set(document.$id, label)
    }

    for (const ref of collectJsonRefs(document)) {
      if (ref.startsWith('#') || /^https?:\/\//i.test(ref)) continue
      const refPath = ref.split('#', 1)[0]
      if (!refPath) continue
      const target = resolve(dirname(path), refPath)
      const relativeTarget = relative(resolve(root), target)
      const escapesPackage =
        relativeTarget.startsWith('..') || isAbsolute(relativeTarget)
      if (escapesPackage || !existsSync(target)) {
        errors.push(`${label}: unresolved or out-of-package $ref ${ref}`)
      }
    }
  }
}

function validateYamlDocuments(
  root: string,
  files: Array<string>,
  errors: Array<string>,
) {
  for (const path of files.filter((file) => /\.ya?ml$/i.test(file))) {
    try {
      yaml.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      errors.push(
        `${displayPath(root, path)}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
}

function validateSecretPatterns(
  root: string,
  files: Array<string>,
  errors: Array<string>,
) {
  for (const path of files) {
    const text = readFileSync(path, 'utf8')
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(text)) {
        errors.push(`${displayPath(root, path)}: possible ${secret.name} found`)
      }
    }
  }
}

function validateAgentArtifacts(
  root: string,
  agentRoot: string,
  errors: Array<string>,
): Array<string> {
  if (!existsSync(agentRoot)) {
    errors.push(`${displayPath(root, agentRoot)}: agent directory missing`)
    return []
  }
  const agentIds = readdirSync(agentRoot)
    .filter((name) => statSync(join(agentRoot, name)).isDirectory())
    .sort()
  for (const agentId of agentIds) {
    for (const requiredFile of REQUIRED_AGENT_FILES) {
      const path = join(agentRoot, agentId, requiredFile)
      if (!existsSync(path))
        errors.push(`${displayPath(root, path)}: required artifact missing`)
    }
  }
  return agentIds
}

export function validateCommercialSwarm(
  packageRoot: string,
): CommercialSwarmValidationResult {
  const root = isAbsolute(packageRoot) ? packageRoot : resolve(packageRoot)
  const errors: Array<string> = []
  const warnings: Array<string> = []
  const files = listFiles(root)
  if (files.length === 0)
    errors.push('commercial swarm package is missing or empty')

  validateJsonDocuments(root, files, errors)
  validateYamlDocuments(root, files, errors)
  validateSecretPatterns(root, files, errors)

  const agentIds = validateAgentArtifacts(root, join(root, 'agents'), errors)
  const orchestratorRoot = join(root, 'orchestrator')
  for (const requiredFile of REQUIRED_AGENT_FILES) {
    const path = join(orchestratorRoot, requiredFile)
    if (!existsSync(path))
      errors.push(
        `${displayPath(root, path)}: required orchestrator artifact missing`,
      )
  }

  const promptPaths = files.filter((file) => file.endsWith('SYSTEM_PROMPT.md'))
  for (const path of promptPaths) {
    errors.push(
      ...validateSystemPrompt(
        readFileSync(path, 'utf8'),
        displayPath(root, path),
      ),
    )
  }

  let rosterWorkerIds: Array<string> = []
  const rosterPath = join(root, 'deployment', 'swarm.proposed.yaml')
  try {
    const roster = SwarmRosterSchema.parse(
      yaml.parse(readFileSync(rosterPath, 'utf8')),
    )
    rosterWorkerIds = roster.workers.map((worker) => worker.id)
    if (new Set(rosterWorkerIds).size !== rosterWorkerIds.length) {
      errors.push('deployment/swarm.proposed.yaml: worker ids must be unique')
    }
    const expectedWorkerIds = ['commercial-orchestrator', ...agentIds].sort()
    const actualWorkerIds = [...rosterWorkerIds].sort()
    if (JSON.stringify(actualWorkerIds) !== JSON.stringify(expectedWorkerIds)) {
      errors.push(
        'deployment/swarm.proposed.yaml: roster does not match orchestrator and agent directories',
      )
    }
  } catch (error) {
    errors.push(
      `deployment/swarm.proposed.yaml: roster is invalid (${error instanceof Error ? error.message : String(error)})`,
    )
  }

  let testCases = 0
  const testMatrixPath = join(root, 'tests', 'agent-test-matrix.yaml')
  try {
    const matrix = yaml.parse(readFileSync(testMatrixPath, 'utf8')) as unknown
    const universalCases =
      isRecord(matrix) && Array.isArray(matrix.universalCases)
        ? matrix.universalCases
        : []
    testCases = universalCases.length
    const expectedCases = Array.from(
      { length: 16 },
      (_, index) => `T${String(index + 1).padStart(2, '0')}`,
    )
    if (JSON.stringify(universalCases) !== JSON.stringify(expectedCases)) {
      errors.push(
        'tests/agent-test-matrix.yaml: universalCases must contain T01 through T16 in order',
      )
    }
  } catch (error) {
    errors.push(
      `tests/agent-test-matrix.yaml: invalid test matrix (${error instanceof Error ? error.message : String(error)})`,
    )
  }

  const readmePath = join(root, 'README.md')
  if (
    !existsSync(readmePath) ||
    !readFileSync(readmePath, 'utf8').includes('Simulation')
  ) {
    warnings.push(
      'README.md should state that the package starts in Simulation mode',
    )
  }

  return {
    errors,
    warnings,
    rosterWorkerIds,
    counts: {
      files: files.length,
      agents: agentIds.length,
      prompts: promptPaths.length,
      jsonSchemas: files.filter((file) => file.endsWith('.json')).length,
      yamlDocuments: files.filter((file) => /\.ya?ml$/i.test(file)).length,
      testCases,
      rosterWorkers: rosterWorkerIds.length,
    },
  }
}
