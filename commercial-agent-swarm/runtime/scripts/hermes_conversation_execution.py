"""One-shot model generation inside an already isolated, admitted child.

This is not an admission service, scheduler, CLI or sender. The trusted executor
must supply the prepared turn, key, reservation and live lease, enforce its
process deadline and validate native usage before settlement. No files are read
or written here. A consumed instance cannot be used for a second attempt.
"""
import json
import ssl
import threading
import time
from typing import NamedTuple

from hermes_conversation_agent import (
    BASE_URL, MODEL, assert_bound_agent, assert_provider_request,
    build_bound_agent_options, conversation_binding,
)
from hermes_conversation_turn import PreparedTurn, bind_conversation_reply


class ConversationTransportStopped(RuntimeError):
    """Closed transport denial, paired with the native hard-interrupt path."""


class ConversationExecutionResult(NamedTuple):
    status: str
    execution_state: str
    reply: object
    native_usage_json: object
    stop_code: object
    transport_attempts: int


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('DUPLICATE_KEY')
        value[key] = item
    return value


class ConversationRequestGuard:
    def __init__(self, scope, turn, maximum_tokens, timeout_seconds, lease_live):
        key, _ = conversation_binding(scope)
        if type(turn) is not PreparedTurn or key != turn.conversation_key:
            raise ValueError('HERMES_CONVERSATION_BINDING_INVALID')
        if type(maximum_tokens) is not int or not 1 <= maximum_tokens <= 8192:
            raise ValueError('HERMES_CONVERSATION_BUDGET_INVALID')
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 600 or not callable(lease_live):
            raise ValueError('HERMES_CONVERSATION_LEASE_INVALID')
        self._scope, self._turn = dict(scope), turn
        self._maximum_tokens = maximum_tokens
        self._timeout = timeout_seconds
        self._deadline = None
        self._lease_live = lease_live
        self._lock = threading.Lock()
        self.attempts = 0
        self.stopped = False
        self._closed = False
        self.stop_code = None

    def start(self):
        with self._lock:
            if self._deadline is not None or self.stopped or self._closed:
                raise ConversationTransportStopped('HERMES_CONVERSATION_REPLAY_DENIED')
            self._deadline = time.monotonic() + self._timeout

    def close(self):
        with self._lock:
            self._closed = True

    def validate_completion(self):
        with self._lock:
            try:
                if self.stopped or self.attempts != 1 or time.monotonic() >= self._deadline or self._lease_live() is not True:
                    raise ValueError()
            except Exception:
                raise ConversationTransportStopped('HERMES_CONVERSATION_LEASE_EXPIRED') from None

    def __call__(self, request):
        with self._lock:
            code = 'HERMES_CONVERSATION_REQUEST_DENIED'
            try:
                if self.stopped or self._closed or self.attempts or self._deadline is None:
                    code = 'HERMES_CONVERSATION_REPLAY_DENIED'
                    raise ValueError()
                if time.monotonic() >= self._deadline or self._lease_live() is not True:
                    code = 'HERMES_CONVERSATION_LEASE_EXPIRED'
                    raise ValueError()
                assert_provider_request(request, self._scope)
                raw = request.content
                if type(raw) is not bytes or not 1 <= len(raw) <= 131072:
                    raise ValueError()
                body = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique,
                                  parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                allowed = {'model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream',
                           'stream_options', 'temperature', 'top_p', 'reasoning_effort', 'thinking', 'n'}
                if type(body) is not dict or set(body) - allowed or body.get('model') != MODEL:
                    raise ValueError()
                maximum = body.get('max_tokens', body.get('max_completion_tokens'))
                if ('max_tokens' in body and 'max_completion_tokens' in body) or type(maximum) is not int or not 1 <= maximum <= self._maximum_tokens:
                    raise ValueError()
                if 'thinking' in body and body['thinking'] not in ({'type': 'enabled'}, {'type': 'disabled'}):
                    raise ValueError()
                if 'stream_options' in body:
                    stream_options = body['stream_options']
                    if type(stream_options) is not dict or set(stream_options) != {'include_usage'} or stream_options['include_usage'] is not True:
                        raise ValueError()
                messages = body.get('messages')
                if type(messages) is not list or len(messages) != 2:
                    raise ValueError()
                system, user = messages
                if type(system) is not dict or type(user) is not dict:
                    raise ValueError()
                if set(system) != {'role', 'content'} or set(user) != {'role', 'content'}:
                    raise ValueError()
                if system['role'] != 'system' or type(system['content']) is not str or self._turn.system_prompt not in system['content']:
                    raise ValueError()
                if user != {'role': 'user', 'content': self._turn.user_message}:
                    raise ValueError()
                if type(body.get('n', 1)) is not int or body.get('n', 1) != 1 or type(body.get('stream', False)) is not bool:
                    raise ValueError()
                self.attempts = 1
            except Exception:
                self.stopped = True
                self.stop_code = self.stop_code or code
                raise ConversationTransportStopped(code) from None


def _create_guarded_agent(scope, options, guard):
    kwargs = build_bound_agent_options(scope, options)
    from run_agent import AIAgent
    import httpx

    class BoundAgent(AIAgent):
        def _create_openai_client(self, *args, **kwargs):
            client = super()._create_openai_client(*args, **kwargs)
            # Provider uncertainty is not permission for an SDK-level replay.
            client.max_retries = 0
            return client

        def _build_keepalive_http_client(self, base_url='', *, verify=True):
            verified_tls = verify is True or (isinstance(verify, ssl.SSLContext) and
                verify.verify_mode == ssl.CERT_REQUIRED and verify.check_hostname is True)
            if base_url != BASE_URL or not verified_tls:
                raise ConversationTransportStopped('HERMES_CONVERSATION_CLIENT_DENIED')
            client = AIAgent._build_keepalive_http_client(base_url, verify=verify)
            if not isinstance(client, httpx.Client):
                raise ConversationTransportStopped('HERMES_CONVERSATION_CLIENT_DENIED')
            # The native builder returns a fresh client for each main/aux call.
            # Keep its proxy/TLS policy, but never follow a response redirect.
            client.follow_redirects = False
            def before_request(request):
                try:
                    guard(request)
                except ConversationTransportStopped:
                    self.interrupt(hard_cancel=True, tool_reason='conversation transport denied')
                    raise
            client.event_hooks['request'].insert(0, before_request)
            return client

    agent = BoundAgent(**kwargs)
    try:
        assert_bound_agent(agent, scope)
        if agent.tools != []:
            raise ValueError('HERMES_CONVERSATION_TOOLS_DENIED')
        return agent
    except BaseException:
        agent.close()
        raise


def _usage_json(result):
    # Reuse the native oneshot export schema, without its best-effort filesystem
    # write. The parent still applies validateHermesUsage and pricing checks.
    from hermes_cli.oneshot import _USAGE_KEYS
    report = {key: result.get(key) for key in _USAGE_KEYS}
    report['failed'] = bool(result.get('failed'))
    report['service_tier'] = result.get('service_tier')
    raw = json.dumps(report, separators=(',', ':'), allow_nan=False)
    if len(raw.encode('utf-8')) > 8192:
        raise ValueError('HERMES_CONVERSATION_USAGE_INVALID')
    return raw


class ConversationExecution:
    def __init__(self, scope, turn, options, *, lease_live):
        if type(turn) is not PreparedTurn:
            raise ValueError('HERMES_CONVERSATION_TURN_INVALID')
        # Neither the model nor the caller may substitute a system prompt.
        if type(options) is not dict:
            raise ValueError('HERMES_CONVERSATION_OPTIONS_INVALID')
        options = dict(options)
        if options.get('ephemeral_system_prompt') != turn.system_prompt or options.get('max_iterations') != 1:
            raise ValueError('HERMES_CONVERSATION_OPTIONS_INVALID')
        build_bound_agent_options(scope, options)
        self._scope, self._turn, self._options = dict(scope), turn, options
        self._guard = ConversationRequestGuard(scope, turn, options['max_tokens'], options['run_budget_seconds'], lease_live)
        self._lock, self._consumed = threading.Lock(), False

    def run(self):
        with self._lock:
            if self._consumed:
                raise ValueError('HERMES_CONVERSATION_EXECUTION_CONSUMED')
            self._consumed = True
        agent, usage, reply, code = None, None, None, None
        state = 'not_started'
        try:
            self._guard.start()
            agent = _create_guarded_agent(self._scope, self._options, self._guard)
            result = agent.run_conversation(self._turn.user_message)
            if self._guard.stop_code:
                raise ConversationTransportStopped(self._guard.stop_code)
            state = 'finished'
            assert_bound_agent(agent, self._scope)
            if type(result) is not dict:
                raise ValueError()
            usage = _usage_json(result)
            if result.get('failed') is True or result.get('completed') is not True:
                code = 'HERMES_CONVERSATION_MODEL_FAILED'
                state = 'unknown' if self._guard.attempts else 'not_started'
                usage = None
            elif self._guard.attempts != 1:
                code = 'HERMES_CONVERSATION_ATTEMPT_INVALID'
            else:
                self._guard.validate_completion()
                reply = bind_conversation_reply(self._turn, result['final_response'].encode('utf-8'))
        except ConversationTransportStopped as error:
            code = str(error)
            if state != 'finished':
                state = 'unknown' if self._guard.attempts else 'not_started'
        except Exception:
            code = 'HERMES_CONVERSATION_RESULT_INVALID' if state == 'finished' else 'HERMES_CONVERSATION_EXECUTION_FAILED'
            if state != 'finished' and self._guard.attempts:
                state = 'unknown'
        finally:
            self._guard.close()
            self._options['api_key'] = ''
            if agent is not None:
                try:
                    agent.close()
                except Exception:
                    code = 'HERMES_CONVERSATION_CLEANUP_FAILED'
                    reply = None
        if reply is not None and code is None:
            try:
                # Native cleanup can yield after response validation. Do not
                # return a reply if the lease was revoked during that interval.
                self._guard.validate_completion()
            except ConversationTransportStopped as error:
                code, reply = str(error), None
        return ConversationExecutionResult('failed' if code else 'completed', state,
            reply if code is None else None, usage, code, self._guard.attempts)
