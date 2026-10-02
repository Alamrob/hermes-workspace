import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSupervisedReviewConfig } from '../src/supervised-review-main.js'
import {
  isValidSupervisedReviewGateValue,
  parseSupervisedReviewScope,
  supervisedReviewGateAllowsStaging,
} from '../src/supervised-review-service.js'

function environment(): Record<string, string> {
  return {
    NODE_ENV: 'production', SUPERVISED_REVIEW_HOST: '0.0.0.0', SUPERVISED_REVIEW_PORT: '8788',
    CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_INBOX_ID: '1', CHATWOOT_HANDOFF_TEAM_ID: '1',
    SUPERVISED_REVIEW_STATE_FILE: '/var/lib/proptimiza/supervised-review/state.json',
    CHATWOOT_SUPERVISED_WEBHOOK_SECRET_FILE: '/run/secrets/chatwoot_supervised_webhook_secret',
    CHATWOOT_REVIEWER_TOKEN_FILE: '/run/secrets/chatwoot_reviewer_token',
    CHATWOOT_REVIEWER_MACHINE_SECRET_FILE: '/run/secrets/proptimiza_chatwoot_review_ingress_secret',
    SUPERVISED_REVIEW_GATE_FILE: '/run/controls/supervised-review-enabled',
    SUPERVISED_REVIEW_SCOPE_FILE: '/run/controls/supervised-review-scope.json',
    CHATWOOT_API_BASE: 'http://proptimiza-chatwoot-web-1:3000',
  }
}

test('loads only the pinned review topology and file-backed credentials', () => {
  const config = loadSupervisedReviewConfig(environment())
  assert.equal(config.port, 8788)
  assert.equal(config.handoffTeamId, '1')
  assert.equal(Object.isFrozen(config), true)
})

test('rejects raw credentials, sender credentials and Hermes capabilities', () => {
  for (const patch of [
    { CHATWOOT_REVIEWER_TOKEN: 'forbidden' },
    { CHATWOOT_AGENT_BOT_TOKEN_FILE: '/run/secrets/agent_bot' },
    { OPENCODE_GO_API_KEY_FILE: '/run/secrets/provider' },
    { HERMES_CONVERSATION_SCRIPT: '/app/child.py' },
    { CHATWOOT_API_BASE: 'https://chat.alam.cl' },
    { CHATWOOT_HANDOFF_TEAM_ID: '2' },
    { SUPERVISED_REVIEW_GATE_FILE: '/tmp/enabled' },
    { SUPERVISED_REVIEW_SCOPE_FILE: '/tmp/scope.json' },
  ]) assert.throws(() => loadSupervisedReviewConfig({ ...environment(), ...patch }))
})

test('accepts only a fresh bounded scope for at most ten exact conversations', () => {
  const clock = () => new Date('2026-10-02T12:00:00.000Z')
  const scope = JSON.stringify({
    schema: 'proptimiza-supervised-review-scope.v1', scope_id: 'pilot-1', account_id: '1', inbox_id: '1',
    conversation_ids: ['25', '26'], issued_at: '2026-10-02T11:59:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
  })
  assert.deepEqual(parseSupervisedReviewScope(scope, '1', '1', clock), {
    scope_id: 'pilot-1', conversation_ids: ['25', '26'], expires_at: '2026-10-02T13:00:00.000Z',
  })
  assert.throws(() => parseSupervisedReviewScope(scope.replace('13:00:00', '20:00:00'), '1', '1', clock))
  assert.throws(() => parseSupervisedReviewScope(scope.replace('"25","26"', '"25","25"'), '1', '1', clock))
  assert.throws(() => parseSupervisedReviewScope(scope, '2', '1', clock))
})

test('allows staging only for the exact enabled gate value', () => {
  assert.equal(isValidSupervisedReviewGateValue('enabled'), true)
  assert.equal(isValidSupervisedReviewGateValue('disabled'), true)
  assert.equal(isValidSupervisedReviewGateValue('true'), false)
  assert.equal(supervisedReviewGateAllowsStaging('enabled'), true)
  assert.equal(supervisedReviewGateAllowsStaging('disabled'), false)
})
