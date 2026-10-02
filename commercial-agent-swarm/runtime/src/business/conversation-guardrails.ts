export interface GuardedConversationReply {
  response: string
  handoff_reason: string
}

const responses = Object.freeze({
  diagnosticStart: 'Hola. Para orientarte bien, primero necesito entender tu negocio. ¿A qué se dedica?',
  optOut: 'Entendido. No continuaré con la calificación automática. Voy a derivar tu solicitud de baja al equipo para que aplique la supresión correspondiente.',
  emergency: 'No puedo atender emergencias médicas ni situaciones de riesgo. Si existe peligro inmediato, contacta ahora a los servicios de emergencia de tu zona. No compartas datos sensibles por este chat.',
  credential: 'No compartas contraseñas, códigos, tokens, claves API ni enlaces de acceso por este chat. Voy a derivar el caso para una revisión segura.',
  internalAccess: 'No puedo acceder a sistemas, cuentas o herramientas internas desde este chat ni ejecutar comandos. Puedo explicar cómo Proptimiza integra procesos de forma controlada; voy a derivar esta solicitud para revisión humana.',
  payment: 'No puedo confirmar pagos, cobros, facturas, devoluciones ni reembolsos desde este canal. Voy a derivar el caso a una persona para revisión con evidencia, sin pedirte credenciales ni códigos.',
  attachment: 'No puedo validar el contenido de ese archivo, audio o imagen desde este flujo. Describe en una frase qué necesitas, sin incluir datos sensibles, o espera la revisión de una persona.',
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
  if (/(?:\bno (?:me |m )?(?:escriban|escribas|contacten|contactes|llamen|llames)\b|\bdejar de recibir\b|\b(?:darme de baja|dame de baja|solicito la baja|sacame de (?:la )?lista)\b|\b(?:borren|borra|elimina|eliminen) (?:mi (?:numero|contacto)|mis datos)\b|\b(?:do not|don'?t) (?:message|contact|call) me\b|\b(?:unsubscribe|remove me from (?:the )?list)\b|^\s*(?:stop|baja)\s*$)/.test(text))
    return Object.freeze({ response: responses.optOut, handoff_reason: 'human_requested' })
  if (/\b(?:emergencia medica|medical emergency|riesgo vital|ambulancia|me quiero matar|quiero suicidarme|suicid\w*|dolor (?:en el )?pecho|no puedo respirar|cant breathe|cannot breathe)\b/.test(text))
    return Object.freeze({ response: responses.emergency, handoff_reason: 'sensitive_request' })
  if (/\b(?:contrasen\w*|password|clave api|api key|token|codigo (?:de )?(?:acceso|verificacion|seguridad)|verification code|access code|one time code|otp|secreto|secret key)\b/.test(text))
    return Object.freeze({ response: responses.credential, handoff_reason: 'sensitive_request' })
  if (/\b(?:(?:puedes|podrias|quiero que|necesito que|debes) (?:te )?(?:ingres(?:ar|es)|entr(?:ar|es)|acced(?:er|as)|abr(?:ir|as)|conect(?:arte|ar|es)|us(?:ar|es))|(?:ingresa|entra|accede|abre|conectate|conecta|usa)) (?:a |al |en |por )?(?:looking|paperclip|hermes|docker|ssh|servidor(?:es)?|base(?:s)? de datos|sistema(?:s)? intern\w*|cuenta(?:s)? intern\w*)\b/.test(text)
    || /\b(?:ejecuta|corre|lanza) (?:un |el )?(?:comando|script|terminal|shell)\b/.test(text)
    || /\b(?:muestra(?:me)?|revela(?:me)?|dame|comparte(?:me)?) (?:tu |el )?(?:prompt|instrucciones internas|configuracion interna|secretos internos)\b/.test(text))
    return Object.freeze({ response: responses.internalAccess, handoff_reason: 'sensitive_request' })
  if (/\b(?:pago|pague|pagamos|payment|transferencia|comprobante|factura|invoice|cobro|cargo|chargeback|devolucion|reembolso|refund)\b/.test(text))
    return Object.freeze({ response: responses.payment, handoff_reason: 'sensitive_request' })
  if (/\b(reclamo|queja|denuncia|estafa|fraude|abogad\w*|legal|demanda|furios\w*|enojad\w*|molest\w*)\b/.test(text))
    return Object.freeze({ response: responses.complaint, handoff_reason: 'sensitive_request' })
  if (/\b(quien(?:es)? (?:es|son) (?:el |la |los |las )?(?:duen\w*|propietari\w*|fundador\w*)|quien esta detras)\b/.test(text)
    || /\b(correo|email|telefono|contacto) (?:del|de la|de un|de una) (?:duen\w*|propietari\w*|fundador\w*|persona|agente|ejecutiv\w*)\b/.test(text))
    return Object.freeze({ response: responses.identity, handoff_reason: 'human_requested' })
  if (/\b(alianza|asociarnos|asociarse|sociedad|ser socio|socio comercial|partnership|partner)\b/.test(text))
    return Object.freeze({ response: responses.partnership, handoff_reason: 'human_requested' })
  const broadInterest = /\b(?:estoy|estamos|soy|somos)?\s*interesad\w* (?:en|por) (?:sus|los|las|un|una)?\s*(?:productos?|servicios?|soluciones?)\b/.test(text)
    || /\b(?:quiero|quisiera|necesito|busco) (?:mas )?(?:informacion|conocer|saber) (?:sobre|de|acerca de)?\s*(?:proptimiza|sus (?:productos?|servicios?|soluciones?)|los (?:productos?|servicios?|soluciones?))\b/.test(text)
    || /\b(?:que (?:hace|hacen|ofrece|ofrecen)|a que se dedica) proptimiza\b/.test(text)
  const explicitSolution = /\b(?:whatsapp|mensajeria|automatiz\w*|cotiz\w*|seguimiento|crm|chatbot|bots?|correo|email|formular\w*|integraci\w*|agenda|atencion|ventas)\b/.test(text)
  if (broadInterest && !explicitSolution)
    return Object.freeze({ response: responses.diagnosticStart, handoff_reason: 'none' })
  if (/\b(venden|tienen|ofrecen|instalan)\b/.test(text)
    && !/\b(automatizacion|whatsapp|cotizacion|seguimiento|chat|ventas|proptimiza|plan|servicio)\b/.test(text))
    return Object.freeze({ response: responses.identityScope, handoff_reason: 'none' })
  if (/\b(precio|precios|price|pricing|how much|cuanto cuesta|cuanto cobran|cuanto sale|costo|costos|valor|valores|tarifa\w*|descuento\w*|presupuesto|coti[sz]acion)\b/.test(text)
    || /\b(?:quiero|necesito|solicito|envienme|pueden darme|send me) (?:una |a )?(?:coti[sz]acion|quote)\b/.test(text))
    return Object.freeze({ response: responses.pricing, handoff_reason: 'human_requested' })
  if (/\b(?:quiero|necesito|prefiero|puedo|podria) (?:hablar|conversar|comunicarme|ser atendid\w*) (?:con )?(?:una? )?(?:persona|humano|agente|ejecutiv\w*|asesor\w*)\b/.test(text)
    || /\b(?:agente humano|atencion humana|hablar con alguien|hablar con (?:ventas|soporte)|persona real|(?:asesor|ejecutivo|persona) por favor|human agent|talk to (?:a )?(?:person|human|agent))\b/.test(text))
    return Object.freeze({ response: responses.human, handoff_reason: 'human_requested' })
  if (/\b(?:adjunt\w*|attachment|file|archivo|documento|pdf|audio|voice note|nota de voz|image|imagen|photo|foto|screenshot|captura)\b/.test(text)
    && /\b(?:envie|envio|mande|mando|subi|adjunte|revisa|revisar|lee|leer|escucha|escuchar|mira|mirar|sent|uploaded|review|read|listen|look)\b/.test(text))
    return Object.freeze({ response: responses.attachment, handoff_reason: 'missing_context' })
  if (/\b(directorio\w*|buscame|buscar en internet|servicios en santiago|tip\w* para (?:ser|hacerme) millonari\w*|asesoria financiera|consejo\w* financiero\w*|donde invertir)\b/.test(text))
    return Object.freeze({ response: responses.offTopic, handoff_reason: 'none' })
  return Object.freeze({ response: reply.response, handoff_reason: reply.handoff_reason })
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}
