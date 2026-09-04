import importlib.util
import json
import os
import pathlib
import socket
import stat
import tempfile
import unittest
import uuid
from unittest import mock


def module(name):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


bootstrap=module('bootstrap');health=module('healthcheck')


class BootstrapTests(unittest.TestCase):
    def test_fixed_command_is_v2_without_caller_arguments(self):
        self.assertEqual(bootstrap.COMMAND[-4:],['/opt/hermes/.venv/bin/python','-I','-B','/app/guardian/executor_guardian.py'])
        self.assertIn('--clear-groups',bootstrap.COMMAND)
        self.assertIn('--no-new-privs',bootstrap.COMMAND)

    def test_non_pid1_or_command_override_is_rejected(self):
        with mock.patch.object(bootstrap.sys,'argv',['bootstrap','arbitrary']),mock.patch.object(os,'getpid',return_value=1):
            with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_IDENTITY'):bootstrap.prepare()
        with mock.patch.object(bootstrap.sys,'argv',['bootstrap']),mock.patch.object(os,'getpid',return_value=2):
            with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_IDENTITY'):bootstrap.prepare()

    def test_wrong_capabilities_fail_before_file_or_exec(self):
        with mock.patch.object(bootstrap.sys,'argv',['bootstrap']),mock.patch.object(os,'getpid',return_value=1), \
                mock.patch('builtins.open',mock.mock_open(read_data='NoNewPrivs: 1\nCapBnd: 0000000000000000\n')),mock.patch.object(os,'execv') as execute:
            with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_CAPABILITIES'):bootstrap.prepare()
            execute.assert_not_called()

    def test_mutable_code_symlink_and_writable_parent_rejected(self):
        with tempfile.TemporaryDirectory(dir='/run') as root:
            root=pathlib.Path(root);code=root/'code.py';code.write_text('pass');code.chmod(0o444)
            bootstrap.immutable_file(str(code))
            alias=root/'alias';alias.symlink_to(code)
            with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_CODE_METADATA'):bootstrap.immutable_file(str(alias))
            code.chmod(0o644)
            with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_CODE_METADATA'):bootstrap.immutable_file(str(code))
            code.chmod(0o444);root.chmod(0o777)
            with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_CODE_DIRECTORY'):bootstrap.immutable_file(str(code))

    def test_fresh_health_directory_then_fixed_exec_and_no_reuse(self):
        with tempfile.TemporaryDirectory(dir='/run') as root:
            root=pathlib.Path(root);root.chmod(0o711)
            fields='NoNewPrivs: 1\n'+''.join(key+': '+bootstrap.CAPS+'\n' for key in ['CapPrm','CapEff','CapBnd'])
            with mock.patch.object(bootstrap,'ROOT',str(root)),mock.patch.object(bootstrap,'immutable_file'), \
                    mock.patch.object(bootstrap.sys,'argv',['bootstrap']),mock.patch.object(os,'getpid',return_value=1), \
                    mock.patch('builtins.open',mock.mock_open(read_data=fields)),mock.patch.object(os,'closerange') as close, \
                    mock.patch.object(os,'execv') as execute:
                bootstrap.prepare();execute.assert_called_once_with(bootstrap.COMMAND[0],bootstrap.COMMAND)
                close.assert_called_once_with(3,1048576)
                value=os.stat(root/'guardian-health');self.assertEqual((value.st_uid,value.st_gid,stat.S_IMODE(value.st_mode)),(10000,10000,0o700))
                self.assertEqual((os.stat(root).st_uid,os.stat(root).st_gid),(10000,10000))
                # A new process cannot adopt this already-transferred root.
                with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_TEMPORARY_ROOT'):bootstrap.prepare()
                os.chown(root,0,0)
                with self.assertRaisesRegex(bootstrap.BootstrapError,'BOOTSTRAP_HEALTH_ALREADY_EXISTS'):bootstrap.prepare()


class HealthTests(unittest.TestCase):
    def fields(self,caps):
        return {'Uid':'10000 '*4,'Gid':'10000 '*4,'Groups':'','NoNewPrivs':'1',**{key:caps for key in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']}}

    def test_healthcheck_cannot_be_invoked_as_root_or_with_extra_arguments(self):
        with mock.patch.object(health.sys,'argv',['healthcheck']),mock.patch.object(os,'getuid',return_value=0):
            with self.assertRaisesRegex(health.HealthError,'HEALTH_CALLER'):health.check()
        with mock.patch.object(health.sys,'argv',['healthcheck','--path=/secrets']):
            with self.assertRaisesRegex(health.HealthError,'HEALTH_CALLER'):health.check()

    def test_exact_capless_and_guardian_identities(self):
        health.identity(self.fields('0'*16),'0'*16);health.identity(self.fields(health.CAPS),health.CAPS)
        for key,value in [('Groups','11000'),('NoNewPrivs','0'),('CapBnd',health.CAPS),('Uid','10002 '*4)]:
            fields=self.fields('0'*16);fields[key]=value
            with self.assertRaises(health.HealthError):health.identity(fields,'0'*16)

    def test_state_checks_type_identity_duplicate_and_readiness(self):
        with tempfile.TemporaryDirectory() as root:
            path=pathlib.Path(root)/'STATE.json';fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
            self.addCleanup(os.close,fd)
            good={'schema_version':1,'boot_id':str(uuid.uuid4()),'counter':1,'ready':True}
            def put(value):
                path.write_text(json.dumps(value));path.chmod(0o400);os.chown(path,10000,10000)
            put(good);self.assertEqual(health.state(fd),good)
            for key,value in [('schema_version',True),('counter',0),('counter',True),('ready',False),('boot_id','bad')]:
                put({**good,key:value})
                with self.assertRaises(health.HealthError):health.state(fd)
            path.write_text('{"schema_version":1,"schema_version":1}')
            with self.assertRaisesRegex(health.HealthError,'HEALTH_DUPLICATE_JSON'):health.state(fd)

    def test_socket_is_metadata_only_and_requires_exact_owner_mode(self):
        with tempfile.TemporaryDirectory() as root,socket.socket(socket.AF_UNIX) as sock:
            os.chown(root,10000,11000);os.chmod(root,0o2770);path=root+'/executor.sock'
            sock.bind(path);os.chown(path,10000,11000);os.chmod(path,0o660)
            with mock.patch.object(health,'SOCKET_DIRECTORY',root):
                health.socket_ready();os.chmod(path,0o666)
                with self.assertRaisesRegex(health.HealthError,'HEALTH_SOCKET'):health.socket_ready()

    def run_probe(self,states,clock):
        fd=os.open('/dev/null',os.O_RDONLY)
        with mock.patch.object(health.sys,'argv',['healthcheck']),mock.patch.object(os,'getuid',return_value=10000), \
                mock.patch.object(os,'getgid',return_value=10000),mock.patch.object(os,'getgroups',return_value=[]), \
                mock.patch.object(health,'status',side_effect=[self.fields('0'*16),self.fields(health.CAPS)]), \
                mock.patch('builtins.open',mock.mock_open(read_data=health.GUARDIAN_COMMAND)), \
                mock.patch.object(health,'socket_ready'),mock.patch.object(health,'directory',return_value=fd), \
                mock.patch.object(health,'state',side_effect=states),mock.patch.object(health.time,'sleep'), \
                mock.patch.object(health.time,'clock_gettime_ns',side_effect=clock):
            health.check()

    def test_increment_is_required_and_accepted_within_deadline(self):
        value={'boot_id':str(uuid.uuid4()),'counter':3}
        self.run_probe([value,{**value,'counter':4}],[0,1,2])

    def test_frozen_or_late_ack_is_not_healthy(self):
        value={'boot_id':str(uuid.uuid4()),'counter':3}
        for states,clock in (([value,value],[0,1,2,1500000000]),([value,{**value,'counter':4}],[0,1,1500000000])):
            with self.assertRaisesRegex(health.HealthError,'HEALTH_ACK_TIMEOUT'):self.run_probe(states,clock)

    def test_boot_change_and_counter_rollback_fail(self):
        value={'boot_id':str(uuid.uuid4()),'counter':3}
        for changed in ({**value,'boot_id':str(uuid.uuid4())},{**value,'counter':2}):
            with self.assertRaisesRegex(health.HealthError,'HEALTH_GENERATION'):self.run_probe([value,changed],[0,1,2])


if __name__=='__main__':unittest.main(verbosity=2)
