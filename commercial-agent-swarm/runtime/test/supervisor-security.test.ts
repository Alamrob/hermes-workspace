import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertExecutorSupervisorSecurity,
  EXECUTOR_BOOTSTRAP_CONTRACT_V1,
} from '../src/supervisor-security.js'

const status = [
  'Uid:\t10000\t10000\t10000\t10000',
  'Gid:\t10000\t10000\t10000\t10000',
  'Groups:\t',
  'CapInh:\t00000000000001e1',
  'CapPrm:\t00000000000001e1',
  'CapEff:\t00000000000001e1',
  'CapBnd:\t00000000000001e1',
  'CapAmb:\t00000000000001e1',
  'NoNewPrivs:\t1',
].join('\n')

describe('executor supervisor bootstrap contract', () => {
  it('requires PID1 uid/gid 10000, only the five approved capabilities, and NNP', () => {
    assert.doesNotThrow(() =>
      assertExecutorSupervisorSecurity({ pid: 1, uid: 10000, gid: 10000, status }),
    )
    for (const invalid of [
      { pid: 2, uid: 10000, gid: 10000, status },
      { pid: 1, uid: 0, gid: 10000, status },
      { pid: 1, uid: 10000, gid: 10000, status: status.replace('CapEff:\t00000000000001e1', 'CapEff:\t00000000000003e1') },
      { pid: 1, uid: 10000, gid: 10000, status: status.replace('Groups:\t', 'Groups:\t11000') },
      { pid: 1, uid: 10000, gid: 10000, status: status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0') },
    ])
      assert.throws(
        () => assertExecutorSupervisorSecurity(invalid),
        /EXECUTOR_SUPERVISOR_SECURITY_INVALID/,
      )
  })

  it('publishes one immutable no-shell bootstrap argv with no user-provided suffix', () => {
    assert.deepEqual(EXECUTOR_BOOTSTRAP_CONTRACT_V1, [
      '/usr/bin/setpriv', '--reuid=10000', '--regid=10000', '--clear-groups',
      '--inh-caps=+chown,+kill,+setgid,+setuid,+setpcap',
      '--ambient-caps=+chown,+kill,+setgid,+setuid,+setpcap',
      '--bounding-set=-all,+chown,+kill,+setgid,+setuid,+setpcap',
      '--no-new-privs', '--', '/usr/local/bin/node', '/app/dist/executor-main.js',
    ])
  })
})
