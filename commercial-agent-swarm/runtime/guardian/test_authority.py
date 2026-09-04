import json
import unittest
import uuid
from unittest.mock import patch
from types import SimpleNamespace
from executor_guardian import LeaseAuthority, ContainmentError, HostLiveness, unique_object


def uid():
    return str(uuid.uuid4())


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.a = LeaseAuthority(lambda: self.now)
        self.b = {'target_request_id': uid(), 'mission_id': uid(), 'assignment_id': uid()}

    def grant(self, challenge=None, **changes):
        return dict(allowed=True, job_id=self.b['assignment_id'], mission_id=self.b['mission_id'], worker_id='test-worker', window_id=uid(), epoch_id=uid(), budget_version=1, valid_for_ms=5000, challenge_id=challenge or self.a.issue(self.b), **changes)

    def test_challenge_anchors_before_delayed_grant(self):
        g = self.grant()
        self.now += 1500
        self.a.arm(self.b, g)
        self.assertEqual(self.a.deadline, 5100)

    def test_heartbeat_never_renews_lease(self):
        g = self.grant(); g['valid_for_ms'] = 200
        self.a.arm(self.b, g)
        self.now += 199; self.a.heartbeat()
        self.now += 1
        with self.assertRaisesRegex(ContainmentError, 'LEASE_EXPIRED'): self.a.heartbeat()

    def test_late_begin_is_not_new_ttl(self):
        g = self.grant(); g['valid_for_ms'] = 100
        self.now += 101
        with self.assertRaisesRegex(ContainmentError, 'LEASE_EXPIRED'): self.a.arm(self.b, g)

    def test_renew_replay_denied(self):
        g = self.grant(); self.a.arm(self.b, g)
        g['challenge_id'] = self.a.issue(self.b)
        self.a.arm(self.b, g, True)
        with self.assertRaisesRegex(ContainmentError, 'BINDING'): self.a.arm(self.b, g, True)

    def test_renew_other_epoch_denied(self):
        g = self.grant(); self.a.arm(self.b, g)
        g['challenge_id'] = self.a.issue(self.b); g['epoch_id'] = uid()
        with self.assertRaisesRegex(ContainmentError, 'CONFLICT'): self.a.arm(self.b, g, True)

    def test_completed_binding_cannot_restart(self):
        g = self.grant(); self.a.arm(self.b, g); self.a.finish(self.b)
        with self.assertRaisesRegex(ContainmentError, 'BINDING'): self.a.issue(self.b)

    def test_recycle_capacity_rejects_before_arm(self):
        grant = self.grant()
        self.a.terminal.update((uid(), uid(), uid()) for _ in range(1024))
        with self.assertRaisesRegex(ContainmentError, 'RECYCLE_REQUIRED'): self.a.arm(self.b, grant)
        self.assertIsNone(self.a.active)

    def test_cross_binding_denied(self):
        g = self.grant(); g['job_id'] = uid()
        with self.assertRaisesRegex(ContainmentError, 'BINDING'): self.a.arm(self.b, g)

    def test_expired_server_never_revived(self):
        self.now += 2000
        with self.assertRaisesRegex(ContainmentError, 'UNRESPONSIVE'): self.a.heartbeat()

    def test_capacity_is_bounded_without_evicting_challenges(self):
        first = self.grant()
        for _ in range(63): self.a.issue(self.b)
        with self.assertRaisesRegex(ContainmentError, 'CAPACITY'): self.a.issue(self.b)
        self.a.arm(self.b, first)

    def test_strict_keys_bool_integer_and_expanded_authority(self):
        for key, value in [('budget_version', True), ('valid_for_ms', True), ('allowed', 1), ('valid_for_ms', 5001), ('worker_id', '*')]:
            with self.subTest(key=key, value=value):
                g = self.grant(); g[key] = value
                with self.assertRaises(ContainmentError): self.a.arm(self.b, g)
        with self.assertRaisesRegex(ContainmentError, 'DUPLICATE_KEY'):
            json.loads('{"op":"begin","op":"heartbeat"}', object_pairs_hook=unique_object)

    def test_external_liveness_is_checked_before_authority(self):
        calls = []
        authority = LeaseAuthority(lambda: 100, lambda: calls.append('host'))
        authority.issue(self.b)
        self.assertEqual(calls, ['host'])

    def test_host_expiry_precedes_pending_signal_consumption(self):
        host = object.__new__(HostLiveness)
        host.now = lambda: 5100; host.last = 100; host.counter = 0
        with self.assertRaisesRegex(ContainmentError, 'HOST_UNRESPONSIVE'):
            host.check(0)

    def test_host_foreign_signal_is_not_a_pulse(self):
        host = object.__new__(HostLiveness)
        host.now = lambda: 200; host.last = 100; host.counter = 0
        with patch('executor_guardian.signal.sigtimedwait', return_value=SimpleNamespace(si_uid=10000)):
            with self.assertRaisesRegex(ContainmentError, 'HOST_IDENTITY'): host.check()
        self.assertEqual(host.counter, 0)

    def test_host_expiry_during_wait_cannot_be_revived(self):
        host = object.__new__(HostLiveness)
        clock = iter([200, 5200]); host.now = lambda: next(clock); host.last = 100; host.counter = 0
        with patch('executor_guardian.signal.sigtimedwait', return_value=SimpleNamespace(si_uid=0)):
            with self.assertRaisesRegex(ContainmentError, 'HOST_UNRESPONSIVE'): host.check()
        self.assertEqual(host.counter, 0)

    def test_host_root_pulse_publishes_only_physical_progress(self):
        host = object.__new__(HostLiveness); published = []
        host.now = lambda: 200; host.last = 100; host.counter = 0; host.ready = False
        host.publish = lambda: published.append(host.counter)
        with patch('executor_guardian.signal.sigtimedwait', return_value=SimpleNamespace(si_uid=0)):
            self.assertTrue(host.check())
        self.assertEqual(published, [1]); self.assertTrue(host.ready); self.assertEqual(host.last, 200)


if __name__ == '__main__': unittest.main()
