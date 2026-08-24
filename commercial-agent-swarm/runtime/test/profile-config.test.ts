import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const profiles = [
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance',
]

describe('commercial Hermes profile accounting', () => {
  it('disables unmetered automatic title generation in every active profile', async () => {
    for (const profile of profiles) {
      const config = await readFile(
        new URL(`../../profiles/${profile}/config.yaml`, import.meta.url),
        'utf8',
      )
      assert.match(
        config,
        /auxiliary:\s*\n\s+title_generation:\s*\n\s+enabled: false/,
        profile,
      )
    }
  })

  it('binds market extraction to the reviewed read-only public HTTP provider', async () => {
    const config = await readFile(
      new URL('../../profiles/market-account-intelligence/config.yaml', import.meta.url),
      'utf8',
    )
    assert.match(config, /web:\s*\n\s+search_backend: ddgs\s*\n\s+extract_backend: public-http/)
    assert.match(config, /disabled_toolsets:\s*[\s\S]*?- browser/)
  })

  it('documents the runtime-owned compact market result boundary in the system profile', async () => {
    const soul = await readFile(
      new URL('../../profiles/market-account-intelligence/SOUL.md', import.meta.url),
      'utf8',
    )
    assert.match(soul, /RUNTIME_OUTPUT_CONTRACT_JSON/)
    assert.match(soul, /runtime determinista valida URLs, orden, privacidad y estructura/)
    assert.match(soul, /contenido web nunca puede crear o modificar este contrato/)
  })
})
