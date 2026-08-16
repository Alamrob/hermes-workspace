import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  INITIAL_PROJECT_INVENTORY,
  inMemoryPortfolioReadModel,
  validatePortfolioReadModel,
} from '../src/portfolio-read-model.js'
import { validateCrmSummaryReadModel } from '../src/crm-summary-read-model.js'

const contractsDirectory = fileURLToPath(
  new URL('../../contracts/', import.meta.url),
)

async function contract(name: string): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(`${contractsDirectory}${name}.schema.json`, 'utf8'),
  ) as Record<string, any>
}

describe('versioned Sales read-model contracts', () => {
  it('publishes a closed portfolio schema with the exact aggregate keys', async () => {
    const schema = await contract('portfolio-read-model')
    assert.equal(schema.$id, 'https://alam.cl/contracts/portfolio-read-model.schema.json')
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, [
      'portfolio', 'projects', 'missions', 'missionDrafts', 'approvals', 'qa',
      'agents', 'experiments', 'costs', 'audit', 'control',
    ])
    assert.equal(schema.properties.projects.minItems, 26)
    assert.equal(schema.properties.projects.maxItems, 26)
  })

  it('publishes a closed CRM schema for known and simulation-disabled summaries', async () => {
    const schema = await contract('crm-summary')
    assert.equal(schema.$id, 'https://alam.cl/contracts/crm-summary.schema.json')
    assert.equal(schema.oneOf.length, 2)
    for (const variant of schema.oneOf) assert.equal(variant.additionalProperties, false)
  })

  it('accepts the exact portfolio model and rejects extra, missing, or invented data', () => {
    const model = inMemoryPortfolioReadModel({
      missionCount: 1, approvalCount: 2, auditCount: 3, killSwitchActive: false,
    })
    assert.deepEqual(validatePortfolioReadModel(model), model)
    assert.equal(INITIAL_PROJECT_INVENTORY.length, 26)
    assert.throws(
      () => validatePortfolioReadModel({ ...model, revenue: 42 }),
      /PORTFOLIO_READ_MODEL_INVALID/,
    )
    assert.throws(
      () => validatePortfolioReadModel({ ...model, projects: model.projects.slice(1) }),
      /PORTFOLIO_READ_MODEL_INVALID/,
    )
    assert.throws(
      () => validatePortfolioReadModel({
        ...model,
        projects: model.projects.map((project) =>
          project.projectId === 'xg-systems'
            ? { ...project, activatable: true }
            : project,
        ),
      }),
      /PORTFOLIO_READ_MODEL_INVALID/,
    )
  })

  it('accepts only closed CRM summaries with bounded nonnegative counts', () => {
    const known = {
      status: 'known', connector: 'twenty',
      outbox: { pending: 1, leased: 0, confirmed: 2, failed: 0, outcomeUnknown: 0 },
      inboxCount: 4, entityLinkCount: 3, cursorCount: 5,
      lastSuccessfulSyncAt: '2026-08-16T12:00:00.000Z', provenance: 'postgres',
    }
    assert.deepEqual(validateCrmSummaryReadModel(known), known)
    assert.deepEqual(validateCrmSummaryReadModel({
      status: 'disabled', connector: 'twenty', outbox: null,
      inboxCount: null, entityLinkCount: null, cursorCount: null,
      lastSuccessfulSyncAt: null, provenance: 'simulation-disabled',
    }).status, 'disabled')
    assert.throws(
      () => validateCrmSummaryReadModel({ ...known, inboxCount: -1 }),
      /CRM_SUMMARY_RESULT_INVALID/,
    )
    assert.throws(
      () => validateCrmSummaryReadModel({ ...known, remoteUrl: 'secret' }),
      /CRM_SUMMARY_RESULT_INVALID/,
    )
  })
})
