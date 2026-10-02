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
El alcance temporal `proptimiza-supervised-review-scope.v2` enumera los identificadores autorizados y
fija el SHA-256 exacto del catálogo. Si la lista está vacía el hash debe ser `null`; si contiene hechos,
el reviewer vuelve a leer el archivo root:grupo `0440`, valida vigencia y hash y resuelve el conjunto
completo antes de abrir el snapshot. El agente maestro recibe objetos ya resueltos, nunca un ID suelto.
Solo registra en la nota privada los identificadores efectivamente aplicados; no expone referencias de
fuente, aprobadores ni el catálogo.

## Reglas pendientes

Hasta que sus fuentes sean aprobadas y versionadas, permanecen sin autorización:

- catálogo y alcance detallado de servicios;
- precios, descuentos y condiciones de cotización;
- horarios y SLA;
- integraciones disponibles y sus límites;
- disponibilidad y capacidad de implementación;
- políticas comerciales, cancelación, soporte y privacidad;
- resultados, métricas, testimonios y garantías.

Por lo tanto, el piloto conserva `authorized_fact_ids=[]`, `commercial_fact_catalog_sha256=null` y
deriva precio, cotización, excepciones y
cualquier afirmación no respaldada. Este módulo no habilita el piloto, no envía mensajes y no concede
capacidades a Hermes.
