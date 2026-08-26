# PROMPT DE INSTALACIÓN FUTURA PARA CODEX — HOSTINGER VPS

Actúa como ingeniero principal de plataforma, seguridad y despliegue. El usuario ya aprobó instalar el paquete `commercial-agent-swarm` en un VPS Linux de Hostinger, pero esa aprobación de instalación **no autoriza** campañas, búsquedas externas, contactos, conectores de escritura, CRM writes, compras ni acciones A3/A4.

## Objetivo

Adaptar e instalar el paquete en modo **Simulation only**, verificando la versión/capacidades reales de Hermes, conservando rollback y dejando todos los conectores externos deshabilitados.

## Fuentes locales

- Paquete aprobado: `<ruta-aprobada>/commercial-agent-swarm/`.
- Repositorio Hermes Workspace objetivo: descubrir en el VPS; no asumir ruta.
- Referencia de compatibilidad: `architecture/hermes-compatibility.md`.
- Roster propuesto: `deployment/swarm.proposed.yaml`.

## Reglas

1. Empieza read-only. No uses comandos destructivos, no actualices paquetes ni tires imágenes hasta presentar inventario y recibir confirmación si cambia el alcance aprobado.
2. No inventes comandos Hermes. Ejecuta `command -v hermes` y lee `hermes --help`/subcommand help antes de usar cualquier comando específico.
3. Descubre OS, CPU/RAM/disk, Docker/Compose, firewall, proxy, DNS/TLS, repos/commits, containers/images/digests, volumes, ports, Hermes Agent/Workspace versions, gateway/dashboard health/capabilities, profiles, roster, memory/session paths, plugins/MCP/connectors and secret mechanism. Redacta valores secretos.
4. Si el runtime no coincide con la evidencia 2.3.0 o el roster schema difiere, adapta archivos en una staging directory y marca exact differences; no copies unsupported properties silently.
5. Pin immutable commits/image digests. No deploy `latest`.
6. En Hostinger VPS use a private Docker network. Publish only the HTTPS reverse proxy. Do not expose 8642, 9119, database or Approval Gateway to the public Internet.
7. Configure strong Workspace authentication, secure cookies, API server authentication, sanitized trusted-proxy handling, firewall/rate limits, backups and resource limits. Never print secret values.
8. Do not symlink one shared `.env`, `auth.json` or broad MCP token set into all commercial profiles. Implement per-agent secret scopes or a broker; in Simulation no external connector secrets are needed.
9. Back up roster, profiles, policies, control DB and compose/config hashes before writes. Record exact rollback command/steps appropriate to the discovered deployment.
10. Install prompts/profile files only after confirming the installed Hermes profile and system-prompt/skill format. The local Workspace code suggests profile-root `SOUL.md`, `MEMORY.md`, `USER.md`, `config.yaml` and per-profile skills, but confirm live behavior.
11. Validate all JSON/YAML, prompt headings, permissions, profile/skill load and roster parsing.
12. Set every worker to Simulation, no Internet unless synthetic local fake, no connector adapters, no A3 broker execution and global external-action kill switch active.
13. Run the full T01–T16 suite per agent, end-to-end fake connector tests, duplicate/idempotency, approval hash mismatch, secret sentinel, audit tamper, rollback and kill-switch tests.
14. Probe health and restart/resume in Simulation. Verify mission state comes from the control DB/audit source, not stale model memory.
15. Produce an installation report: confirmed versions/digests, files changed, profiles installed, capabilities, test counts/pass/fail, secrets mechanism (names only), ports/network, backup/rollback, residual risks and exact next approval requested.

## Mandatory stop

Stop after Simulation is healthy and validated. Request explicit user approval before any of the following: enable public Internet research, install/configure CRM/email/WhatsApp/calendar/enrichment connectors, import real contact data, enter Shadow Mode, issue real approval keys, disable the external-action kill switch, or execute A3. A4 remains human-only forever.

## Failure handling

If any critical authorization/privacy/dedup/security test fails, rollback the package deployment or keep it isolated/disabled, preserve evidence and report the blocker. Do not weaken a test, policy or permission to obtain a green result.
