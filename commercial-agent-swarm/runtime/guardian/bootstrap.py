"""Fixed V2 PID1 bootstrap. No command, paths or credentials from arguments."""
import json
import os
import stat
import sys

CAPS = '00000000000001e1'
ROOT = '/run/hermes-executor'
HEALTH = ROOT + '/guardian-health'
GUARDIAN = '/app/guardian/executor_guardian.py'
SERVER = '/app/dist/executor-main.js'
COMMAND = ['/usr/bin/setpriv', '--reuid=10000', '--regid=10000', '--clear-groups',
    '--inh-caps=+chown,+kill,+setgid,+setuid,+setpcap',
    '--ambient-caps=+chown,+kill,+setgid,+setuid,+setpcap',
    '--bounding-set=-all,+chown,+kill,+setgid,+setuid,+setpcap',
    '--no-new-privs', '--', '/opt/hermes/.venv/bin/python', '-I', '-B', GUARDIAN]


class BootstrapError(Exception):
    pass


def fail(code):
    raise BootstrapError(code)


def immutable_file(path):
    value = os.lstat(path)
    if (not stat.S_ISREG(value.st_mode) or value.st_uid != 0 or value.st_gid != 0
            or value.st_nlink != 1 or value.st_mode & 0o222):
        fail('BOOTSTRAP_CODE_METADATA')
    parent = os.path.dirname(path)
    while parent != '/':
        value = os.lstat(parent)
        if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
            fail('BOOTSTRAP_CODE_DIRECTORY')
        parent = os.path.dirname(parent)


def prepare():
    if len(sys.argv) != 1 or os.getpid() != 1 or os.getuid() != 0 or os.getgid() != 0:
        fail('BOOTSTRAP_IDENTITY')
    with open('/proc/self/status', encoding='ascii') as stream:
        fields = dict(line.strip().split(':',1) for line in stream if ':' in line)
    if (fields.get('NoNewPrivs','').strip() != '1'
            or any(fields.get(key,'').strip() != CAPS for key in ('CapPrm','CapEff','CapBnd'))):
        fail('BOOTSTRAP_CAPABILITIES')
    immutable_file(GUARDIAN)
    immutable_file(SERVER)
    value = os.lstat(ROOT)
    if (not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_gid != 0
            or stat.S_IMODE(value.st_mode) != 0o711):
        fail('BOOTSTRAP_TEMPORARY_ROOT')
    # Fresh tmpfs only. Never delete/reuse a previous generation's health state.
    descriptor = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.mkdir('guardian-health', 0o700, dir_fd=descriptor)
        os.chown('guardian-health',10000,10000,dir_fd=descriptor,follow_symlinks=False)
        os.fchown(descriptor,10000,10000)
        os.fsync(descriptor)
    except FileExistsError:
        fail('BOOTSTRAP_HEALTH_ALREADY_EXISTS')
    finally:
        os.close(descriptor)
    # Inherited stdio only; close unknown descriptors before privilege drop.
    os.closerange(3,1048576)
    os.execv(COMMAND[0],COMMAND)


if __name__ == '__main__':
    try:
        prepare()
    except BaseException as error:
        code = str(error) if isinstance(error,BootstrapError) else 'BOOTSTRAP_FAILED_CLOSED'
        try:
            os.set_blocking(2,False)
            os.write(2,(json.dumps({'type':'executor_bootstrap_stop','code':code})+'\n').encode())
        except BaseException:
            pass
        os._exit(70)
