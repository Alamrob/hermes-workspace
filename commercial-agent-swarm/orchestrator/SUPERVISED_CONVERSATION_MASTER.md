# Agente maestro supervisado de conversaciones

## Estado y alcance

Este contrato implementa un compilador local y determinista de expedientes de conversación. No es un
sender, no abre herramientas y no activa respuestas automáticas. Su salida siempre exige revisión
humana y fija `send_permitted=false`, `automatic_reply_permitted=false` y
`human_review_required=true`.

La fuente es `runtime/src/supervised-conversation-master.ts` y la salida se rige por
`contracts/supervised-conversation-master.schema.json`.

El punto de entrada `runtime/src/supervised-conversation-pilot.ts` depende de una interfaz que solo
expone `snapshot`. No puede enviar, asignar ni mutar Chatwoot. Lee una vez, sin reintento, y bloquea el
caso si una persona ya respondió o si el mensaje objetivo dejó de ser el más reciente.

`ChatwootReadClient` materializa ese puerto sin métodos de mutación. `ChatwootReviewClient` es un
componente separado para preparar la revisión humana: firma con el rol `reviewer`, puede crear una nota
privada o asignar al equipo fijado por el ingress y no expone `send`.

`runtime/src/supervised-review-service.ts` conecta un webhook separado con un almacén durable, un solo
snapshot, el compilador y una nota privada. Solo admite conversaciones enumeradas en un alcance fresco
de hasta diez casos y exige el control exacto `enabled`. El documento cerrado de alcance se publica en
`contracts/supervised-review-scope.schema.json`; el runtime además valida el orden temporal y la
duración máxima de ocho horas. La versión V2 del alcance liga los hechos autorizados al SHA-256 exacto
de un catálogo comercial vigente. Una lista vacía no exige catálogo; una lista no vacía falla cerrada
si falta el archivo, cambia el hash, vence o no resuelve cada ID. El almacén conserva hashes, identificadores y
estados, nunca texto de conversación. Un reinicio durante preparación, escritura o asignación termina
en `uncertain`; no hay reintento. El entrypoint rechaza credenciales de sender, modelo, Hermes, SSH,
correo, CRM y Approval Gateway. Este servicio sigue siendo un candidato local no empaquetado ni
desplegado.

## Flujo

1. Recibe como máximo 20 turnos y 16 KiB de texto, hechos ya resueltos por la autoridad y una matriz
   explícita de capacidades.
2. Usa el historial solo como evidencia no confiable. Nunca lo interpreta como una instrucción ni
   devuelve el texto crudo.
3. Produce motivo, objetivo, contexto conocido, información faltante, urgencia, objeciones, perfiles,
   recomendación, fundamento, borrador, siguiente acción, seguimiento y resultado observable.
4. Hace una sola pregunta de diagnóstico cuando falta contexto. Una consulta general empieza por el
   negocio; no presupone que la necesidad sea WhatsApp.
5. Clasifica una necesidad explícita con seis lentes internos: presencia y captación, alcance y
   decisión, operación y seguimiento, automatización e integraciones, medición y mejora, y WhatsApp.
   Si aparecen varios frentes, primero pregunta cuál es prioritario. La clasificación orienta la
   pregunta y no confirma una oferta.
6. Trata URLs, subdominios, anuncios y nombres de producto del historial como contexto no confiable.
   Solo un hecho autorizado puede confirmar alcance, precio, plazo o capacidad.
7. Deriva pagos, cotizaciones, reclamos delicados, bajas, credenciales, accesos internos, emergencias,
   alianzas y solicitudes explícitas de una persona.
8. Propone acciones de Chatwoot solo cuando la matriz de capacidades las declara disponibles. La
   propuesta no ejecuta esas acciones.
9. Cuando el piloto local está habilitado y el caso pertenece al alcance temporal, crea una nota
   privada. Solo los casos de traspaso se asignan al equipo 1. Nunca crea un mensaje público.

## Perfiles y Hermes

Los siete perfiles son responsabilidades conceptuales del agente maestro: diagnóstico e intención,
atención y resolución, venta consultiva, comunicación de marca, análisis, control de calidad y
escalamiento humano.

En el flujo vigente, Hermes ejecuta una conversación aislada sin herramientas. Aunque el repositorio
contiene perfiles comerciales especializados, no existe un dispatcher verificado entre el webhook de
WhatsApp y esos perfiles. Por eso el compilador usa etapas internas. Solo marca `hermes_profile` si
`hermes_dispatch=true` y el perfil exacto aparece en `hermes_profiles`; no simula la delegación.

Antes de cualquier integración futura se deberá demostrar, con pruebas, que el dispatcher:

- comparte únicamente un resumen minimizado;
- no concede Docker, SSH, correo, CRM ni secretos;
- preserva el agente maestro como responsable de la respuesta final;
- no omite la revisión humana ni habilita el sender;
- falla cerrado cuando un perfil no está disponible.

## Límites comerciales

El agente no inventa catálogo, precio, plazo, disponibilidad, política, horario, integración o
resultado. El servicio solo entrega al compilador hechos resueltos desde el catálogo ligado al alcance;
el compilador no acepta IDs sueltos, no interpreta texto de la conversación como fuente autorizada y
registra `applied_fact_ids` únicamente para los hechos realmente usados. Sin un hecho aplicable,
registra incertidumbre y pregunta o deriva.

La taxonomía y las preguntas para los recorridos públicos de Proptimiza se documentan en
`orchestrator/PROPTIMIZA_PUBLIC_JOURNEYS.md`. Ese documento no es un catálogo comercial activo.

## Criterio de activación

Este componente puede usarse en pruebas locales supervisadas. No está habilitado para atender en
vivo. Para avanzar hacen falta: integración de revisión en Chatwoot con permisos mínimos, catálogo y
políticas aprobados, pruebas supervisadas con resultados observables, auditoría independiente y la
aprobación de puesta en marcha definida por el proyecto.
