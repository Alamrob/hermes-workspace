"""Read-only V2 healthcheck: exact identities, socket and fresh physical ACK.

Runs as10000 with no capabilities, no supplemental groups and NNP. Does not
signal, contact the IPC server, read credentials or write any state.
"""
import json
import os
import re
import stat
import sys
import time

DIRECTORY='/run/hermes-executor/guardian-health'
SOCKET_DIRECTORY='/run/commercial-swarm'
CAPS='00000000000001e1'
UUID=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',re.I)
GUARDIAN_COMMAND=b'/opt/hermes/.venv/bin/python\x00-I\x00-B\x00/app/guardian/executor_guardian.py\x00'


class HealthError(Exception):
    pass


def fail(code):raise HealthError(code)


def status(path):
    with open(path,encoding='ascii') as stream:
        return dict(line.strip().split(':',1) for line in stream if ':' in line)


def identity(fields,caps):
    if (fields.get('Uid','').split()!=['10000']*4 or fields.get('Gid','').split()!=['10000']*4
            or fields.get('Groups','').split() or fields.get('NoNewPrivs','').strip()!='1'
            or any(fields.get(key,'').strip()!=caps for key in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb'))):
        fail('HEALTH_IDENTITY')


def directory(path,uid,gid,mode):
    # Retain each opened directory; no ancestor symlinks.
    descriptor=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for part in path.split('/')[1:]:
            following=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=descriptor)
            os.close(descriptor);descriptor=following
        value=os.fstat(descriptor)
        if value.st_uid!=uid or value.st_gid!=gid or stat.S_IMODE(value.st_mode)!=mode:
            fail('HEALTH_DIRECTORY')
        return descriptor
    except BaseException:
        os.close(descriptor);raise


def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:fail('HEALTH_DUPLICATE_JSON')
        result[key]=value
    return result


def state(descriptor):
    fd=os.open('STATE.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=descriptor)
    try:
        value=os.fstat(fd)
        if (not stat.S_ISREG(value.st_mode) or value.st_uid!=10000 or value.st_gid!=10000
                or stat.S_IMODE(value.st_mode)!=0o400 or value.st_nlink!=1 or not 1<=value.st_size<=512):
            fail('HEALTH_STATE_FILE')
        result=json.loads(os.read(fd,513),object_pairs_hook=unique)
    finally:os.close(fd)
    if (not isinstance(result,dict) or set(result)!={'schema_version','boot_id','counter','ready'}
            or type(result['schema_version']) is not int or result['schema_version']!=1
            or not isinstance(result['boot_id'],str) or not UUID.fullmatch(result['boot_id'])
            or type(result['counter']) is not int or not 1<=result['counter']<=9007199254740991
            or result['ready'] is not True):fail('HEALTH_STATE')
    return result


def socket_ready():
    descriptor=directory(SOCKET_DIRECTORY,10000,11000,0o2770)
    try:
        value=os.stat('executor.sock',dir_fd=descriptor,follow_symlinks=False)
        if not stat.S_ISSOCK(value.st_mode) or value.st_uid!=10000 or value.st_gid!=11000 or stat.S_IMODE(value.st_mode)!=0o660:
            fail('HEALTH_SOCKET')
    finally:os.close(descriptor)


def check():
    if len(sys.argv)!=1 or os.getuid()!=10000 or os.getgid()!=10000 or os.getgroups():fail('HEALTH_CALLER')
    identity(status('/proc/self/status'),'0000000000000000')
    identity(status('/proc/1/status'),CAPS)
    with open('/proc/1/cmdline','rb') as stream:
        if stream.read(4096)!=GUARDIAN_COMMAND:fail('HEALTH_GUARDIAN_COMMAND')
    socket_ready()
    descriptor=directory(DIRECTORY,10000,10000,0o700)
    try:
        first=state(descriptor)
        deadline=time.clock_gettime_ns(time.CLOCK_BOOTTIME)+1500*1000000
        while True:
            if time.clock_gettime_ns(time.CLOCK_BOOTTIME)>=deadline:fail('HEALTH_ACK_TIMEOUT')
            current=state(descriptor)
            if time.clock_gettime_ns(time.CLOCK_BOOTTIME)>=deadline:fail('HEALTH_ACK_TIMEOUT')
            if current['boot_id']!=first['boot_id'] or current['counter']<first['counter']:fail('HEALTH_GENERATION')
            if current['counter']>first['counter']:
                socket_ready()
                return
            time.sleep(0.025)
    finally:os.close(descriptor)


if __name__=='__main__':
    try:
        check();print('{"status":"healthy"}')
    except BaseException as error:
        code=str(error) if isinstance(error,HealthError) else 'HEALTH_FAILED_CLOSED'
        print(json.dumps({'status':'unhealthy','code':code}));sys.exit(70)
