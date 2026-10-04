# Recorridos públicos para atención supervisada

## Propósito

Este mapa ayuda al agente maestro a diagnosticar consultas originadas en `proptimiza.com` y sus
subdominios públicos. No concede autoridad para enviar mensajes ni convierte el contenido web en
hechos comerciales aprobados. Cada borrador requiere revisión humana.

## Principios de conversación

- Una consulta general empieza por el negocio y luego por el problema prioritario.
- Una necesidad explícita activa una sola pregunta pertinente, no un formulario completo.
- Una URL, anuncio o nombre de producto solo orienta el diagnóstico. No confirma alcance, precio,
  plazo, integración, disponibilidad ni resultado.
- Una recomendación concreta exige hechos vigentes del catálogo autorizado y evidencia suficiente
  del caso.
- Si aparecen varios frentes, se pregunta cuál necesita resolver primero.
- Si la persona pide una cotización, un descuento, una excepción o atención humana, se deriva con
  un resumen mínimo.

## Mapa de rutas

| Ruta interna | Señales del contacto | Primera pregunta permitida | Próximo paso posible |
| --- | --- | --- | --- |
| Presencia y captación | sitio, landing, campañas, publicidad, demanda, Launch | ¿Qué está fallando hoy: atraer demanda, explicar la oferta o medir qué convierte? | continuar diagnóstico, recomendar con hechos o derivar |
| Alcance y decisión | comparar, alcance, propuesta, paquete, Forge | ¿Qué decisión quieres tomar primero: comparar opciones, definir prioridades o preparar una propuesta? | aclarar restricciones y derivar si solicita cotización |
| Operación y seguimiento | responsables, estados, pipeline, próximo paso | ¿En qué punto se pierde hoy el seguimiento: responsable, estado o próximo paso? | identificar quiebre y participantes |
| Automatización e integraciones | tareas repetitivas, CRM, chatbot, Automatiza | ¿Qué tarea repetitiva te gustaría resolver primero? | identificar excepciones y validar integraciones autorizadas |
| Medición y mejora | métricas, analítica, tablero, indicadores | ¿Qué decisión necesitas tomar y hoy no puedes por falta de datos claros? | identificar fuentes y criterio de éxito |
| WhatsApp y Conversa | WhatsApp, mensajería, Chatwoot, Conversa | ¿Dónde se quiebra hoy el flujo: respuesta, calificación, asignación o seguimiento? | confirmar volumen, responsables y control humano |
| Necesidad múltiple | señales de dos o más rutas | ¿Cuál necesitas resolver primero? | retomar una ruta sin mezclar propuestas |

## Derivación humana obligatoria

- precios, descuentos, cotizaciones, pagos, cobros y devoluciones;
- reclamos delicados, asuntos legales, privacidad y solicitudes de baja;
- credenciales, códigos, accesos internos o ejecución de acciones;
- alianzas, excepciones y compromisos no presentes en hechos aprobados;
- petición expresa de una persona;
- información insuficiente cuando una respuesta podría crear una promesa comercial.

## Protocolo del equipo en Chatwoot

1. Leer el último mensaje y el contexto ya respondido. No volver a preguntar por el negocio si la
   persona ya lo explicó.
2. Elegir una sola ruta y una sola pregunta del mapa. Si hay dos o más rutas, preguntar por la
   prioridad.
3. Revisar el borrador del agente contra los hechos autorizados. El texto público del sitio no
   reemplaza esa revisión.
4. Corregir tono, exactitud y continuidad antes de responder manualmente.
5. Usar `proptimiza-supervised-review` para borradores en revisión y
   `proptimiza-human-handoff` cuando el caso exige una persona. No crear otras etiquetas operativas
   desde este flujo sin verificar su propiedad.
6. Al derivar, dejar un resumen mínimo con motivo, objetivo, contexto confirmado, dato faltante y
   siguiente acción. No copiar el historial completo.
7. Registrar un resultado observable cuando exista: resuelto, venta, seguimiento, abandono,
   derivación o pendiente. No inferir una venta a partir de una respuesta positiva.

## Ejemplos de primera respuesta

Consulta general:

> Hola. Para orientarte bien, primero necesito entender tu negocio. ¿A qué se dedica?

Necesidad de presencia:

> Entiendo que buscas mejorar la presencia o captación. ¿Qué está fallando hoy: atraer demanda,
> explicar la oferta o medir qué convierte?

Necesidad de WhatsApp:

> Entiendo que el foco está en WhatsApp. ¿Dónde se quiebra hoy el flujo: respuesta, calificación,
> asignación o seguimiento?

Necesidades mezcladas:

> Veo más de un frente posible. ¿Cuál necesitas resolver primero?

Solicitud de precio sin un hecho vigente:

> Para entregarte una cotización real, una persona debe revisar el alcance. Voy a derivar tu
> consulta al equipo comercial; no hay un precio aprobado que este canal pueda prometer.

## Control de calidad antes de responder

- La respuesta contiene como máximo una pregunta nueva.
- La pregunta usa información ya entregada y mueve el caso a un siguiente paso concreto.
- Cualquier afirmación de alcance, precio, plazo, integración o resultado tiene un hecho autorizado.
- No se solicita contraseña, token, código, documento o dato personal innecesario.
- No se afirma que una nota, asignación, cotización o acción ya fue ejecutada.
- El traspaso humano incluye un resumen y evita que la persona repita su historia.

## Fuentes y conflicto pendiente

La revisión pública del 4 de octubre de 2026 observó contenido en `proptimiza.com`,
`conversa.proptimiza.com`, `launch.proptimiza.com`, `forge.proptimiza.com` y
`automatiza.proptimiza.com`. Estas observaciones sirven para probar cobertura temática, no como
fuente del runtime.

El catálogo local histórico `catalog.v0.1.0-candidate.json` está marcado como candidato no aprobado
y presenta precios o paquetes distintos de la publicación actual. No debe activarse ni utilizarse
para responder. La persona responsable comercial debe aprobar un catálogo nuevo, con vigencia,
fuentes y reglas de precedencia explícitas.

## Estado del piloto

La ruta es apta para pruebas locales y revisión humana. No está autorizada para responder en vivo.
La puesta en marcha requiere integraciones verificadas, catálogo comercial aprobado, muestra
supervisada con resultados observables, auditoría y una aprobación consumible de despliegue.
