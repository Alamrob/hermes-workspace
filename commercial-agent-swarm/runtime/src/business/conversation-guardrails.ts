export interface GuardedConversationReply {
  response: string
  handoff_reason: string
}

const responses = Object.freeze({
  complaint: 'Lamento la situación. Voy a derivar tu reclamo para revisión humana. Por favor no compartas contraseñas, códigos ni otros datos sensibles por este chat.',
  identity: 'Por privacidad, este canal no identifica ni comparte datos personales de propietarios o integrantes del equipo. Voy a derivar tu consulta al equipo de Proptimiza para que una persona pueda orientarte.',
  partnership: 'Gracias por proponer una alianza. Voy a derivar tu interés al equipo comercial de Proptimiza para que una persona lo evalúe contigo; no compartiré datos personales por este canal.',
  identityScope: 'Proptimiza se especializa en automatización y continuidad comercial; este canal no confirma como propios productos mencionados en conversaciones anteriores. Si buscas ordenar consultas, cotizaciones o seguimiento, puedo orientarte.',
  pricing: 'Para entregarte una cotización real, una persona debe revisar el alcance. Voy a derivar tu consulta al equipo comercial; no hay un precio aprobado que este canal pueda prometer.',
  human: 'Claro. Voy a derivar la conversación al equipo de Proptimiza para que continúe una persona.',
  offTopic: 'Este canal se limita a la automatización y continuidad comercial de Proptimiza. No realizo búsquedas externas, directorios ni asesoría personal o financiera; si quieres, cuéntame qué proceso comercial deseas ordenar.',
})

/**
 * Host-owned controls for intents where prose generation is not allowed to
 * decide whether a human handoff occurs. This never broadens delivery scope.
 */
export function applyConversationGuardrails(
  latestText: string,
  reply: GuardedConversationReply,
): Readonly<GuardedConversationReply> {
  const text = normalize(latestText)
  if (/\b(reclamo|queja|denuncia|estafa|fraude|abogad\w*|legal|demanda|furios\w*|enojad\w*|molest\w*)\b/.test(text))
    return Object.freeze({ response: responses.complaint, handoff_reason: 'sensitive_request' })
  if (/\b(quien(?:es)? (?:es|son) (?:el |la |los |las )?(?:duen\w*|propietari\w*|fundador\w*)|quien esta detras)\b/.test(text)
    || /\b(correo|email|telefono|contacto) (?:del|de la|de un|de una) (?:duen\w*|propietari\w*|fundador\w*|persona|agente|ejecutiv\w*)\b/.test(text))
    return Object.freeze({ response: responses.identity, handoff_reason: 'human_requested' })
  if (/\b(alianza|asociarnos|asociarse|sociedad|ser socio|socio comercial|partnership|partner)\b/.test(text))
    return Object.freeze({ response: responses.partnership, handoff_reason: 'human_requested' })
  if (/\b(venden|tienen|ofrecen|instalan)\b/.test(text)
    && !/\b(automatizacion|whatsapp|cotizacion|seguimiento|chat|ventas|proptimiza|plan|servicio)\b/.test(text))
    return Object.freeze({ response: responses.identityScope, handoff_reason: 'none' })
  if (/\b(precio|precios|cuanto cuesta|cuanto cobran|costo|costos|valor|valores|tarifa\w*|descuento\w*)\b/.test(text)
    || /\b(?:quiero|necesito|solicito|envienme|pueden darme) (?:una )?cotizacion\b/.test(text))
    return Object.freeze({ response: responses.pricing, handoff_reason: 'human_requested' })
  if (/\b(?:quiero|necesito|prefiero|puedo|podria) (?:hablar|conversar|comunicarme|ser atendid\w*) (?:con )?(?:una? )?(?:persona|humano|agente|ejecutiv\w*|asesor\w*)\b/.test(text)
    || /\b(?:agente humano|atencion humana|hablar con alguien)\b/.test(text))
    return Object.freeze({ response: responses.human, handoff_reason: 'human_requested' })
  if (/\b(directorio\w*|buscame|buscar en internet|servicios en santiago|tip\w* para (?:ser|hacerme) millonari\w*|asesoria financiera|consejo\w* financiero\w*|donde invertir)\b/.test(text))
    return Object.freeze({ response: responses.offTopic, handoff_reason: 'none' })
  return Object.freeze({ response: reply.response, handoff_reason: reply.handoff_reason })
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}
