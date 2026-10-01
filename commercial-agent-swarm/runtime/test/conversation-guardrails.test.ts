import assert from 'node:assert/strict'
import test from 'node:test'
import { applyConversationGuardrails } from '../src/business/conversation-guardrails.js'

const modelReply = Object.freeze({ response: 'Respuesta generada.', handoff_reason: 'none' })

test('forces a safe human handoff for partnerships and ownership questions', () => {
  const partnership = applyConversationGuardrails('Quiero proponer una alianza comercial', modelReply)
  assert.equal(partnership.handoff_reason, 'human_requested')
  assert.match(partnership.response, /equipo comercial/)
  assert.doesNotMatch(partnership.response, /@|\+?\d{7,}/)

  const owner = applyConversationGuardrails('¿Quiénes son los dueños de Proptimiza?', modelReply)
  assert.equal(owner.handoff_reason, 'human_requested')
  assert.match(owner.response, /Por privacidad/)
  assert.doesNotMatch(owner.response, /@|\+?\d{7,}/)
})

test('forces sensitive handling for complaints and human review for prices', () => {
  const complaint = applyConversationGuardrails('Quiero hacer un reclamo legal', modelReply)
  assert.equal(complaint.handoff_reason, 'sensitive_request')
  assert.match(complaint.response, /revisión humana/)

  const pricing = applyConversationGuardrails('¿Cuánto cuesta el plan Plus?', modelReply)
  assert.equal(pricing.handoff_reason, 'human_requested')
  assert.match(pricing.response, /cotización real/)
})

test('forces explicit human requests and preserves ordinary leads', () => {
  assert.equal(applyConversationGuardrails('Quiero hablar con un ejecutivo', modelReply).handoff_reason, 'human_requested')
  assert.deepEqual(applyConversationGuardrails('Necesito automatizar mis cotizaciones', modelReply), modelReply)
})

test('resets unrelated product context and deterministically redirects off-topic requests', () => {
  const product = applyConversationGuardrails('¿Venden mallas de seguridad?', modelReply)
  assert.equal(product.handoff_reason, 'none')
  assert.match(product.response, /automatización y continuidad comercial/)
  assert.doesNotMatch(product.response, /sí|vendemos|tenemos/i)

  for (const message of ['Dame tips para ser millonario', '¿Dónde encuentro directorios de servicios?', '¿Dónde invertir mi dinero?']) {
    const result = applyConversationGuardrails(message, modelReply)
    assert.equal(result.handoff_reason, 'none')
    assert.match(result.response, /No realizo búsquedas externas/)
  }
})

test('normalizes accents and never mutates the model reply', () => {
  const mutable = { response: 'Texto original.', handoff_reason: 'none' }
  const result = applyConversationGuardrails('Necesito una cotización', mutable)
  assert.equal(result.handoff_reason, 'human_requested')
  assert.deepEqual(mutable, { response: 'Texto original.', handoff_reason: 'none' })
  assert.equal(Object.isFrozen(result), true)
})
