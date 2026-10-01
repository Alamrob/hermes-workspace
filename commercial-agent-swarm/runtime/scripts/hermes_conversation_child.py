"""Bounded stdio entrypoint, callable only inside the executor's isolated child.

The parent owns admission, credentials, home, cancellation and usage settlement.
This protocol neither admits a job nor sends a message. Its local deadline is
not a database lease; the parent must kill the process when that lease is lost.
"""
import json
import os
import sys
import time

SCRIPT_DIRECTORY = os.path.dirname(os.path.realpath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from hermes_conversation_agent import BASE_URL, MODEL, PROVIDER
from hermes_conversation_turn import _json, _closed, prepare_conversation_turn

MAX_INPUT_BYTES = 131072
SCHEMA = 'proptimiza-conversation-child.v1'


def prepare_request(raw, now):
    value = _json(raw, MAX_INPUT_BYTES)
    _closed(value, ['schema', 'scope', 'context_json', 'context_sha256', 'transcript',
                    'turn_sha256', 'maximum_output_tokens', 'timeout_seconds'])
    if value['schema'] != SCHEMA or type(value['context_json']) is not str:
        raise ValueError('INVALID_CHILD_REQUEST')
    for key, maximum in [('maximum_output_tokens', 8192), ('timeout_seconds', 600)]:
        if type(value[key]) is not int or not 1 <= value[key] <= maximum:
            raise ValueError('INVALID_CHILD_REQUEST')
    turn = prepare_conversation_turn(value['scope'], value['context_json'].encode('utf-8'),
        value['transcript'], expected_context_sha256=value['context_sha256'], now_epoch_seconds=now)
    if turn.turn_sha256 != value['turn_sha256']:
        raise ValueError('INVALID_CHILD_REQUEST')
    return value, turn


def execute_request(raw):
    request, turn = prepare_request(raw, int(time.time()))
    key = os.environ.pop('OPENCODE_GO_API_KEY', '')
    if not key or len(key) > 8192:
        raise ValueError('INVALID_CHILD_KEY')
    from hermes_conversation_execution import ConversationExecution
    deadline = time.monotonic() + request['timeout_seconds']
    context_deadline = json.loads(request['context_json'])['valid_until']
    execution = ConversationExecution(request['scope'], turn, {
        'api_key': key, 'model': MODEL, 'provider': PROVIDER, 'base_url': BASE_URL,
        'api_mode': 'chat_completions', 'ephemeral_system_prompt': turn.system_prompt,
        'max_tokens': request['maximum_output_tokens'], 'max_iterations': 1,
        'run_budget_seconds': request['timeout_seconds'],
    }, lease_live=lambda: time.monotonic() < deadline and time.time() < context_deadline)
    key = ''
    result = execution.run()
    return {'schema': SCHEMA, **result._asdict(),
            'reply': result.reply._asdict() if result.reply is not None else None}


def main():
    # Native logging must not share the result channel or expose context/key.
    result_fd = os.dup(1)
    with open(os.devnull, 'wb') as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    result = {'schema': SCHEMA, 'status': 'failed', 'execution_state': 'not_started',
              'reply': None, 'native_usage_json': None,
              'stop_code': 'HERMES_CONVERSATION_INPUT_INVALID', 'transport_attempts': 0}
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        prepare_request(raw, int(time.time()))
        # After entering execution, an exception may have followed a request.
        result['execution_state'] = 'unknown'
        result['stop_code'] = 'HERMES_CONVERSATION_CHILD_FAILED'
        result = execute_request(raw)
    except Exception:
        pass
    encoded = json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8') + b'\n'
    if len(encoded) > 32768:
        os.close(result_fd)
        return 1
    with os.fdopen(result_fd, 'wb') as output:
        output.write(encoded)
    return 0


def exit_main():
    # AIAgent.close has already run and the bounded result fd has been flushed
    # and closed. Do not wait for native non-daemon/background interpreter
    # shutdown work in this one-shot child; the parent owns group containment.
    os._exit(main())


if __name__ == '__main__':
    exit_main()
