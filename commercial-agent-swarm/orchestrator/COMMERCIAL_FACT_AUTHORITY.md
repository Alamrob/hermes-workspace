# Autoridad de hechos comerciales del piloto

El agente maestro no debe convertir el historial de una conversación, una respuesta generada o una
configuración de Hermes en fuente comercial. Los únicos hechos que puede usar para resolver una
consulta deben provenir de un catálogo `proptimiza-commercial-fact-catalog.v1` activo, vigente y
aprobado por rol.

El catálogo separa ocho categorías: identidad, oferta, capacidad, integración, política, horario,
precio y resultado. Cada entrada tiene un identificador estable, una declaración acotada, una
referencia opaca a la fuente, el rol aprobador y su propia expiración. No incluye nombres de personas,
tokens, URLs con credenciales ni contenido de conversaciones.

El runtime falla cerrado cuando el catálogo está pendiente, vencido, incompleto, contiene campos no
reconocidos o no resuelve todos los identificadores solicitados. No existe resolución parcial. El
contexto destinado a una futura invocación supervisada está limitado a 24 hechos y 12.000 bytes.
El alcance temporal `proptimiza-supervised-review-scope.v3` enumera las conversaciones autorizadas, su
contexto de entrada público acotado y los identificadores de hechos autorizados. El contexto solo puede
usar enumeraciones de superficie, adquisición y canal; no admite URL, UTM ni texto libre y no concede
autoridad comercial. El alcance fija el SHA-256 exacto del catálogo. Si la lista está vacía el hash debe
ser `null`; si contiene hechos,
el reviewer vuelve a leer el archivo root:grupo `0440`, valida vigencia y hash y resuelve el conjunto
completo antes de abrir el snapshot. El agente maestro recibe objetos ya resueltos, nunca un ID suelto.
Solo registra en la nota privada los identificadores efectivamente aplicados; no expone referencias de
fuente, aprobadores ni el catálogo.

## Baseline público aprobado localmente

El catálogo `commercial-agent-swarm/config/commercial-fact-catalog.public-site.v1.json` contiene solo
declaraciones de alto nivel comprobadas en el sitio principal y aprobadas por el propietario comercial
en la autorización de implementación del 4 de octubre de 2026. Su activación en producción sigue
requiriendo el control pack exacto, su SHA-256 y el proceso de publicación/despliegue. No autoriza
enviar mensajes ni habilitar respuestas automáticas.

## Reglas pendientes

Hasta que sus fuentes sean aprobadas y versionadas, permanecen sin autorización:

- alcance detallado de servicios más allá del baseline público;
- precios, descuentos y condiciones de cotización;
- horarios y SLA;
- integraciones disponibles y sus límites;
- disponibilidad y capacidad de implementación;
- políticas comerciales, cancelación, soporte y privacidad distintas de la declaración acotada del
  diagnóstico del sitio principal;
- resultados, métricas, testimonios y garantías.

El piloto solo puede usar los IDs exactos incluidos en un alcance v3 autorizado y ligado al SHA-256
exacto del catálogo. Un alcance vacío conserva `authorized_fact_ids=[]` y
`commercial_fact_catalog_sha256=null`. Precio, cotización, excepciones y cualquier afirmación no
respaldada se derivan. Este módulo no habilita el piloto, no envía mensajes y no concede capacidades a
Hermes.
