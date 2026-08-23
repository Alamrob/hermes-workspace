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

export const ACTIVE_PROFILE_IDS = [
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance',
] as const

type ActiveProfileId = (typeof ACTIVE_PROFILE_IDS)[number]

export const PROFILE_TOOLSETS: Record<ActiveProfileId, Array<string>> = {
  'sales-orchestrator': [],
  'market-account-intelligence': ['web', 'file'],
  'contact-data-steward': ['web', 'file'],
  'qualification-prioritization': [],
  'outreach-draft-manager': ['file'],
  'commercial-qa-compliance': [],
}

export const HERMES_TOOLSET_KEYS = [
  'web',
  'browser',
  'terminal',
  'file',
  'code_execution',
  'vision',
  'image_gen',
  'skills',
  'todo',
  'memory',
  'session_search',
  'clarify',
  'delegation',
  'cronjob',
  'computer_use',
  'messaging',
  'video',
  'video_gen',
  'bfl',
  'x_search',
  'tts',
  'stt',
  'context_engine',
  'homeassistant',
  'spotify',
  'yuanbao',
] as const

export const HERMES_OBSERVABLE_TOOLSET_KEYS = HERMES_TOOLSET_KEYS.filter(
  (toolset) => toolset !== 'messaging',
)

const NATIVE_CONFIG_FIELDS = [
  'model',
  'memory',
  'max_concurrent_sessions',
  'agent',
  'toolsets',
  'platform_toolsets',
  'mcp_servers',
] as const

const PROFILE_PROMPT_CONTRACTS: Record<
  ActiveProfileId,
  { outputTerms: Array<string>; handoffTerms: Array<string> }
> = {
  'sales-orchestrator': {
    outputTerms: ['artifact_id', 'content_hash'],
    handoffTerms: [
      'dispatcher determinista externo',
      'sesión separada',
      'sin overrides',
      'market-account-intelligence',
      'contact-data-steward',
      'qualification-prioritization',
      'outreach-draft-manager',
      'commercial-qa-compliance',
    ],
  },
  'market-account-intelligence': {
    outputTerms: ['account_id', 'fuentes'],
    handoffTerms: ['qualification-prioritization'],
  },
  'contact-data-steward': {
    outputTerms: ['contact_record_id', 'provenance', 'suppression'],
    handoffTerms: ['qualification-prioritization'],
  },
  'qualification-prioritization': {
    outputTerms: ['model_version', 'score', 'tier'],
    handoffTerms: ['outreach-draft-manager'],
  },
  'outreach-draft-manager': {
    outputTerms: ['draft_id', 'draft_only', 'content_hash recibido'],
    handoffTerms: ['commercial-qa-compliance'],
  },
  'commercial-qa-compliance': {
    outputTerms: ['qa_verdict_id', 'verdict', 'content_hash recibido'],
    handoffTerms: ['sales-orchestrator'],
  },
}

const REQUIRED_NATIVE_PROFILE_FILES = [
  'distribution.yaml',
  'SOUL.md',
  'config.yaml',
  'mcp.json',
] as const

const DISTRIBUTION_FIELDS = [
  'name',
  'version',
  'description',
  'hermes_requires',
  'author',
  'license',
  'env_requires',
  'distribution_owned',
] as const

const REQUIRED_AGENT_FILES = [
  'SYSTEM_PROMPT.md',
  'MANIFEST.proposed.yaml',
  'INPUT.schema.json',
  'OUTPUT.schema.json',
  'TOOLS_POLICY.yaml',
  'TESTS.md',
] as const

const privateKeyMarker = ['PRIVATE', 'KEY'].join(' ')

const SECRET_PATTERNS = [
  {
    name: 'private key',
    pattern: new RegExp(
      `-----BEGIN (?:RSA |EC |OPENSSH )?${privateKeyMarker}-----`,
    ),
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
    profiles: number
    prompts: number
    deferredAgents: number
    deferredPrompts: number
    jsonSchemas: number
    yamlDocuments: number
    testCases: number
    rosterWorkers: number
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): Array<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : []
}

function sameStrings(
  actual: unknown,
  expected: ReadonlyArray<string>,
): boolean {
  return JSON.stringify(stringArray(actual)) === JSON.stringify(expected)
}

function sortedKeys(value: JsonRecord): Array<string> {
  return Object.keys(value).sort()
}

function unsupportedKeys(
  value: JsonRecord,
  allowed: ReadonlyArray<string>,
): Array<string> {
  const allowlist = new Set(allowed)
  return sortedKeys(value).filter((key) => !allowlist.has(key))
}

function sectionBody(text: string, section: string): string {
  const marker = `## ${section}`
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const bodyStart = start + marker.length
  const nextSection = text.indexOf('\n## ', bodyStart)
  return text.slice(bodyStart, nextSection < 0 ? undefined : nextSection)
}

function profileToolsets(profileId: string): Array<string> {
  return Object.hasOwn(PROFILE_TOOLSETS, profileId)
    ? PROFILE_TOOLSETS[profileId as ActiveProfileId]
    : []
}

export function validateHermesEffectiveToolSummary(
  text: string,
  expectedEnabled: ReadonlyArray<string>,
  profileId: string,
): Array<string> {
  const errors: Array<string> = []
  const builtIns = new Map<string, boolean>()
  const plugins = new Map<string, boolean>()
  let section: 'built-in' | 'plugin' | null = null
  let sawBuiltInSection = false
  let sawPluginSection = false

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === 'Built-in toolsets (cli):') {
      section = 'built-in'
      sawBuiltInSection = true
      continue
    }
    if (trimmed === 'Plugin toolsets (cli):') {
      section = 'plugin'
      sawPluginSection = true
      continue
    }
    const row = trimmed.match(/^[✓✗]\s+(enabled|disabled)\s+([a-z0-9_]+)\b/u)
    if (!row || !section) continue
    const target = section === 'built-in' ? builtIns : plugins
    target.set(row[2], row[1] === 'enabled')
  }

  if (!sawBuiltInSection || !sawPluginSection) {
    errors.push(`${profileId}: Hermes tool summary is incomplete`)
    return errors
  }

  const knownBuiltIns = new Set<string>(HERMES_OBSERVABLE_TOOLSET_KEYS)
  const unknownBuiltIns = [...builtIns.keys()].filter(
    (toolset) => !knownBuiltIns.has(toolset),
  )
  if (unknownBuiltIns.length > 0) {
    errors.push(
      `${profileId}: Hermes tool summary has unknown built-ins: ${unknownBuiltIns.join(',')}`,
    )
  }
  const missingBuiltIns = HERMES_OBSERVABLE_TOOLSET_KEYS.filter(
    (toolset) => !builtIns.has(toolset),
  )
  if (missingBuiltIns.length > 0) {
    errors.push(
      `${profileId}: Hermes tool summary is missing built-ins: ${missingBuiltIns.join(',')}`,
    )
  }

  const expectedEnabledSet = new Set(expectedEnabled)
  const unexpectedEnabled = [...builtIns]
    .filter(([toolset, enabled]) => enabled && !expectedEnabledSet.has(toolset))
    .map(([toolset]) => toolset)
  if (unexpectedEnabled.length > 0) {
    errors.push(
      `${profileId}: effective built-in toolsets exceed allowlist: ${unexpectedEnabled.join(',')}`,
    )
  }
  const missingEnabled = expectedEnabled.filter(
    (toolset) => builtIns.get(toolset) !== true,
  )
  if (missingEnabled.length > 0) {
    errors.push(
      `${profileId}: effective built-in toolsets are missing: ${missingEnabled.join(',')}`,
    )
  }

  const enabledPlugins = [...plugins]
    .filter(([, enabled]) => enabled)
    .map(([toolset]) => toolset)
  if (enabledPlugins.length > 0) {
    errors.push(
      `${profileId}: plugin toolsets must all be disabled: ${enabledPlugins.join(',')}`,
    )
  }

  return errors
}

export function validateNativeProfileConfig(
  value: unknown,
  profileId: string,
): Array<string> {
  const errors: Array<string> = []
  if (!isRecord(value)) return [`${profileId}: config.yaml must be a mapping`]

  const unsupportedConfigKeys = unsupportedKeys(value, NATIVE_CONFIG_FIELDS)
  if (unsupportedConfigKeys.length > 0) {
    errors.push(
      `${profileId}: config.yaml contains unsupported keys ${unsupportedConfigKeys.join(',')}`,
    )
  }

  const expectedToolsets = profileToolsets(profileId)
  const expectedLabel = expectedToolsets.join(',')
  const configuredToolsets = [...expectedToolsets, 'no_mcp']
  if (!sameStrings(value.toolsets, configuredToolsets)) {
    errors.push(
      `${profileId}: CLI toolsets must equal ${expectedLabel} plus no_mcp sentinel`,
    )
  }

  const platformToolsets = isRecord(value.platform_toolsets)
    ? value.platform_toolsets
    : null
  if (
    !platformToolsets ||
    JSON.stringify(sortedKeys(platformToolsets)) !== JSON.stringify(['cli']) ||
    !sameStrings(platformToolsets.cli, configuredToolsets)
  ) {
    errors.push(
      `${profileId}: platform_toolsets must contain only the exact CLI toolsets`,
    )
  }

  const model = isRecord(value.model) ? value.model : null
  if (
    !model ||
    unsupportedKeys(model, ['default', 'provider', 'max_tokens']).length > 0 ||
    model.default !== 'deepseek-v4-flash' ||
    model.provider !== 'opencode-go'
  ) {
    errors.push(`${profileId}: model must use the confirmed opencode-go provider`)
  }
  if (model?.max_tokens !== 4096) {
    errors.push(`${profileId}: model.max_tokens must equal 4096`)
  }

  const memory = isRecord(value.memory) ? value.memory : null
  if (
    !memory ||
    unsupportedKeys(memory, [
      'memory_enabled',
      'user_profile_enabled',
      'write_approval',
    ]).length > 0 ||
    memory.memory_enabled !== false ||
    memory.user_profile_enabled !== false ||
    memory.write_approval !== true
  ) {
    errors.push(`${profileId}: durable model memory must be disabled`)
  }
  if (value.max_concurrent_sessions !== 1) {
    errors.push(`${profileId}: max_concurrent_sessions must be 1`)
  }

  const agent = isRecord(value.agent) ? value.agent : null
  if (
    agent &&
    unsupportedKeys(agent, ['max_turns', 'disabled_toolsets']).length > 0
  ) {
    errors.push(
      `${profileId}: agent may contain only max_turns and disabled_toolsets`,
    )
  }
  if (agent?.max_turns !== 6) {
    errors.push(`${profileId}: agent.max_turns must equal 6`)
  }
  const expectedDisabledToolsets = HERMES_TOOLSET_KEYS.filter(
    (toolset) => !expectedToolsets.includes(toolset),
  )
  if (!sameStrings(agent?.disabled_toolsets, expectedDisabledToolsets)) {
    errors.push(
      `${profileId}: agent.disabled_toolsets must deny every non-permitted Hermes 0.20.1 toolset`,
    )
  }

  if (
    !isRecord(value.mcp_servers) ||
    sortedKeys(value.mcp_servers).length > 0
  ) {
    errors.push(`${profileId}: mcp_servers must be an empty mapping`)
  }

  return errors
}

export function validateNativeProfileSoul(
  text: string,
  profileId: string,
): Array<string> {
  const errors = validateSystemPrompt(text, `${profileId}: SOUL.md`)
  if (!Object.hasOwn(PROFILE_PROMPT_CONTRACTS, profileId)) {
    return [
      ...errors,
      `${profileId}: SOUL.md does not belong to an active profile`,
    ]
  }

  const normalized = text.toLocaleLowerCase('es')
  for (const term of [
    'operación sin planillas',
    'clp 1.800.000',
    '10–100 personas',
  ]) {
    if (!normalized.includes(term)) {
      errors.push(`${profileId}: SOUL.md is missing offer/ICP term ${term}`)
    }
  }

  const permissions = sectionBody(text, 'Permisos').toLocaleLowerCase('es')
  for (const term of ['a3 no está disponible', 'a4 es humano']) {
    if (!permissions.includes(term)) {
      errors.push(
        `${profileId}: SOUL.md Permisos is missing autonomy term ${term}`,
      )
    }
  }

  const contract = PROFILE_PROMPT_CONTRACTS[profileId as ActiveProfileId]
  const outputs = sectionBody(text, 'Salidas').toLocaleLowerCase('es')
  for (const term of contract.outputTerms) {
    if (!outputs.includes(term)) {
      errors.push(
        `${profileId}: SOUL.md Salidas is missing contract term ${term}`,
      )
    }
  }
  const handoffs = sectionBody(text, 'Handoffs').toLocaleLowerCase('es')
  for (const term of contract.handoffTerms) {
    if (!handoffs.includes(term)) {
      errors.push(
        `${profileId}: SOUL.md Handoffs is missing contract term ${term}`,
      )
    }
  }

  return errors
}

function validateDistributionManifest(
  value: unknown,
  profileId: ActiveProfileId,
): Array<string> {
  const label = `profiles/${profileId}/distribution.yaml`
  if (!isRecord(value)) return [`${label}: manifest must be a mapping`]
  const errors: Array<string> = []

  if (
    JSON.stringify(sortedKeys(value)) !==
    JSON.stringify([...DISTRIBUTION_FIELDS].sort())
  ) {
    errors.push(`${label}: manifest fields do not match the Hermes contract`)
  }
  if (value.name !== profileId)
    errors.push(`${label}: name must match profile id`)
  if (value.version !== '0.1.0') errors.push(`${label}: version must be 0.1.0`)
  if (value.hermes_requires !== '>=0.20.1') {
    errors.push(`${label}: hermes_requires must be >=0.20.1`)
  }
  if (
    typeof value.description !== 'string' ||
    value.description.trim().length === 0 ||
    typeof value.author !== 'string' ||
    value.author.trim().length === 0 ||
    typeof value.license !== 'string' ||
    value.license.trim().length === 0
  ) {
    errors.push(`${label}: description, author and license are required`)
  }

  const envRequires = Array.isArray(value.env_requires)
    ? value.env_requires
    : []
  const customKey = envRequires.length === 1 ? envRequires[0] : null
  if (
    !isRecord(customKey) ||
    customKey.name !== 'OPENCODE_GO_API_KEY' ||
    customKey.required !== true ||
    typeof customKey.description !== 'string' ||
    customKey.description.trim().length === 0 ||
    Object.hasOwn(customKey, 'value') ||
    Object.hasOwn(customKey, 'default')
  ) {
    errors.push(
      `${label}: env_requires must declare only required OPENCODE_GO_API_KEY without a value`,
    )
  }

  if (!sameStrings(value.distribution_owned, REQUIRED_NATIVE_PROFILE_FILES)) {
    errors.push(
      `${label}: distribution_owned must list only native distribution files`,
    )
  }

  return errors
}

function validateNativeProfiles(
  root: string,
  errors: Array<string>,
): Array<string> {
  const profilesRoot = join(root, 'profiles')
  if (!existsSync(profilesRoot)) {
    errors.push('profiles: native profile directory missing')
    for (const profileId of ACTIVE_PROFILE_IDS) {
      errors.push(`profiles/${profileId}: native profile missing`)
    }
    return []
  }

  const profileIds = readdirSync(profilesRoot)
    .filter((name) => statSync(join(profilesRoot, name)).isDirectory())
    .sort()
  const expectedProfileIds = [...ACTIVE_PROFILE_IDS].sort()
  if (JSON.stringify(profileIds) !== JSON.stringify(expectedProfileIds)) {
    errors.push('profiles: directories must equal the six active profile ids')
  }

  for (const profileId of ACTIVE_PROFILE_IDS) {
    const profileRoot = join(profilesRoot, profileId)
    if (!existsSync(profileRoot)) {
      errors.push(`profiles/${profileId}: native profile missing`)
      continue
    }
    for (const requiredFile of REQUIRED_NATIVE_PROFILE_FILES) {
      const path = join(profileRoot, requiredFile)
      if (!existsSync(path)) {
        errors.push(`${displayPath(root, path)}: required profile file missing`)
      }
    }

    const distributionPath = join(profileRoot, 'distribution.yaml')
    if (existsSync(distributionPath)) {
      try {
        errors.push(
          ...validateDistributionManifest(
            yaml.parse(readFileSync(distributionPath, 'utf8')),
            profileId,
          ),
        )
      } catch (error) {
        errors.push(
          `${displayPath(root, distributionPath)}: invalid distribution manifest (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }

    const configPath = join(profileRoot, 'config.yaml')
    if (existsSync(configPath)) {
      try {
        errors.push(
          ...validateNativeProfileConfig(
            yaml.parse(readFileSync(configPath, 'utf8')),
            profileId,
          ).map((error) => `profiles/${error}`),
        )
      } catch (error) {
        errors.push(
          `${displayPath(root, configPath)}: invalid profile config (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }

    const soulPath = join(profileRoot, 'SOUL.md')
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, 'utf8')
      errors.push(...validateNativeProfileSoul(soul, profileId))
    }

    const mcpPath = join(profileRoot, 'mcp.json')
    if (existsSync(mcpPath)) {
      try {
        const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as unknown
        if (
          !isRecord(mcp) ||
          !isRecord(mcp.mcpServers) ||
          sortedKeys(mcp).length !== 1 ||
          sortedKeys(mcp.mcpServers).length !== 0
        ) {
          errors.push(
            `${displayPath(root, mcpPath)}: mcpServers must be an empty mapping`,
          )
        }
      } catch (error) {
        errors.push(
          `${displayPath(root, mcpPath)}: invalid MCP JSON (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
  }

  return profileIds
}

function listFiles(root: string): Array<string> {
  if (!existsSync(root)) return []
  const files: Array<string> = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (
      entry.isDirectory() &&
      !['node_modules', 'dist', 'build', '.git'].includes(entry.name)
    )
      files.push(...listFiles(path))
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

  const deferredAgentIds = validateAgentArtifacts(
    root,
    join(root, 'agents'),
    errors,
  )
  const profileIds = validateNativeProfiles(root, errors)
  const orchestratorRoot = join(root, 'orchestrator')
  for (const requiredFile of REQUIRED_AGENT_FILES) {
    const path = join(orchestratorRoot, requiredFile)
    if (!existsSync(path))
      errors.push(
        `${displayPath(root, path)}: required orchestrator artifact missing`,
      )
  }

  const promptPaths = files.filter(
    (file) => file.endsWith('SYSTEM_PROMPT.md') || file.endsWith('SOUL.md'),
  )
  const activePromptPaths = promptPaths.filter((file) =>
    file.endsWith('SOUL.md'),
  )
  const deferredPromptPaths = promptPaths.filter((file) =>
    file.endsWith('SYSTEM_PROMPT.md'),
  )
  for (const path of promptPaths) {
    if (path.endsWith('SOUL.md')) continue
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
    if (
      JSON.stringify(rosterWorkerIds) !== JSON.stringify(ACTIVE_PROFILE_IDS)
    ) {
      errors.push(
        'deployment/swarm.proposed.yaml: active roster must equal the six native profiles in order',
      )
    }
    for (const worker of roster.workers) {
      const expectedTools = profileToolsets(worker.id)
      if (worker.profile !== worker.id) {
        errors.push(
          `deployment/swarm.proposed.yaml: ${worker.id} profile must match worker id`,
        )
      }
      if (worker.model !== 'deepseek-v4-flash') {
        errors.push(
          `deployment/swarm.proposed.yaml: ${worker.id} must pin deepseek-v4-flash`,
        )
      }
      if (!sameStrings(worker.tools, expectedTools)) {
        errors.push(
          `deployment/swarm.proposed.yaml: ${worker.id} tools exceed its native profile`,
        )
      }
      if (
        worker.skills.length > 0 ||
        worker.plugins.length > 0 ||
        worker.pluginToolsets.length > 0 ||
        worker.mcpServers.length > 0
      ) {
        errors.push(
          `deployment/swarm.proposed.yaml: ${worker.id} cannot enable skills, plugins or MCP servers`,
        )
      }
      if (worker.maxConcurrentTasks !== 1) {
        errors.push(
          `deployment/swarm.proposed.yaml: ${worker.id} maxConcurrentTasks must be 1`,
        )
      }
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
    const matrixAgents =
      isRecord(matrix) && isRecord(matrix.agents) ? matrix.agents : {}
    if (
      JSON.stringify(Object.keys(matrixAgents)) !==
      JSON.stringify(ACTIVE_PROFILE_IDS)
    ) {
      errors.push(
        'tests/agent-test-matrix.yaml: agents must equal the six active profiles in order',
      )
    }
    for (const profileId of ACTIVE_PROFILE_IDS) {
      const matrixAgent = matrixAgents[profileId]
      if (
        !isRecord(matrixAgent) ||
        !sameStrings(matrixAgent.requiredCases, expectedCases)
      ) {
        errors.push(
          `tests/agent-test-matrix.yaml: ${profileId} must require T01 through T16`,
        )
      }
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
      agents: profileIds.length,
      profiles: profileIds.length,
      prompts: activePromptPaths.length,
      deferredAgents: deferredAgentIds.length,
      deferredPrompts: deferredPromptPaths.length,
      jsonSchemas: files.filter((file) => file.endsWith('.json')).length,
      yamlDocuments: files.filter((file) => /\.ya?ml$/i.test(file)).length,
      testCases,
      rosterWorkers: rosterWorkerIds.length,
    },
  }
}
