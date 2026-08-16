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
  validateNativeProfileConfig,
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

describe('commercial swarm package validator', () => {
  it('accepts the committed simulation-only package', () => {
    const result = validateCommercialSwarm(packageRoot)

    expect(result.errors).toEqual([])
    expect(result.counts.agents).toBe(10)
    expect(result.counts.profiles).toBe(6)
    expect(result.counts.prompts).toBe(17)
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

  it('rejects toolset escalation and inline credentials in a native profile config', () => {
    const config = yaml.parse(
      readFileSync(
        join(
          packageRoot,
          'profiles',
          'market-account-intelligence',
          'config.yaml',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>
    const toolsets = config.toolsets as Array<string>
    const providers = config.custom_providers as Array<Record<string, unknown>>
    toolsets.push('terminal')
    providers[0].api_key = 'inline-placeholder-is-still-forbidden'

    const errors = validateNativeProfileConfig(
      config,
      'market-account-intelligence',
    )

    expect(errors).toContain(
      'market-account-intelligence: CLI toolsets must equal web,file',
    )
    expect(errors).toContain(
      'market-account-intelligence: custom provider must not contain api_key',
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
