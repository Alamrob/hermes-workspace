import hashlib
import json
import os
import sys
import unittest

SCRIPT_DIRECTORY = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), 'scripts')
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from hermes_conversation_turn import bind_conversation_reply, prepare_conversation_turn


class HermesConversationTurnTest(unittest.TestCase):
    def setUp(self):
        self.scope = {
            'schema': 'proptimiza-hermes-affinity.v1',
            'source': 'proptimiza-whatsapp',
            'gateway_session_key': 'pcw1_' + ('a' * 64),
        }
        self.context = json.dumps({
            'schema': 'proptimiza-business-context.v1',
            'revision': 'fixture',
            'valid_from': 1,
            'valid_until': 2000000000,
            'facts': [{'id': 'verified_fact', 'text': 'Hecho ficticio verificado.'}],
        }, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        transcript = {
            'schema': 'proptimiza-conversation-transcript.v1',
            'scope': self.scope,
            'messages': [{'message_id': '101', 'sequence': 1, 'kind': 'incoming',
                          'content': 'Consulta ficticia.'}],
        }
        self.turn = prepare_conversation_turn(
            self.scope, self.context, transcript,
            expected_context_sha256=hashlib.sha256(self.context).hexdigest(),
            now_epoch_seconds=100,
        )
        self.reply = json.dumps({
            'response': 'Respuesta ficticia.',
            'fact_ids': ['verified_fact'],
            'handoff_reason': 'none',
        }, ensure_ascii=False, separators=(',', ':'))

    def test_accepts_raw_json_and_one_whole_json_fence(self):
        raw = bind_conversation_reply(self.turn, self.reply.encode('utf-8'))
        fenced = bind_conversation_reply(
            self.turn, f'```json\n{self.reply}\n```'.encode('utf-8'))
        self.assertEqual(raw, fenced)
        self.assertFalse(fenced.send_permitted)

    def test_rejects_wrapping_prose_multiple_fences_and_malformed_json(self):
        values = [
            f'Resultado:\n```json\n{self.reply}\n```',
            f'```json\n{self.reply}\n```\n```json\n{self.reply}\n```',
            '```json\n{"response":\n```',
        ]
        for value in values:
            with self.subTest(value=value[:16]):
                with self.assertRaisesRegex(ValueError, 'HERMES_CONVERSATION_TURN_INVALID'):
                    bind_conversation_reply(self.turn, value.encode('utf-8'))


if __name__ == '__main__':
    unittest.main()
