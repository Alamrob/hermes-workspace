"""Deterministic PID1 guardian. No provider, database, host or Docker access.

The server is trusted; model processes run as UID/GID10002 with zero caps.
This is not protection against a compromised server with supervisor caps.
"""
import json
import os
import re
import selectors
import signal
import socket
import subprocess
import time
import uuid
import stat

MAX_LEASE_MS = 5000
MAX_FRAME = 8192
HEARTBEAT_MS = 2000
HOST_HEARTBEAT_MS = 5000
CAPS = '00000000000001e1'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)


class ContainmentError(Exception):
    pass


def boot_ms():
    if not hasattr(time, 'CLOCK_BOOTTIME'):
        raise ContainmentError('GUARDIAN_BOOTTIME_REQUIRED')
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1000000


class HostLiveness:
    """Physical liveness only; never grants a job, channel or budget."""
    def __init__(self, directory='/run/hermes-executor/guardian-health', now=None):
        self.now = now or boot_ms
        self.directory = directory
        self.path = directory + '/STATE.json'
        self.boot_id = str(uuid.uuid4())
        self.counter = 0
        self.last = self.now()
        self.ready = False
        self._assert_directory()
        try:
            os.lstat(self.path)
            raise ContainmentError('GUARDIAN_HOST_STATE_DIRTY')
        except FileNotFoundError:
            pass
        signal.signal(signal.SIGUSR1, lambda _signal, _frame: None)
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR1})
        self.publish()

    def _assert_directory(self):
        value = os.lstat(self.directory)
        if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode) or value.st_uid != 10000 or value.st_gid != 10000 or stat.S_IMODE(value.st_mode) != 0o700:
            raise ContainmentError('GUARDIAN_HOST_DIRECTORY')

    def publish(self):
        self._assert_directory()
        temporary = self.directory + '/NEXT.json'
        payload = json.dumps({'schema_version': 1, 'boot_id': self.boot_id, 'counter': self.counter, 'ready': self.ready}, separators=(',', ':')).encode() + b'\n'
        if len(payload) > 512:
            raise ContainmentError('GUARDIAN_HOST_STATE')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400)
        try:
            if os.write(descriptor, payload) != len(payload):
                raise ContainmentError('GUARDIAN_HOST_STATE')
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, self.path)
        descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def check(self, wait=0):
        now = self.now()
        if now - self.last >= HOST_HEARTBEAT_MS:
            raise ContainmentError('GUARDIAN_HOST_UNRESPONSIVE')
        info = signal.sigtimedwait({signal.SIGUSR1}, wait)
        if info is None:
            return False
        # Docker daemon signals originate as root in this non-userns contract.
        if getattr(info, 'si_uid', None) != 0:
            raise ContainmentError('GUARDIAN_HOST_IDENTITY')
        # Never let an old pending signal revive a physically expired process.
        now = self.now()
        if now - self.last >= HOST_HEARTBEAT_MS:
            raise ContainmentError('GUARDIAN_HOST_UNRESPONSIVE')
        if self.counter >= 9007199254740991:
            raise ContainmentError('GUARDIAN_RECYCLE_REQUIRED')
        self.last = now
        self.counter += 1
        self.ready = True
        self.publish()
        return True


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ContainmentError('GUARDIAN_SHAPE')


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ContainmentError('GUARDIAN_DUPLICATE_KEY')
        value[key] = item
    return value


def binding_key(value):
    exact(value, ('target_request_id', 'mission_id', 'assignment_id'))
    if any(not isinstance(v, str) or not UUID.fullmatch(v) for v in value.values()):
        raise ContainmentError('GUARDIAN_BINDING')
    return (value['target_request_id'], value['mission_id'], value['assignment_id'])


def identity(grant):
    exact(grant, ('allowed', 'job_id', 'mission_id', 'worker_id', 'window_id', 'epoch_id', 'budget_version', 'valid_for_ms', 'challenge_id'))
    if grant['allowed'] is not True or any(not isinstance(grant[k], str) or not UUID.fullmatch(grant[k]) for k in ('job_id', 'mission_id', 'window_id', 'epoch_id', 'challenge_id')):
        raise ContainmentError('GUARDIAN_GRANT')
    if not isinstance(grant['worker_id'], str) or not re.fullmatch(r'[A-Za-z0-9._:-]{3,128}', grant['worker_id']):
        raise ContainmentError('GUARDIAN_GRANT')
    if type(grant['budget_version']) is not int or not 1 <= grant['budget_version'] <= 9007199254740991:
        raise ContainmentError('GUARDIAN_GRANT')
    if type(grant['valid_for_ms']) is not int or not 1 <= grant['valid_for_ms'] <= MAX_LEASE_MS:
        raise ContainmentError('GUARDIAN_GRANT')
    return tuple(grant[k] for k in ('job_id', 'mission_id', 'worker_id', 'window_id', 'epoch_id', 'budget_version'))


class LeaseAuthority:
    def __init__(self, now=None, external_check=None):
        self.now = now or (lambda: time.monotonic_ns() // 1000000)
        self.challenges = {}
        self.active = None
        self.terminal = set()
        self.deadline = None
        self.last_heartbeat = self.now()
        self.external_check = external_check

    def check(self):
        if self.external_check:
            self.external_check()
        now = self.now()
        if now - self.last_heartbeat >= HEARTBEAT_MS:
            raise ContainmentError('GUARDIAN_SERVER_UNRESPONSIVE')
        if self.active is not None and now >= self.deadline:
            raise ContainmentError('GUARDIAN_LEASE_EXPIRED')

    def heartbeat(self):
        self.check()  # Late heartbeat cannot resurrect either deadline.
        self.last_heartbeat = self.now()

    def issue(self, binding):
        self.check()
        key = binding_key(binding)
        if key in self.terminal or (self.active and self.active[0] != key):
            raise ContainmentError('GUARDIAN_BINDING')
        now = self.now()
        self.challenges = {k: v for k, v in self.challenges.items() if v[1] + MAX_LEASE_MS > now}
        if len(self.challenges) >= 64:
            raise ContainmentError('GUARDIAN_CAPACITY')
        token = str(uuid.uuid4())
        self.challenges[token] = (key, now)
        return token

    def arm(self, binding, grant, renew=False):
        self.check()
        key, ident = binding_key(binding), identity(grant)
        if not renew and len(self.terminal) >= 1024:
            raise ContainmentError('GUARDIAN_RECYCLE_REQUIRED')
        entry = self.challenges.pop(grant['challenge_id'], None)
        if key in self.terminal or not entry or entry[0] != key or grant['mission_id'] != key[1] or grant['job_id'] != key[2]:
            raise ContainmentError('GUARDIAN_BINDING')
        deadline = entry[1] + grant['valid_for_ms']
        if deadline <= self.now():
            raise ContainmentError('GUARDIAN_LEASE_EXPIRED')
        if (renew and self.active != (key, ident)) or (not renew and self.active is not None):
            raise ContainmentError('GUARDIAN_ACTIVE_CONFLICT')
        self.active, self.deadline = (key, ident), deadline
        self.check()

    def finish(self, binding):
        self.check()
        key = binding_key(binding)
        if not self.active or self.active[0] != key:
            raise ContainmentError('GUARDIAN_BINDING')
        if len(self.terminal) >= 1024:
            raise ContainmentError('GUARDIAN_RECYCLE_REQUIRED')
        self.terminal.add(key)
        self.challenges = {k: v for k, v in self.challenges.items() if v[0] != key}
        self.active, self.deadline = None, None


def assert_bootstrap():
    if os.getpid() != 1 or os.getuid() != 10000 or os.getgid() != 10000 or os.getgroups():
        raise ContainmentError('GUARDIAN_IDENTITY')
    with open('/proc/self/status', encoding='ascii') as f:
        fields = dict(line.strip().split(':', 1) for line in f if ':' in line)
    if fields.get('NoNewPrivs', '').strip() != '1' or any(fields.get(k, '').strip() != CAPS for k in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')):
        raise ContainmentError('GUARDIAN_CAPABILITIES')
    for k in ('Uid', 'Gid'):
        if fields[k].split() != ['10000'] * 4:
            raise ContainmentError('GUARDIAN_IDENTITY')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise ContainmentError('GUARDIAN_PIDFD_REQUIRED')


def child_pidfds():
    result = []
    try:
        pids = [p for p in os.listdir('/proc') if p.isdigit()]
        if len(pids) > 256:
            raise ContainmentError('GUARDIAN_PROCESS_LIMIT')
        for pid in pids:
            if int(pid) == 1:
                continue
            fd = None
            try:
                # Capture kernel identity BEFORE reading UID: a reused numeric
                # PID cannot redirect a later signal to an unrelated process.
                fd = os.pidfd_open(int(pid))
                with open('/proc/' + pid + '/status', encoding='ascii') as f:
                    fields = dict(line.strip().split(':', 1) for line in f if ':' in line)
                if fields.get('Uid', '').split() == ['10002'] * 4:
                    result.append(fd)
                    fd = None
            except (ProcessLookupError, FileNotFoundError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        return result
    except BaseException:
        for fd in result:
            os.close(fd)
        raise


def reap(server_pid):
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return
        if pid == server_pid:
            raise ContainmentError('GUARDIAN_SERVER_EXITED')


def clean_children(authority, server_pid):
    until = time.monotonic() + 0.5
    while True:
        authority.check()
        reap(server_pid)
        children = child_pidfds()
        if not children:
            authority.check()
            return
        for fd in children:
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
        if time.monotonic() >= until:
            raise ContainmentError('GUARDIAN_CHILDREN_NOT_REAPED')
        time.sleep(0.01)


def serve(server_argv):
    """Internal test seam; the production CLI below accepts no command input."""
    assert_bootstrap()
    host = HostLiveness()
    while not host.ready:
        host.check(0.025)
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    parent.setblocking(False)
    environment = dict(os.environ, EXECUTOR_GUARDIAN_FD=str(child.fileno()))
    server = subprocess.Popen(server_argv, env=environment, pass_fds=(child.fileno(),), stdin=subprocess.DEVNULL)
    child.close()
    authority, pending, replies = LeaseAuthority(external_check=host.check), bytearray(), bytearray()
    selector = selectors.DefaultSelector()
    selector.register(parent, selectors.EVENT_READ)
    last_sequence = 0
    try:
        while True:
            authority.check()
            reap(server.pid)
            selector.modify(parent, selectors.EVENT_READ | (selectors.EVENT_WRITE if replies else 0))
            for _, events in selector.select(0.025):
                authority.check()
                if events & selectors.EVENT_READ:
                    chunk = parent.recv(MAX_FRAME + 1)
                    if not chunk:
                        raise ContainmentError('GUARDIAN_CHANNEL_CLOSED')
                    pending.extend(chunk)
                    if len(pending) > MAX_FRAME:
                        raise ContainmentError('GUARDIAN_FRAME_LIMIT')
                    while b'\n' in pending:
                        raw, _, rest = pending.partition(b'\n')
                        pending = bytearray(rest)
                        command = json.loads(raw, object_pairs_hook=unique_object)
                        op = command.get('op') if isinstance(command, dict) else None
                        required = ['id', 'seq', 'op'] + ([] if op == 'heartbeat' else ['binding']) + (['grant'] if op in ('begin', 'renew') else [])
                        exact(command, required)
                        if not isinstance(command['id'], str) or not UUID.fullmatch(command['id']):
                            raise ContainmentError('GUARDIAN_REQUEST_ID')
                        if type(command['seq']) is not int or command['seq'] != last_sequence + 1 or command['seq'] > 9007199254740991:
                            raise ContainmentError('GUARDIAN_SEQUENCE')
                        last_sequence = command['seq']
                        reply = {'id': command['id'], 'ok': True}
                        if op == 'heartbeat':
                            authority.heartbeat()
                        elif op == 'challenge':
                            reply['challenge_id'] = authority.issue(command['binding'])
                        elif op in ('begin', 'renew'):
                            if op == 'begin':
                                stale = child_pidfds()
                                for fd in stale:
                                    os.close(fd)
                                if stale:
                                    raise ContainmentError('GUARDIAN_STALE_CHILDREN')
                            authority.arm(command['binding'], command['grant'], op == 'renew')
                        elif op == 'finish':
                            clean_children(authority, server.pid)
                            authority.finish(command['binding'])
                        else:
                            raise ContainmentError('GUARDIAN_OPERATION')
                        authority.check()
                        replies.extend(json.dumps(reply, separators=(',', ':')).encode() + b'\n')
                        if len(replies) > MAX_FRAME * 2:
                            raise ContainmentError('GUARDIAN_BACKPRESSURE')
                if events & selectors.EVENT_WRITE and replies:
                    count = parent.send(replies)
                    del replies[:count]
    finally:
        selector.close()
        parent.close()
        # No result is asserted here. PID1 exit destroys the private namespace,
        # including detached descendants; broker retains uncertain usage.


if __name__ == '__main__':
    try:
        def shutdown(_signum, _frame):
            raise ContainmentError('GUARDIAN_SHUTDOWN')
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        if len(os.sys.argv) != 1:
            raise ContainmentError('GUARDIAN_ARGUMENTS')
        serve(['/usr/local/bin/node', '/app/dist/executor-main.js'])
    except BaseException as error:
        # Bounded/nonblocking code-only telemetry must not delay containment.
        code = str(error) if isinstance(error, ContainmentError) and re.fullmatch(r'GUARDIAN_[A-Z_]{1,64}', str(error)) else 'GUARDIAN_INTERNAL_FAILURE'
        try:
            os.set_blocking(2, False)
            os.write(2, (json.dumps({'type': 'executor_guardian_stop', 'code': code}) + '\n').encode())
        except BaseException:
            pass
        os._exit(70)
