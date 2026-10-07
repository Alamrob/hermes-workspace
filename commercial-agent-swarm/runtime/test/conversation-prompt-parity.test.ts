import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CONVERSATION_PROMPT_SHA256, CONVERSATION_SYSTEM_PROMPT, conversationSha256 } from '../src/platform/conversation-request.js'

const normalizeLineEndings = (value: string) => value.replace(/\r\n/g, '\n')

test('keeps the TypeScript and Python conversation prompts identical across platforms', () => {
  const python = readFileSync(new URL('../scripts/hermes_conversation_turn.py', import.meta.url), 'utf8')
  const match = python.match(/SYSTEM_PROMPT = '''([\s\S]*?)'''/)
  assert.ok(match, 'PYTHON_SYSTEM_PROMPT_NOT_FOUND')
  const pythonPrompt = normalizeLineEndings(match[1])
  const typescriptPrompt = normalizeLineEndings(CONVERSATION_SYSTEM_PROMPT)
  assert.equal(pythonPrompt, typescriptPrompt)
  assert.equal(conversationSha256(pythonPrompt), CONVERSATION_PROMPT_SHA256)
})
