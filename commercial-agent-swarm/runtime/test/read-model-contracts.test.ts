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
    assert.equal(schema.properties.portfolio.type, 'array')
    assert.equal(schema.properties.portfolio.minItems, 26)
    assert.equal(schema.properties.portfolio.maxItems, 26)
    assert.equal(schema.properties.control.properties.killSwitch.type, 'boolean')
  })

  it('publishes a closed CRM schema for known and simulation-disabled summaries', async () => {
    const schema = await contract('crm-summary')
    assert.equal(schema.$id, 'https://alam.cl/contracts/crm-summary.schema.json')
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, [
      'availability', 'accounts', 'contacts', 'opportunities', 'pipelineUsd', 'provenance',
    ])
  })

  it('accepts the exact portfolio model and rejects extra, missing, or invented data', () => {
    const model = inMemoryPortfolioReadModel({
      missionCount: 1, approvalCount: 2, auditCount: 3, killSwitchActive: false,
    })
    assert.deepEqual(validatePortfolioReadModel(model), model)
    assert.equal(INITIAL_PROJECT_INVENTORY.length, 26)
    assert.equal(model.portfolio.length, 26)
    assert.equal(model.projects.length, 0)
    assert.equal(model.portfolio.find((item) => item.id === 'wspro')?.name, 'WSPro')
    assert.throws(
      () => validatePortfolioReadModel({ ...model, revenue: 42 }),
      /PORTFOLIO_READ_MODEL_INVALID/,
    )
    assert.throws(
      () => validatePortfolioReadModel({ ...model, portfolio: model.portfolio.slice(1) }),
      /PORTFOLIO_READ_MODEL_INVALID/,
    )
    assert.throws(
      () => validatePortfolioReadModel({
        ...model,
        portfolio: model.portfolio.map((item) =>
          item.id === 'xg-systems' ? { ...item, activatable: true } : item,
        ),
      }),
      /PORTFOLIO_READ_MODEL_INVALID/,
    )
  })

  it('accepts only closed CRM summaries with bounded nonnegative counts', () => {
    const known = {
      availability: 'available', accounts: 4, contacts: 3, opportunities: 2,
      pipelineUsd: null,
      provenance: { source: 'twenty', sourceId: 'crm-summary:postgres', observedAt: '2026-08-16T12:00:00.000Z', synthetic: false },
    }
    assert.deepEqual(validateCrmSummaryReadModel(known), known)
    assert.deepEqual(validateCrmSummaryReadModel({
      availability: 'unavailable', accounts: null, contacts: null,
      opportunities: null, pipelineUsd: null, message: 'CRM sync disabled',
      provenance: { source: 'twenty', sourceId: 'crm:simulation-disabled', observedAt: '2026-08-16T12:00:00.000Z', synthetic: false },
    }).availability, 'unavailable')
    assert.throws(
      () => validateCrmSummaryReadModel({ ...known, accounts: -1 }),
      /CRM_SUMMARY_RESULT_INVALID/,
    )
    assert.throws(
      () => validateCrmSummaryReadModel({ ...known, remoteUrl: 'secret' }),
      /CRM_SUMMARY_RESULT_INVALID/,
    )
  })
})
