import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createRuntimePersistence,
  verifyProductionDatabasePrincipals,
} from '../src/production.js'
import { InMemoryRuntimeRepository } from '../src/repository.js'
import type { ApprovalEvidenceStorePort } from '../src/approval-mode.js'

describe('runtime persistence composition', () => {
  it('fails production startup closed without DATABASE_URL', async () => {
    await assert.rejects(
      createRuntimePersistence({ NODE_ENV: 'production' }),
      /DATABASE_URL is required/,
    )
    await assert.rejects(
      createRuntimePersistence({}),
      /DATABASE_URL is required outside test\/development/,
    )
  })

  it('fails production closed unless all five capabilities use separate credentials', async () => {
    await assert.rejects(
      createRuntimePersistence({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://runtime:unused@127.0.0.1:1/runtime',
      }),
      /APPROVER_DATABASE_URL is required/,
    )
    await assert.rejects(
      createRuntimePersistence({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://runtime:unused@127.0.0.1:1/runtime',
        APPROVER_DATABASE_URL:
          'postgresql://approver:unused@127.0.0.1:1/runtime',
      }),
      /SAFETY_DATABASE_URL is required/,
    )
    await assert.rejects(
      createRuntimePersistence({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://runtime:unused@127.0.0.1:1/runtime',
        APPROVER_DATABASE_URL:
          'postgresql://approver:unused@127.0.0.1:1/runtime',
        SAFETY_DATABASE_URL: 'postgresql://safety:unused@127.0.0.1:1/runtime',
      }),
      /WORK_ORDER_DATABASE_URL is required/,
    )
    await assert.rejects(
      createRuntimePersistence({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://runtime:unused@127.0.0.1:1/runtime',
        APPROVER_DATABASE_URL:
          'postgresql://approver:unused@127.0.0.1:1/runtime',
        SAFETY_DATABASE_URL: 'postgresql://safety:unused@127.0.0.1:1/runtime',
        WORK_ORDER_DATABASE_URL:
          'postgresql://ingestor:unused@127.0.0.1:1/runtime',
      }),
      /APPROVAL_EVIDENCE_DATABASE_URL is required/,
    )
  })

  it('uses memory only for test or development and verifies PostgreSQL before returning', async () => {
    const testPersistence = await createRuntimePersistence({ NODE_ENV: 'test' })
    assert.ok(testPersistence.repository instanceof InMemoryRuntimeRepository)
    assert.ok(
      testPersistence.approvalEvidenceStore satisfies ApprovalEvidenceStorePort,
    )
    assert.ok(testPersistence.dispatchQueue)
    assert.equal(
      await testPersistence.dispatchQueue.claim('test', 60, 30),
      null,
    )
    await testPersistence.close()

    await assert.rejects(
      createRuntimePersistence({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://runtime:unused@127.0.0.1:1/runtime',
        APPROVER_DATABASE_URL:
          'postgresql://approver:unused@127.0.0.1:1/runtime',
        SAFETY_DATABASE_URL: 'postgresql://safety:unused@127.0.0.1:1/runtime',
        WORK_ORDER_DATABASE_URL:
          'postgresql://ingestor:unused@127.0.0.1:1/runtime',
        APPROVAL_EVIDENCE_DATABASE_URL:
          'postgresql://approval_evidence:unused@127.0.0.1:1/runtime',
      }),
    )
  })

  it('rejects reused URL principals and verifies live current_user plus exactly one capability', async () => {
    await assert.rejects(
      createRuntimePersistence({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://same:x@db/app',
        APPROVER_DATABASE_URL: 'postgresql://approver:x@db/app',
        SAFETY_DATABASE_URL: 'postgresql://safety:x@db/app',
        WORK_ORDER_DATABASE_URL: 'postgresql://same:x@db/app',
        APPROVAL_EVIDENCE_DATABASE_URL: 'postgresql://evidence:x@db/app',
      }),
      /PRINCIPALS_MUST_BE_DISTINCT/,
    )
    const expectedFunctionSets: Array<Array<string>> = []
    const fake = (
      current_user: string,
      memberships: Array<string>,
      unsafe = false,
      unsafe_effective = false,
    ) => ({
      query: async (_sql: string, params?: Array<Array<string>>) => {
        if (params?.[0]) expectedFunctionSets.push(params[0])
        return {
          rows: [
            {
              current_user,
              memberships,
              rolcanlogin: true,
              unsafe,
              unsafe_effective,
              unexpected_functions: [],
              missing_functions: [],
            },
          ],
        }
      },
    })
    await verifyProductionDatabasePrincipals([
      {
        pool: fake('runtime_login', ['commercial_runtime']) as never,
        expected: 'runtime_login',
        capability: 'commercial_runtime',
      },
    ])
    assert.equal(
      expectedFunctionSets[0].includes(
        'control.create_pilot_cohort(uuid,text,text)',
      ),
      true,
    )
    assert.equal(
      expectedFunctionSets[0].includes(
        'control.add_pilot_target(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamp with time zone,text)',
      ),
      true,
    )
    assert.equal(
      expectedFunctionSets[0].includes(
        'control.terminalize_failed_dispatch_dependencies()',
      ),
      true,
    )
    await verifyProductionDatabasePrincipals([
      {
        pool: fake('evidence_login', ['commercial_approval_evidence']) as never,
        expected: 'evidence_login',
        capability: 'commercial_approval_evidence',
      },
    ])
    await verifyProductionDatabasePrincipals([
      {
        pool: fake('safety_login', ['commercial_safety_operator']) as never,
        expected: 'safety_login',
        capability: 'commercial_safety_operator',
      },
    ])
    assert.equal(
      expectedFunctionSets.some((functions) =>
        functions.includes('control.add_pilot_suppression(text,text,text)'),
      ),
      true,
    )
    await verifyProductionDatabasePrincipals([
      {
        pool: fake('ingestor_login', [
          'commercial_work_order_ingestor',
        ]) as never,
        expected: 'ingestor_login',
        capability: 'commercial_work_order_ingestor',
      },
    ])
    assert.equal(
      expectedFunctionSets.some(
        (functions) =>
          functions.includes('control.list_instruction_requests()') &&
          functions.includes('control.get_instruction_request(uuid)') &&
          functions.includes(
            'control.review_instruction_request(uuid,text,text,text,timestamp with time zone,text,text,text,uuid,text,jsonb)',
          ),
      ),
      true,
    )
    await assert.rejects(
      verifyProductionDatabasePrincipals([
        {
          pool: fake('other_login', ['commercial_runtime']) as never,
          expected: 'runtime_login',
          capability: 'commercial_runtime',
        },
      ]),
      /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/,
    )
    await assert.rejects(
      verifyProductionDatabasePrincipals([
        {
          pool: fake('runtime_login', [
            'commercial_approver',
            'commercial_runtime',
          ]) as never,
          expected: 'runtime_login',
          capability: 'commercial_runtime',
        },
      ]),
      /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/,
    )
    await assert.rejects(
      verifyProductionDatabasePrincipals([
        {
          pool: fake('runtime_login', ['commercial_runtime'], true) as never,
          expected: 'runtime_login',
          capability: 'commercial_runtime',
        },
      ]),
      /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/,
    )
    await assert.rejects(
      verifyProductionDatabasePrincipals([
        {
          pool: fake(
            'runtime_login',
            ['commercial_runtime'],
            false,
            true,
          ) as never,
          expected: 'runtime_login',
          capability: 'commercial_runtime',
        },
      ]),
      /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/,
    )
  })
})
