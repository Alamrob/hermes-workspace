"""Fixed read-only probe for host liveness. No arguments or write operations."""
import json
import os
import re
import stat
import sys

DIRECTORY = '/run/hermes-executor/guardian-health'
PATH = DIRECTORY + '/STATE.json'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)


def fail(code):
    print(json.dumps({'status':'invalid','code':code}, separators=(',', ':')))
    raise SystemExit(70)


try:
    with open('/proc/self/status', encoding='ascii') as stream:
        process_fields = dict(line.strip().split(':', 1) for line in stream if ':' in line)
    if len(sys.argv) != 1 or os.getuid() != 10000 or os.getgid() != 10000 or os.getgroups() or process_fields.get('NoNewPrivs','').strip() != '1' or any(process_fields.get(key,'').strip() != '0000000000000000' for key in ('CapInh','CapPrm','CapEff','CapAmb','CapBnd')):
        fail('IDENTITY')
    directory = os.lstat(DIRECTORY)
    value = os.lstat(PATH)
    if not stat.S_ISDIR(directory.st_mode) or stat.S_ISLNK(directory.st_mode) or directory.st_uid != 10000 or directory.st_gid != 10000 or stat.S_IMODE(directory.st_mode) != 0o700:
        fail('DIRECTORY')
    if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode) or value.st_uid != 10000 or value.st_gid != 10000 or stat.S_IMODE(value.st_mode) != 0o400 or value.st_nlink != 1 or value.st_size > 512:
        fail('FILE')
    descriptor = os.open(PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_uid != 10000 or opened.st_gid != 10000 or stat.S_IMODE(opened.st_mode) != 0o400 or opened.st_nlink != 1 or opened.st_size > 512:
            fail('FILE')
        payload = json.loads(os.read(descriptor, 513))
    finally:
        os.close(descriptor)
    if not isinstance(payload, dict) or set(payload) != {'schema_version','boot_id','counter','ready'} or payload['schema_version'] != 1 or not isinstance(payload['boot_id'], str) or not UUID.fullmatch(payload['boot_id']) or type(payload['counter']) is not int or not 0 <= payload['counter'] <= 9007199254740991 or type(payload['ready']) is not bool:
        fail('PAYLOAD')
    print(json.dumps(payload, separators=(',', ':'), sort_keys=True))
except BaseException as error:
    if isinstance(error, SystemExit):
        raise
    fail('READ')
