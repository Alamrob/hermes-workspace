import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRuntimePersistence,verifyProductionDatabasePrincipals } from '../src/production.js'
import { InMemoryRuntimeRepository } from '../src/repository.js'

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

  it('fails production closed unless runtime, approver, and safety capabilities use separate credentials', async () => {
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
        APPROVER_DATABASE_URL: 'postgresql://approver:unused@127.0.0.1:1/runtime',
      }),
      /SAFETY_DATABASE_URL is required/,
    )
  })

  it('uses memory only for test or development and verifies PostgreSQL before returning', async () => {
    const testPersistence = await createRuntimePersistence({ NODE_ENV: 'test' })
    assert.ok(testPersistence.repository instanceof InMemoryRuntimeRepository)
    await testPersistence.close()

    await assert.rejects(createRuntimePersistence({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://runtime:unused@127.0.0.1:1/runtime',
      APPROVER_DATABASE_URL: 'postgresql://approver:unused@127.0.0.1:1/runtime',
      SAFETY_DATABASE_URL: 'postgresql://safety:unused@127.0.0.1:1/runtime',
    }))
  })

  it('rejects reused URL principals and verifies live current_user plus exactly one capability',async()=>{await assert.rejects(createRuntimePersistence({NODE_ENV:'production',DATABASE_URL:'postgresql://same:x@db/app',APPROVER_DATABASE_URL:'postgresql://same:x@db/app',SAFETY_DATABASE_URL:'postgresql://safety:x@db/app'}),/PRINCIPALS_MUST_BE_DISTINCT/);const fake=(current_user:string,memberships:string[],unsafe=false,unsafe_effective=false)=>({query:async()=>({rows:[{current_user,memberships,rolcanlogin:true,unsafe,unsafe_effective}]})});await verifyProductionDatabasePrincipals([{pool:fake('runtime_login',['commercial_runtime'])as never,expected:'runtime_login',capability:'commercial_runtime'}]);await assert.rejects(verifyProductionDatabasePrincipals([{pool:fake('other_login',['commercial_runtime'])as never,expected:'runtime_login',capability:'commercial_runtime'}]),/DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/);await assert.rejects(verifyProductionDatabasePrincipals([{pool:fake('runtime_login',['commercial_approver','commercial_runtime'])as never,expected:'runtime_login',capability:'commercial_runtime'}]),/DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/);await assert.rejects(verifyProductionDatabasePrincipals([{pool:fake('runtime_login',['commercial_runtime'],true)as never,expected:'runtime_login',capability:'commercial_runtime'}]),/DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/);await assert.rejects(verifyProductionDatabasePrincipals([{pool:fake('runtime_login',['commercial_runtime'],false,true)as never,expected:'runtime_login',capability:'commercial_runtime'}]),/DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/)})
})
