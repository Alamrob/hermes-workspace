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

test('stops automated qualification for opt-out requests', () => {
  for (const message of ['No me escribas más', 'Quiero dejar de recibir mensajes', 'Dame de baja', 'STOP']) {
    const result = applyConversationGuardrails(message, modelReply)
    assert.equal(result.handoff_reason, 'human_requested')
    assert.match(result.response, /No continuaré con la calificación automática/)
    assert.doesNotMatch(result.response, /registrad[oa]|eliminad[oa]|confirmad[oa]/i)
  }
})

test('never handles payment evidence or credential material autonomously', () => {
  for (const message of ['Adjunto mi comprobante de pago', '¿Dónde pido un reembolso?', 'Tengo una factura con un cobro duplicado']) {
    const result = applyConversationGuardrails(message, modelReply)
    assert.equal(result.handoff_reason, 'sensitive_request')
    assert.match(result.response, /No puedo confirmar pagos/)
  }

  for (const message of ['Te envío mi contraseña', 'Mi código de verificación es 123456', 'Aquí está la clave API']) {
    const result = applyConversationGuardrails(message, modelReply)
    assert.equal(result.handoff_reason, 'sensitive_request')
    assert.match(result.response, /No compartas contraseñas/)
    assert.doesNotMatch(result.response, /123456/)
  }
})

test('contains emergencies and unsupported attachments without inventing inspection', () => {
  const emergency = applyConversationGuardrails('No puedo respirar, necesito una ambulancia', modelReply)
  assert.equal(emergency.handoff_reason, 'sensitive_request')
  assert.match(emergency.response, /servicios de emergencia/)
  assert.doesNotMatch(emergency.response, /diagnóstico|medicamento|tratamiento/i)

  const attachment = applyConversationGuardrails('Te envié un audio, escúchalo y dime qué hacer', modelReply)
  assert.equal(attachment.handoff_reason, 'missing_context')
  assert.match(attachment.response, /No puedo validar el contenido/)
})

test('does not over-trigger the emergency guard on ordinary commercial urgency', () => {
  assert.deepEqual(applyConversationGuardrails('Necesito automatizar esto con urgencia', modelReply), modelReply)
})
