export const EXECUTOR_SUPERVISOR_CAPABILITIES_HEX = '00000000000001e1'
export const EXECUTOR_BOOTSTRAP_CONTRACT_V1 = [
  '/usr/bin/setpriv',
  '--reuid=10000',
  '--regid=10000',
  '--clear-groups',
  '--inh-caps=+chown,+kill,+setgid,+setuid,+setpcap',
  '--ambient-caps=+chown,+kill,+setgid,+setuid,+setpcap',
  '--bounding-set=-all,+chown,+kill,+setgid,+setuid,+setpcap',
  '--no-new-privs',
  '--',
  '/usr/local/bin/node',
  '/app/dist/executor-main.js',
] as const

export function assertExecutorSupervisorSecurity(input: {
  pid: number
  uid: number | undefined
  gid: number | undefined
  status: string
}): void {
  const fields = new Map(
    input.status
      .split('\n')
      .map((line) => line.split(':', 2).map((value) => value.trim()))
      .filter((parts) => parts.length === 2) as Array<[string, string]>,
  )
  const groups = fields.get('Groups')?.split(/\s+/).filter(Boolean) ?? []
  if (
    input.pid !== 1 ||
    input.uid !== 10000 ||
    input.gid !== 10000 ||
    fields.get('Uid') !== '10000\t10000\t10000\t10000' ||
    fields.get('Gid') !== '10000\t10000\t10000\t10000' ||
    groups.length !== 0 ||
    fields.get('NoNewPrivs') !== '1' ||
    ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].some(
      (name) => fields.get(name)?.toLowerCase() !== EXECUTOR_SUPERVISOR_CAPABILITIES_HEX,
    )
  )
    throw new Error('EXECUTOR_SUPERVISOR_SECURITY_INVALID')
}
