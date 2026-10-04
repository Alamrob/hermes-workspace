import assert from 'node:assert/strict'
import test from 'node:test'
import { compileSupervisedMasterCase } from '../src/supervised-conversation-master.js'
import type { CommercialFact } from '../src/commercial-fact-authority.js'

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
  return compileSupervisedMasterCase({ case_ref: 'case:test', transcript, authorized_facts: [], capabilities })
}

const approvedOffer = Object.freeze({
  id: 'fact:offer:consulting', category: 'offer',
  statement: 'Proptimiza diagnostica y mejora procesos comerciales y operativos.',
  source_ref: 'catalog:commercial:v1', approved_by_role: 'commercial_owner',
  approved_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-03T12:00:00.000Z',
} satisfies CommercialFact)

const approvedIntegration = Object.freeze({
  id: 'fact:integration:chatwoot', category: 'integration',
  statement: 'La integración aprobada conecta Chatwoot con el flujo supervisado de atención.',
  source_ref: 'catalog:commercial:v1', approved_by_role: 'operations',
  approved_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-03T12:00:00.000Z',
} satisfies CommercialFact)

const approvedConversaOffer = Object.freeze({
  id: 'fact:offer:conversa', category: 'offer',
  statement: 'Conversa organiza el flujo supervisado de atención por WhatsApp.',
  source_ref: 'catalog:commercial:v1', approved_by_role: 'commercial_owner',
  approved_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-03T12:00:00.000Z',
} satisfies CommercialFact)

const approvedLaunchOffer = Object.freeze({
  id: 'fact:offer:launch', category: 'offer',
  statement: 'Launch organiza la presencia y la captación digital de un negocio.',
  source_ref: 'catalog:commercial:v1', approved_by_role: 'commercial_owner',
  approved_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-03T12:00:00.000Z',
} satisfies CommercialFact)

const approvedPortfolioOffer = Object.freeze({
  id: 'fact:offer:portfolio', category: 'offer',
  statement: 'Proptimiza presenta cuatro rutas de servicio: Conversa, Launch, Forge y Automatiza.',
  source_ref: 'catalog:commercial:v1', approved_by_role: 'commercial_owner',
  approved_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-03T12:00:00.000Z',
} satisfies CommercialFact)

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
  assert.match(result.contact_reason, /whatsapp/i)
  assert.match(result.suggested_response, /dónde se quiebra hoy el flujo/i)
  assert.equal((result.suggested_response.match(/\?/g) ?? []).length, 1)
})

const routeCases = [
  ['presence', 'Vengo desde launch.proptimiza.com y necesito mejorar mi sitio web.', /presencia o captación/i, /qué está fallando hoy/i],
  ['scope', 'Vi Forge y necesito comparar opciones para definir el alcance.', /alcance o decisión/i, /qué decisión quieres tomar primero/i],
  ['operations', 'Perdemos el seguimiento de ventas y nadie sabe el próximo paso.', /operación o seguimiento/i, /en qué punto se pierde/i],
  ['automation', 'Quiero automatizar una tarea repetitiva e integrar el CRM.', /automatización o integración/i, /qué tarea repetitiva/i],
  ['measurement', 'Necesito un dashboard con métricas para mejorar decisiones.', /medición o mejora/i, /qué decisión necesitas tomar/i],
] as const

for (const [name, message, reason, response] of routeCases) {
  test(`routes ${name} interest to one diagnostic question without fabricating an offer`, () => {
    const result = compile([{ kind: 'incoming', content: message }])
    assert.match(result.contact_reason, reason)
    assert.match(result.suggested_response, response)
    assert.equal((result.suggested_response.match(/\?/g) ?? []).length, 1)
    assert.deepEqual(result.applied_fact_ids, [])
    assert.ok(result.rationale.some(item => /no confirma una oferta ni una capacidad/i.test(item)))
  })
}

test('multiple needs are prioritised before recommending a solution', () => {
  const result = compile([{ kind: 'incoming', content: 'Necesito una landing, automatizar el CRM y ordenar WhatsApp.' }])
  assert.match(result.contact_reason, /más de un frente/i)
  assert.equal(result.suggested_response, 'Veo más de un frente posible. ¿Cuál necesitas resolver primero?')
  assert.equal((result.suggested_response.match(/\?/g) ?? []).length, 1)
  assert.deepEqual(result.applied_fact_ids, [])
})

test('a named product or subdomain is context only until an approved fact matches', () => {
  const ungrounded = compile([{ kind: 'incoming', content: 'Entré a conversa.proptimiza.com. ¿Qué incluye Conversa?' }])
  assert.deepEqual(ungrounded.applied_fact_ids, [])
  assert.equal(ungrounded.next_action, 'human_handoff')
  assert.equal(ungrounded.handoff_reason, 'missing_context')
  assert.match(ungrounded.suggested_response, /no tengo un hecho comercial vigente/i)
  assert.doesNotMatch(ungrounded.suggested_response, /organiza el flujo supervisado/i)

  const grounded = compileSupervisedMasterCase({
    case_ref: 'case:conversa-fact',
    transcript: [{ kind: 'incoming', content: '¿Qué incluye Conversa?' }],
    authorized_facts: [approvedConversaOffer], capabilities,
  })
  assert.deepEqual(grounded.applied_fact_ids, ['fact:offer:conversa'])
  assert.match(grounded.suggested_response, /organiza el flujo supervisado/i)
})

test('a bounded verified entry surface guides diagnosis without granting commercial authority', () => {
  const result = compileSupervisedMasterCase({
    case_ref: 'case:entry-launch',
    transcript: [{ kind: 'incoming', content: 'Hola, quiero información.' }],
    authorized_facts: [],
    public_entry_context: { channel: 'whatsapp', surface: 'launch', acquisition: 'meta_ads' },
    capabilities,
  })
  assert.match(result.contact_reason, /presencia o captación/i)
  assert.match(result.suggested_response, /qué está fallando hoy/i)
  assert.deepEqual(result.applied_fact_ids, [])
  assert.ok(result.known_context.includes('origen operativo verificado: launch/meta_ads/whatsapp'))
  assert.doesNotMatch(result.suggested_response, /incluye|precio|plazo/i)
})

test('public entry context is exact, bounded and part of the evidence fingerprint', () => {
  const base = {
    case_ref: 'case:entry-fingerprint',
    transcript: [{ kind: 'incoming' as const, content: 'Hola.' }],
    authorized_facts: [], capabilities,
  }
  const direct = compileSupervisedMasterCase({ ...base,
    public_entry_context: { channel: 'whatsapp', surface: 'proptimiza_main', acquisition: 'direct' } })
  const paid = compileSupervisedMasterCase({ ...base,
    public_entry_context: { channel: 'whatsapp', surface: 'proptimiza_main', acquisition: 'meta_ads' } })
  assert.notEqual(direct.evidence_fingerprint, paid.evidence_fingerprint)
  assert.throws(() => compileSupervisedMasterCase({ ...base,
    public_entry_context: { channel: 'whatsapp', surface: 'launch', acquisition: 'meta_ads',
      utm_campaign: 'raw-value' } as never,
  }), /SUPERVISED_PUBLIC_ENTRY_CONTEXT_INVALID/)
})

test('a product-specific question resolves one matching fact from a multi-product catalog', () => {
  const result = compileSupervisedMasterCase({
    case_ref: 'case:multi-offer-facts',
    transcript: [{ kind: 'incoming', content: '¿Qué incluye Conversa?' }],
    authorized_facts: [approvedLaunchOffer, approvedConversaOffer], capabilities,
  })
  assert.deepEqual(result.applied_fact_ids, ['fact:offer:conversa'])
  assert.match(result.suggested_response, /flujo supervisado de atención por whatsapp/i)
  assert.doesNotMatch(result.suggested_response, /captación digital/i)
})

test('a named product fact outranks a portfolio summary that also mentions the product', () => {
  const result = compileSupervisedMasterCase({
    case_ref: 'case:portfolio-overlap',
    transcript: [{ kind: 'incoming', content: '¿Qué es Launch?' }],
    authorized_facts: [approvedPortfolioOffer, approvedLaunchOffer, approvedConversaOffer], capabilities,
  })
  assert.deepEqual(result.applied_fact_ids, ['fact:offer:launch'])
  assert.match(result.suggested_response, /presencia y la captación digital/i)
  assert.doesNotMatch(result.suggested_response, /cuatro rutas/i)
})

test('explicit product interest and later route context do not fall back to generic questions', () => {
  const named = compile([{ kind: 'incoming', content: 'Estoy interesado en Launch.' }])
  assert.match(named.contact_reason, /presencia o captación/i)
  assert.match(named.suggested_response, /qué está fallando hoy/i)

  const continued = compile([
    { kind: 'incoming', content: 'Quiero conocer sus servicios.' },
    { kind: 'assistant', content: 'Hola. Para orientarte bien, primero necesito entender tu negocio. ¿A qué se dedica?' },
    { kind: 'incoming', content: 'Somos una clínica y queremos automatizar la agenda.' },
  ])
  assert.match(continued.contact_reason, /automatización o integración/i)
  assert.match(continued.suggested_response, /qué tarea repetitiva/i)
  assert.doesNotMatch(continued.suggested_response, /qué proceso o problema/i)
})

test('current public WhatsApp CTA texts enter the intended supervised route', () => {
  const institutional = compile([{ kind: 'incoming', content: 'Hola Proptimiza. Quiero conversar sobre cómo mejorar la atención y el seguimiento de mi negocio.' }])
  assert.match(institutional.contact_reason, /operación o seguimiento/i)
  assert.match(institutional.suggested_response, /en qué punto se pierde/i)

  const conversa = compile([{ kind: 'incoming', content: 'Hola, quiero evaluar Conversa para ordenar las consultas y cotizaciones de mi negocio.' }])
  assert.match(conversa.contact_reason, /whatsapp o conversa/i)
  assert.match(conversa.suggested_response, /dónde se quiebra hoy el flujo/i)
})

test('the four institutional diagnosis priorities map without claiming a product', () => {
  const cases = [
    ['Captar demanda y mejorar presencia', /presencia o captación/i],
    ['Ordenar la operación y el seguimiento', /operación o seguimiento/i],
    ['Automatizar procesos e integrar sistemas', /automatización o integración/i],
    ['Medir y mejorar decisiones', /medición o mejora/i],
  ] as const
  for (const [message, route] of cases) {
    const result = compile([{ kind: 'incoming', content: message }])
    assert.match(result.contact_reason, route)
    assert.deepEqual(result.applied_fact_ids, [])
    assert.equal((result.suggested_response.match(/\?/g) ?? []).length, 1)
  }
})

test('commercial demand is not a complaint while a legal claim still requires handoff', () => {
  const commercial = compile([{ kind: 'incoming', content: 'Necesito captar demanda y mejorar presencia.' }])
  assert.match(commercial.contact_reason, /presencia o captación/i)
  assert.equal(commercial.next_action, 'human_review')

  const legal = compile([{ kind: 'incoming', content: 'Quiero presentar una demanda judicial contra la empresa.' }])
  assert.equal(legal.contact_reason, 'reclamo o situación delicada')
  assert.equal(legal.next_action, 'human_handoff')
  assert.equal(legal.handoff_reason, 'sensitive_request')
})

test('a direct offer question uses only resolved approved facts and records their ids', () => {
  const result = compileSupervisedMasterCase({
    case_ref: 'case:facts', transcript: [{ kind: 'incoming', content: '¿Qué servicios ofrece Proptimiza?' }],
    authorized_facts: [approvedOffer], capabilities,
  })
  assert.match(result.suggested_response, /diagnostica y mejora procesos comerciales y operativos/i)
  assert.equal((result.suggested_response.match(/\?/g) ?? []).length, 1)
  assert.deepEqual(result.applied_fact_ids, ['fact:offer:consulting'])
  assert.doesNotMatch(JSON.stringify(result), /catalog:commercial:v1/)
})

test('a specific integration question cannot consume an unrelated fact from the same category', () => {
  const result = compileSupervisedMasterCase({
    case_ref: 'case:integration-mismatch',
    transcript: [{ kind: 'incoming', content: '¿Se integra con Salesforce?' }],
    authorized_facts: [approvedIntegration], capabilities,
  })
  assert.deepEqual(result.applied_fact_ids, [])
  assert.doesNotMatch(result.suggested_response, /chatwoot/i)
  assert.equal(result.next_action, 'human_handoff')
  assert.equal(result.handoff_reason, 'missing_context')
  assert.ok(result.uncertainties.some(item => /no hay hechos comerciales autorizados aplicables/i.test(item)))
})

test('public claims about response time, delivery time and scope require current authority', () => {
  const cases = [
    ['En el sitio dice que responden el mismo día. ¿Me responden hoy?', /la disponibilidad/i],
    ['¿La implementación tarda 2 a 3 semanas?', /el plazo/i],
    ['¿Conversa incluye cinco preguntas y tres responsables?', /el alcance/i],
    ['¿Cuánto mejorarán mis ventas? ¿Me garantizan resultados?', /el resultado/i],
  ] as const
  for (const [message, subject] of cases) {
    const result = compile([{ kind: 'incoming', content: message }])
    assert.equal(result.next_action, 'human_handoff')
    assert.equal(result.handoff_reason, 'missing_context')
    assert.match(result.suggested_response, subject)
    assert.deepEqual(result.applied_fact_ids, [])
    assert.doesNotMatch(result.suggested_response, /\b(?:si|confirmado|garantizado)\b/i)
  }
})

test('ordinary business descriptions that use incluye or disponible do not trigger a commercial authority handoff', () => {
  const result = compile([{ kind: 'incoming', content: 'Nuestro equipo incluye ventas y soporte; queremos ordenar el seguimiento y tenemos una persona disponible.' }])
  assert.equal(result.next_action, 'human_review')
  assert.equal(result.handoff_reason, 'none')
  assert.match(result.contact_reason, /operación o seguimiento/i)
})

test('a generic integration question may use the sole approved integration fact', () => {
  const result = compileSupervisedMasterCase({
    case_ref: 'case:integration-generic',
    transcript: [{ kind: 'incoming', content: '¿Qué integraciones tienen?' }],
    authorized_facts: [approvedIntegration], capabilities,
  })
  assert.deepEqual(result.applied_fact_ids, ['fact:integration:chatwoot'])
  assert.match(result.suggested_response, /chatwoot/i)
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

test('verified label capability proposes only the two owned operational labels', () => {
  const review = compileSupervisedMasterCase({
    case_ref: 'case:label-review', transcript: [{ kind: 'incoming', content: 'Quiero conocer sus servicios.' }],
    authorized_facts: [], capabilities: { ...capabilities, labels: true },
  })
  const handoff = compileSupervisedMasterCase({
    case_ref: 'case:label-handoff', transcript: [{ kind: 'incoming', content: 'Quiero hablar con una persona.' }],
    authorized_facts: [], capabilities: { ...capabilities, labels: true },
  })
  assert.deepEqual(review.proposed_chatwoot_actions.find(action => action.action === 'label'), {
    action: 'label', status: 'available_after_review', value: 'proptimiza-supervised-review',
  })
  assert.deepEqual(handoff.proposed_chatwoot_actions.find(action => action.action === 'label'), {
    action: 'label', status: 'available_after_review', value: 'proptimiza-human-handoff',
  })
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
    authorized_facts: [],
    observable_outcome: 'referred',
    capabilities,
  })
  assert.equal(result.observable_outcome, 'referred')
  assert.equal(result.next_action, 'human_handoff')
  assert.equal(result.uncertainties.some(item => /resultado observable/.test(item)), false)
})

test('invalid transcripts and capabilities fail closed', () => {
  assert.throws(() => compileSupervisedMasterCase({
    case_ref: 'case:bad', transcript: [{ kind: 'assistant', content: 'hola' }], authorized_facts: [], capabilities,
  }), /SUPERVISED_TRANSCRIPT_INVALID/)
  assert.throws(() => compileSupervisedMasterCase({
    case_ref: 'case:bad', transcript: [{ kind: 'incoming', content: 'hola' }], authorized_facts: [],
    capabilities: { ...capabilities, hermes_profiles: ['BAD PROFILE'] },
  }), /SUPERVISED_CAPABILITIES_INVALID/)
})
