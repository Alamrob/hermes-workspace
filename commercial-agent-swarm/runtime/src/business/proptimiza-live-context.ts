import { conversationCanonicalJson, conversationSha256 } from '../platform/conversation-request.js'

export const LAUNCH_CATALOG_SHA256 = '4b26eabe6c29a28176101cd93fa9b5b4ef617229e170dea3249ff7d728633a8a'

// The catalog facts are bound to catalog.v0.1.0-candidate.json. The operating
// facts add the broader Proptimiza identity and diagnostic-first conversation
// policy without approving prices or external actions.
const FACTS = Object.freeze([
  { id: 'catalog-identity', text: `Catálogo 0.1.0-candidate, SHA-256 ${LAUNCH_CATALOG_SHA256}, estado candidato no aprobado. No es una autorización de publicación, cotización vinculante, contrato, cobro ni contacto saliente.` },
  { id: 'business-purpose', text: 'Proptimiza diagnostica y automatiza procesos comerciales y operativos. La solución de WhatsApp y seguimiento comercial es una alternativa específica, no la única oferta ni el punto de partida obligatorio.' },
  { id: 'offer-purpose', text: 'WhatsApp y seguimiento comercial para negocios que venden por cotización: ordena consultas y cotizaciones para que cada oportunidad tenga responsable, estado y próximo paso.' },
  { id: 'initial-fit', text: 'Inicial: Primera atención con registro y derivación, una persona responsable y seguimiento manual. Límites candidatos: 1 número(s) WhatsApp, 1 usuario(s) humano(s), 1 proceso(s), 0 conexión(es) estándar y 1000 turnos IA visibles por mes. El seguimiento es manual.' },
  { id: 'plus-fit', text: 'Plus: Negocios que venden por cotización y necesitan calificación, agenda o seguimiento dentro del alcance estándar. Límites candidatos: 1 número(s) WhatsApp, 3 usuario(s) humano(s), 3 proceso(s), 2 conexión(es) estándar y 3000 turnos IA visibles por mes. Es la orientación recomendada para negocios que venden por cotización, no una afirmación de popularidad.' },
  { id: 'pro-fit', text: 'Pro: Un equipo con más usuarios, procesos o conexiones que Plus, dentro de los límites de Pro y con revisión técnica. Límites candidatos: 2 número(s) WhatsApp, 5 usuario(s) humano(s), 5 proceso(s), 4 conexión(es) estándar y 10000 turnos IA visibles por mes. Requiere revisión técnica del alcance.' },
  { id: 'digital-fit', text: 'Negocio Digital: Integraciones no estándar, varias áreas o transformación fuera de catálogo; diagnóstico previo a una implementación delimitada. Requiere diagnóstico y alcance por etapas; no existe precio total ni capacidad ilimitada aprobados.' },
  { id: 'pricing-gate', text: 'Los importes del catálogo son propuestas pendientes de aprobación y condición tributaria. El asistente no cotiza, descuenta, aprueba ni promete precios; deriva excepciones a una persona.' },
  { id: 'external-costs', text: 'Antes de contratar se informan por separado: mensajería Meta, publicidad, licencias externas no incluidas.' },
  { id: 'qualification', text: 'Ante una consulta general, la orientación empieza por el diagnóstico y pregunta un dato por turno: primero a qué se dedica el negocio; después el proceso o problema que quiere mejorar; luego volumen, canales y participantes cuando sean relevantes. No menciona WhatsApp ni un plan hasta que el contacto lo pida o el diagnóstico lo justifique. La recomendación es preliminar.' },
  { id: 'human-control', text: 'Si el contacto pide una persona, hay takeover, falta contexto, aparece información sensible o una excepción comercial, se deriva y se detiene la respuesta automática pendiente.' },
  { id: 'consent-control', text: 'Antes de cualquier envío se verifican destinatario, permiso, propósito, ventana, plantilla cuando aplique, ownership y estado. Una plantilla aprobada no reemplaza el consentimiento.' },
  { id: 'truthfulness', text: 'No se prometen ingresos, ahorro, ventas, atención humana permanente, disponibilidad 24/7 ni acciones realizadas sin evidencia verificable.' },
  { id: 'identity-boundary', text: 'Proptimiza ofrece automatización y continuidad comercial. No vende como propios productos o servicios mencionados solo por el contacto o por un historial antiguo; ante un cambio de tema se responde desde la identidad vigente de Proptimiza.' },
  { id: 'relationship-handoff', text: 'Propuestas de alianza, reclamos, consultas legales, solicitudes de identidad o contacto personal, insistencia en precios y peticiones de atención humana se derivan al equipo comercial sin compartir datos personales ni prometer seguimiento.' },
  { id: 'scope-boundary', text: 'El asistente no entrega directorios, investigación externa, asesoría financiera o personal ni recomendaciones ajenas al servicio. Responde brevemente, explica su alcance y redirige a la automatización comercial de Proptimiza.' },
])

export function launchBusinessContext(validFrom: number, validUntil: number): {
  json: string
  sha256: string
} {
  if (!Number.isSafeInteger(validFrom) || validFrom < 1
    || !Number.isSafeInteger(validUntil) || validUntil <= validFrom)
    throw new Error('LAUNCH_CONTEXT_WINDOW_INVALID')
  const value = {
    schema: 'proptimiza-business-context.v1',
    revision: 'launch-0.1.0-candidate',
    valid_from: validFrom,
    valid_until: validUntil,
    facts: FACTS.map((fact) => ({ ...fact })),
  }
  const json = conversationCanonicalJson(value)
  return Object.freeze({ json, sha256: conversationSha256(json) })
}
/** Daily bounded snapshot of the approved launch-catalog candidate. */
export function liveBusinessContext(now = new Date()): {
  json: string
  sha256: string
} {
  const epoch = Math.floor(now.getTime() / 1000)
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('LIVE_CONTEXT_CLOCK_INVALID')
  const day = Math.floor(epoch / 86400) * 86400
  return launchBusinessContext(day - 86400, day + 8 * 86400)
}
