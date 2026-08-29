import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { runA1CodexSignerCli } from '../src/a1-codex-signer-main.js'

const signed = {
  orderAuthorizationId: '72500000-0000-4500-8500-000000000053',
  missionId: '82500000-0000-4500-8500-000000000053',
  unsignedWorkOrderSha256: 'a'.repeat(64),
  signedWorkOrderSha256: 'b'.repeat(64),
  workOrder: { authority: { algorithm: 'Ed25519', signature: 'c'.repeat(128) } },
  signatureAlgorithm: 'Ed25519' as const,
  persisted: false as const,
  missionCreated: false as const,
  dispatchQueued: false as const,
  nextRequiredGate: 'submit_signed_order_separately' as const,
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'a1-signer-'))
  const paths = {
    candidate: join(root, 'candidate.json'), expectation: join(root, 'expectation.json'),
    privateKey: join(root, 'private.pem'), publicKey: join(root, 'public.pem'), output: join(root, 'signed.json'),
  }
  await Promise.all([
    writeFile(paths.candidate, '{}'), writeFile(paths.expectation, '{}'),
    writeFile(paths.privateKey, '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n'),
    writeFile(paths.publicKey, '-----BEGIN PUBLIC KEY-----\npublic-material\n-----END PUBLIC KEY-----\n'),
  ])
  const args = ['--candidate',paths.candidate,'--expectation',paths.expectation,'--private-key',paths.privateKey,'--public-key',paths.publicKey,'--output',paths.output]
  return { root, paths, args }
}

describe('offline A1 Codex signer CLI', () => {
  it('writes one atomic result and reports only non-secret inert evidence', async () => {
    const { paths, args } = await fixture(); const lines: string[] = []
    await runA1CodexSignerCli(args, {
      now: () => new Date('2026-08-29T00:00:00.000Z'),
      sign: (_candidate,_expectation,privateKey,publicKey,authority) => {
        assert.match(privateKey, /private-material/); assert.match(publicKey, /public-material/)
        assert.deepEqual(authority, { issuer: 'codex', audience: 'hermes-commercial-orchestrator' })
        return signed as never
      },
      write: (line) => lines.push(line),
    })
    assert.deepEqual(JSON.parse(await readFile(paths.output, 'utf8')), signed)
    assert.match(lines.join('\n'), /persisted=false[\s\S]*mission_created=false[\s\S]*dispatch_queued=false/)
    assert.doesNotMatch(lines.join('\n'), /private-material|public-material|BEGIN/)
  })

  it('refuses overwrite, symlinked input and unexpected arguments before signing', async () => {
    const first = await fixture(); await writeFile(first.paths.output, 'existing')
    let calls=0
    const deps={
      now:()=>new Date(),
      sign:(_candidate:unknown,_expectation:unknown,_privateKey:string,_publicKey:string,_authority:unknown)=>{calls++;return signed as never},
      write:(_line:string)=>undefined,
    }
    await assert.rejects(runA1CodexSignerCli(first.args,deps),/A1_CODEX_SIGNING_GATE_CLOSED/)
    const second = await fixture(); const linked=join(second.root,'linked.json')
    try {
      await symlink(second.paths.candidate,linked)
      const linkedArgs=[...second.args]; linkedArgs[1]=linked
      await assert.rejects(runA1CodexSignerCli(linkedArgs,deps),/A1_CODEX_SIGNING_GATE_CLOSED/)
    } catch (error) {
      if (!['EPERM','EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw error
    }
    await assert.rejects(runA1CodexSignerCli([...second.args,'--now','past'],deps),/A1_CODEX_SIGNING_GATE_CLOSED/)
    assert.equal(calls,0)
  })

  it('never leaves a partial output when the signer rejects the candidate', async () => {
    const { paths,args }=await fixture()
    await assert.rejects(runA1CodexSignerCli(args,{now:()=>new Date(),sign:()=>{throw new Error('rejected')},write:(_line:string)=>undefined}),/rejected/)
    await assert.rejects(readFile(paths.output),{code:'ENOENT'})
  })
})
