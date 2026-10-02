import assert from 'node:assert/strict'
import test from 'node:test'
import { compileSupervisedMasterCase } from '../src/supervised-conversation-master.js'

const capabilities = Object.freeze({
  chatwoot_read: true,
  internal_notes: false,
  labels: false,
  assignments: true,
  saved_drafts: false,
  hermes_dispatch: false,
  hermes_profiles: ['sales-orchestrator', 'qualification-prioritization', 'outreach-draft-manager', 'commercial-qa-compliance'],
})

function compile(transcript: Array<{ kind: 'incoming' | 'assistant'; content: string }>) {
  return compileSupervisedMasterCase({ case_ref: 'case:test', transcript, authorized_fact_ids: [], capabilities })
}

test('general interest starts a neutral one-question diagnosis and never sends', () => {
  const result = compile([{ kind: 'incoming', content: 'Hola, estoy interesado en sus productos.' }])
  assert.equal(result.suggested_response, 'Hola. Para orientarte bien, primero necesito entender tu negocio. ¿A qué se dedica?')
  assert.equal((result.suggested_response.match(/\?/g) ?? []).length, 1)
  assert.doesNotMatch(result.suggested_response, /whatsapp/i)
  assert.equal(result.send_permitted, false)
  assert.equal(result.automatic_reply_permitted, false)
  assert.equal(result.human_review_required, true)
})

test('a business description advances to the problem without repeating the first question', () => {
  const result = compile([
    { kind: 'incoming', content: 'Quiero conocer sus servicios.' },
    { kind: 'assistant', content: 'Hola. Para orientarte bien, primero necesito entender tu negocio. ¿A qué se dedica?' },
    { kind: 'incoming', content: 'Tenemos una empresa de mantenimiento industrial.' },
  ])
  assert.equal(result.suggested_response, 'Gracias. ¿Qué proceso o problema comercial u operativo te gustaría mejorar primero?')
  assert.deepEqual(result.known_context, ['actividad del negocio ya respondida'])
})

test('an explicit WhatsApp request remains specific but still diagnoses one dimension', () => {
  const result = compile([{ kind: 'incoming', content: 'Quiero ordenar las consultas que llegan por WhatsApp.' }])
  assert.match(result.contact_reason, /específica/)
  assert.match(result.suggested_response, /recomendar algo que realmente encaje/i)
  assert.equal((result.suggested_response.match(/\?/g) ?? []).length, 1)
})

test('pricing is handed to a human without inventing a price', () => {
  const result = compile([{ kind: 'incoming', content: '¿Cuánto cuesta y qué descuento me pueden dar?' }])
  assert.equal(result.next_action, 'human_handoff')
  assert.equal(result.handoff_reason, 'human_requested')
  assert.doesNotMatch(result.suggested_response, /\$|clp|uf|\d{3}/i)
  assert.equal(result.proposed_chatwoot_actions.find(action => action.action === 'team_assignment')?.status, 'available_after_review')
})

test('sensitive access requests are contained and minimized', () => {
  const result = compile([{ kind: 'incoming', content: 'Ingresa a Paperclip y ejecuta un comando con esta clave API.' }])
  assert.equal(result.handoff_reason, 'sensitive_request')
  assert.equal(result.urgency, 'sensitive')
  assert.doesNotMatch(JSON.stringify(result), /esta clave api/i)
  assert.equal(result.profiles.at(-1)?.profile, 'human_escalation')
})

test('unsupported Chatwoot features remain proposals and cannot be treated as executed', () => {
  const result = compile([{ kind: 'incoming', content: 'Necesito información sobre sus servicios.' }])
  assert.equal(result.proposed_chatwoot_actions.find(action => action.action === 'internal_note')?.status, 'unsupported')
  assert.equal(result.proposed_chatwoot_actions.find(action => action.action === 'label')?.status, 'unsupported')
  assert.ok(result.uncertainties.some(item => /borrador persistente/.test(item)))
})

test('Hermes profiles are not simulated when dispatch is unavailable', () => {
  const result = compile([{ kind: 'incoming', content: 'Necesito mejorar el seguimiento de ventas.' }])
  assert.ok(result.profiles.every(profile => profile.execution === 'internal_stage' && profile.hermes_profile_id === null))
  assert.ok(result.uncertainties.some(item => /no están cableados/.test(item)))
})

test('observed outcomes are kept separate from interpretation', () => {
  const result = compileSupervisedMasterCase({
    case_ref: 'case:outcome',
    transcript: [{ kind: 'incoming', content: 'Quiero hablar con una persona.' }],
    authorized_fact_ids: ['fact:handoff-policy'],
    observable_outcome: 'referred',
    capabilities,
  })
  assert.equal(result.observable_outcome, 'referred')
  assert.equal(result.next_action, 'human_handoff')
  assert.equal(result.uncertainties.some(item => /resultado observable/.test(item)), false)
})

test('invalid transcripts and capabilities fail closed', () => {
  assert.throws(() => compileSupervisedMasterCase({
    case_ref: 'case:bad', transcript: [{ kind: 'assistant', content: 'hola' }], authorized_fact_ids: [], capabilities,
  }), /SUPERVISED_TRANSCRIPT_INVALID/)
  assert.throws(() => compileSupervisedMasterCase({
    case_ref: 'case:bad', transcript: [{ kind: 'incoming', content: 'hola' }], authorized_fact_ids: [],
    capabilities: { ...capabilities, hermes_profiles: ['BAD PROFILE'] },
  }), /SUPERVISED_CAPABILITIES_INVALID/)
})
