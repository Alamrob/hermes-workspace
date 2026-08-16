import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'yaml'
import {
  REQUIRED_PROMPT_SECTIONS,
  validateCommercialSwarm,
  validateHermesEffectiveToolSummary,
  validateNativeProfileConfig,
  validateNativeProfileSoul,
  validateSystemPrompt,
} from './commercial-swarm-validator'

const packageRoot = join(process.cwd(), 'commercial-agent-swarm')

const activeProfileIds = [
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance',
]

const hermes0201Toolsets = [
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
]

const expectedProfileToolsets: Record<string, Array<string>> = {
  'sales-orchestrator': ['file', 'todo', 'session_search'],
  'market-account-intelligence': ['web', 'file'],
  'contact-data-steward': ['web', 'file'],
  'qualification-prioritization': ['file'],
  'outreach-draft-manager': ['file'],
  'commercial-qa-compliance': ['file'],
}

function readProfileConfig(profileId: string): Record<string, unknown> {
  return yaml.parse(
    readFileSync(
      join(packageRoot, 'profiles', profileId, 'config.yaml'),
      'utf8',
    ),
  ) as Record<string, unknown>
}

describe('commercial swarm package validator', () => {
  it('accepts the committed simulation-only package', () => {
    const result = validateCommercialSwarm(packageRoot)

    expect(result.errors).toEqual([])
    expect(result.counts.agents).toBe(6)
    expect(result.counts.profiles).toBe(6)
    expect(result.counts.prompts).toBe(6)
    expect(result.counts.deferredAgents).toBe(10)
    expect(result.counts.deferredPrompts).toBe(11)
    expect(result.counts.testCases).toBe(16)
    expect(result.counts.rosterWorkers).toBe(6)
  })

  it('rejects an incomplete standalone system prompt', () => {
    const result = validateSystemPrompt(
      '# SYSTEM PROMPT — INCOMPLETE\n\n## Identidad\n\nNo contiene el contrato requerido.',
      'incomplete',
    )

    expect(result).toContain(
      `incomplete: missing section ${REQUIRED_PROMPT_SECTIONS[1]}`,
    )
    expect(result.some((error) => error.includes('valid example'))).toBe(true)
    expect(result.some((error) => error.includes('approval example'))).toBe(
      true,
    )
    expect(result.some((error) => error.includes('prohibited example'))).toBe(
      true,
    )
  })

  it('exposes only the six native Hermes profiles in the active roster', () => {
    const result = validateCommercialSwarm(packageRoot)

    expect(result.rosterWorkerIds).toEqual(activeProfileIds)
  })

  it('pins every native profile to the OpenCode Go endpoint', () => {
    for (const profileId of activeProfileIds) {
      const config = readProfileConfig(profileId)
      const providers = config.custom_providers as Array<
        Record<string, unknown>
      >

      expect(providers[0].base_url, profileId).toBe(
        'https://opencode.ai/zen/go/v1',
      )
      expect(`${providers[0].base_url}/chat/completions`, profileId).toBe(
        'https://opencode.ai/zen/go/v1/chat/completions',
      )
    }
  })

  it('grants exact profile toolsets and disables every other Hermes 0.20.1 toolset', () => {
    for (const profileId of activeProfileIds) {
      const config = readProfileConfig(profileId)
      const expected = expectedProfileToolsets[profileId]
      const expectedConfigured = [...expected, 'no_mcp']
      const platformToolsets = config.platform_toolsets as Record<
        string,
        unknown
      >
      const agent = config.agent as Record<string, unknown>
      const expectedDisabled = hermes0201Toolsets.filter(
        (toolset) => !expected.includes(toolset),
      )

      expect(config.toolsets, profileId).toEqual(expectedConfigured)
      expect(platformToolsets.cli, profileId).toEqual(expectedConfigured)
      expect(agent.disabled_toolsets, profileId).toEqual(expectedDisabled)
      expect(agent.disabled_toolsets, profileId).toContain('bfl')
    }
  })

  it('fails closed when an effective built-in or plugin toolset exceeds the profile', () => {
    const golden = readFileSync(
      join(
        packageRoot,
        'tests',
        'fixtures',
        'hermes-0.20.1-sales-tools-summary.golden.txt',
      ),
      'utf8',
    )

    expect(
      validateHermesEffectiveToolSummary(
        golden,
        expectedProfileToolsets['sales-orchestrator'],
        'sales-orchestrator',
      ),
    ).toEqual([])

    const unsafe = golden
      .replace('✗ disabled  bfl', '✓ enabled  bfl')
      .replace('✗ disabled  a2a', '✓ enabled  a2a')
    expect(
      validateHermesEffectiveToolSummary(
        unsafe,
        expectedProfileToolsets['sales-orchestrator'],
        'sales-orchestrator',
      ),
    ).toEqual([
      'sales-orchestrator: effective built-in toolsets exceed allowlist: bfl',
      'sales-orchestrator: plugin toolsets must all be disabled: a2a',
    ])
  })

  it('routes separate profiles through the broker without native delegation', () => {
    const soul = readFileSync(
      join(packageRoot, 'profiles', 'sales-orchestrator', 'SOUL.md'),
      'utf8',
    )
    const roster = readFileSync(
      join(packageRoot, 'deployment', 'swarm.proposed.yaml'),
      'utf8',
    )
    const matrix = readFileSync(
      join(packageRoot, 'tests', 'agent-test-matrix.yaml'),
      'utf8',
    )

    expect(soul.toLowerCase()).not.toContain('deleg')
    expect(roster.toLowerCase()).not.toContain('deleg')
    expect(matrix.toLowerCase()).not.toContain('deleg')
    expect(soul).toContain('broker')
  })

  it('keeps hashing in the deterministic broker and never invents profile hashes', () => {
    const orchestrator = readFileSync(
      join(packageRoot, 'profiles', 'sales-orchestrator', 'SOUL.md'),
      'utf8',
    ).toLowerCase()

    expect(orchestrator).toContain('sha-256')
    expect(orchestrator).toContain('bytes utf-8 canónicos')
    expect(orchestrator).toContain('artifact_id')
    expect(orchestrator).toContain('content_hash')

    for (const profileId of [
      'outreach-draft-manager',
      'commercial-qa-compliance',
    ]) {
      const soul = readFileSync(
        join(packageRoot, 'profiles', profileId, 'SOUL.md'),
        'utf8',
      ).toLowerCase()

      expect(soul, profileId).toContain('content_hash recibido')
      expect(soul, profileId).toContain('nunca calcula')
      expect(soul, profileId).not.toContain('hash lógico')
    }
  })

  it('enforces offer, ICP, autonomy and profile-specific handoff contracts', () => {
    for (const profileId of activeProfileIds) {
      const soul = readFileSync(
        join(packageRoot, 'profiles', profileId, 'SOUL.md'),
        'utf8',
      )

      expect(validateNativeProfileSoul(soul, profileId), profileId).toEqual([])
    }

    const incompleteContract = readFileSync(
      join(packageRoot, 'profiles', 'outreach-draft-manager', 'SOUL.md'),
      'utf8',
    ).replaceAll('commercial-qa-compliance', 'removed-handoff')

    expect(
      validateNativeProfileSoul(incompleteContract, 'outreach-draft-manager'),
    ).toContain(
      'outreach-draft-manager: SOUL.md Handoffs is missing contract term commercial-qa-compliance',
    )
  })

  it('rejects toolset escalation and inline credentials in a native profile config', () => {
    const config = readProfileConfig('market-account-intelligence')
    const toolsets = config.toolsets as Array<string>
    const providers = config.custom_providers as Array<Record<string, unknown>>
    toolsets.push('terminal')
    providers[0].api_key = 'inline-placeholder-is-still-forbidden'
    providers[0].base_url = 'https://opencode.ai'

    const errors = validateNativeProfileConfig(
      config,
      'market-account-intelligence',
    )

    expect(errors).toContain(
      'market-account-intelligence: CLI toolsets must equal web,file plus no_mcp sentinel',
    )
    expect(errors).toContain(
      'market-account-intelligence: custom provider must not contain api_key',
    )
    expect(errors).toContain(
      'market-account-intelligence: custom provider must pin deepseek-v4-flash at https://opencode.ai/zen/go/v1 via CUSTOM_API_KEY',
    )
  })

  it('rejects runtime MCP and indirect recovery or plugin extension points', () => {
    const config = readProfileConfig('commercial-qa-compliance')
    config.mcp_servers = { indirect: { command: 'forbidden' } }
    config.plugins = { enabled: ['auto-recovery'] }
    config.hooks = { on_error: 'recover' }
    config.auto_recovery = true
    config.portable_mcp = { enabled: true }
    config.dynamic_toolsets = ['terminal']

    const errors = validateNativeProfileConfig(
      config,
      'commercial-qa-compliance',
    )

    expect(errors).toContain(
      'commercial-qa-compliance: mcp_servers must be an empty mapping',
    )
    expect(errors).toContain(
      'commercial-qa-compliance: config.yaml contains unsupported keys auto_recovery,dynamic_toolsets,hooks,plugins,portable_mcp',
    )
  })

  it('rejects a JSON Schema reference that escapes through a sibling path prefix', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'commercial-swarm-validator-'))
    const tempPackageRoot = join(tempRoot, 'package')
    const escapeRoot = join(tempRoot, 'package-escape')
    mkdirSync(join(tempPackageRoot, 'contracts'), { recursive: true })
    mkdirSync(escapeRoot, { recursive: true })
    writeFileSync(join(tempPackageRoot, 'README.md'), 'Simulation')
    writeFileSync(join(escapeRoot, 'outside.schema.json'), '{}')
    writeFileSync(
      join(tempPackageRoot, 'contracts', 'escape.schema.json'),
      JSON.stringify({ $ref: '../../package-escape/outside.schema.json' }),
    )

    try {
      const result = validateCommercialSwarm(tempPackageRoot)
      expect(
        result.errors.some((error) => error.includes('out-of-package $ref')),
      ).toBe(true)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects common live-secret patterns in package artifacts', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'commercial-swarm-secret-'))
    writeFileSync(
      join(tempRoot, 'README.md'),
      `Simulation\nsk-${'a'.repeat(32)}`,
    )

    try {
      const result = validateCommercialSwarm(tempRoot)
      expect(
        result.errors.some((error) => error.includes('possible OpenAI secret')),
      ).toBe(true)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('excludes nested node_modules from the commercial package audit', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'commercial-swarm-dependency-'))
    const dependencyRoot = join(
      tempRoot,
      'nested',
      'node_modules',
      'dependency',
    )
    mkdirSync(dependencyRoot, { recursive: true })
    writeFileSync(join(tempRoot, 'README.md'), 'Simulation')
    writeFileSync(
      join(dependencyRoot, 'fixture.js'),
      `export const fixture = "sk-${'a'.repeat(32)}"`,
    )

    try {
      const result = validateCommercialSwarm(tempRoot)
      expect(
        result.errors.some((error) => error.includes('possible OpenAI secret')),
      ).toBe(false)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('accepts an approval display token whose ISO-8601 expiry contains colons', () => {
    const schema = JSON.parse(
      readFileSync(
        join(packageRoot, 'contracts', 'approval.schema.json'),
        'utf8',
      ),
    ) as { properties: { token_display: { pattern: string } } }
    const token = `APPROVAL::123e4567-e89b-12d3-a456-426614174000::${'a'.repeat(64)}::2026-08-15T18:30:00Z`

    expect(
      new RegExp(schema.properties.token_display.pattern).test(token),
    ).toBe(true)
  })
})
