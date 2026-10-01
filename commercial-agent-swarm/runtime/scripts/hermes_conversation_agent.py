"""Conversation identity adapter for the governed executor's future SDK path.

No CLI, scheduler, credential loader, model invocation or execution authority.
The executor remains responsible for admission, lease, reservation, isolation,
profile pin, prompt construction, cancellation and usage settlement.
"""
import hashlib
import re

PROVIDER = 'opencode-go'
MODEL = 'deepseek-v4-flash'
BASE_URL = 'https://opencode.ai/zen/go/v1'
SOURCE = 'proptimiza-whatsapp'
_SCOPE_FIELDS = {'schema', 'source', 'gateway_session_key'}
_OPTION_FIELDS = {'api_key', 'model', 'provider', 'base_url', 'api_mode',
                  'ephemeral_system_prompt', 'max_tokens', 'max_iterations', 'run_budget_seconds'}


def _invalid():
    raise ValueError('HERMES_BOUND_CONVERSATION_INVALID')


def conversation_binding(scope):
    if type(scope) is not dict or set(scope) != _SCOPE_FIELDS:
        _invalid()
    if scope.get('schema') != 'proptimiza-hermes-affinity.v1' or scope.get('source') != SOURCE:
        _invalid()
    key = scope.get('gateway_session_key')
    if type(key) is not str or re.fullmatch(r'pcw1_[0-9a-f]{64}', key) is None:
        _invalid()
    # Native Hermes hashes source|gateway_session_key|conversation_boundary.
    # This adapter uses no Hermes session DB. The durable logical generation is
    # already part of the host-issued key; no physical/session ID is reused.
    native = 'gwk_' + hashlib.sha256(f'{SOURCE}|{key}|'.encode()).hexdigest()[:24]
    return key, native


def build_bound_agent_options(scope, options):
    key, _ = conversation_binding(scope)
    if type(options) is not dict or set(options) != _OPTION_FIELDS:
        _invalid()
    if (options['provider'], options['base_url'], options['model'], options['api_mode']) != (
            PROVIDER, BASE_URL, MODEL, 'chat_completions'):
        _invalid()
    if type(options['api_key']) is not str or not 1 <= len(options['api_key']) <= 8192:
        _invalid()
    prompt = options['ephemeral_system_prompt']
    if type(prompt) is not str or not 1 <= len(prompt) <= 16384 or '\0' in prompt:
        _invalid()
    for name, maximum in [('max_tokens', 8192), ('max_iterations', 4), ('run_budget_seconds', 600)]:
        if type(options[name]) is not int or not 1 <= options[name] <= maximum:
            _invalid()
    return {**options, 'requested_provider': PROVIDER, 'gateway_session_key': key,
            'platform': SOURCE, 'enabled_toolsets': [], 'disabled_toolsets': ['all'],
            'skip_context_files': True, 'load_soul_identity': False, 'skip_memory': True,
            'skip_background_review': True, 'session_db': None, 'fallback_model': None,
            'credential_pool': None, 'checkpoints_enabled': False, 'save_trajectories': False,
            'quiet_mode': True, 'verbose_logging': False}


def assert_bound_agent(agent, scope):
    from agent.prompt_cache_scope import declared_conversation_scope
    key, expected = conversation_binding(scope)
    if (getattr(agent, '_gateway_session_key', None) != key or
            getattr(agent, 'platform', None) != SOURCE or
            getattr(agent, 'provider', None) != PROVIDER or
            getattr(agent, 'base_url', None) != BASE_URL or
            getattr(agent, 'model', None) != MODEL or
            getattr(agent, '_session_db', None) is not None or
            declared_conversation_scope(agent) != expected):
        raise ValueError('HERMES_BOUND_CONVERSATION_DRIFT')


def create_bound_agent(scope, options):
    # Validate everything before importing Hermes, constructing a client, or
    # touching its ephemeral home. A bad input cannot select another provider.
    kwargs = build_bound_agent_options(scope, options)
    from run_agent import AIAgent
    agent = AIAgent(**kwargs)
    try:
        assert_bound_agent(agent, scope)
        return agent
    except BaseException:
        agent.close()
        raise


def assert_provider_request(request, scope):
    """Fail-closed hook for the future executor-owned HTTP transport.

    Not installed globally. Every model transport, including auxiliary clients,
    must install it before any network attempt; testing a main client is not
    evidence of auxiliary coverage.
    """
    _, expected = conversation_binding(scope)
    url = request.url
    if (request.method != 'POST' or url.scheme != 'https' or url.host != 'opencode.ai' or
            url.port not in (None, 443) or url.path != '/zen/go/v1/chat/completions' or
            url.query or url.username or url.password):
        raise ValueError('HERMES_PROVIDER_ROUTE_DENIED')
    values = request.headers.get_list('x-opencode-session')
    if len(values) != 1 or values[0] != expected:
        raise ValueError('HERMES_PROVIDER_CONVERSATION_DENIED')
