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
})
