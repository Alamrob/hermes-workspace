# Hermes Compatibility Evidence

Inspection date: 2026-08-15. Scope: local files and local runtime discovery only. No Internet search and no deployment action were performed.

## Confirmed locally

| Item              | Evidence                                                                | Conclusion                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace package | `C:\VibeCoding\WorkAgent\hermes-workspace\package.json`                 | `hermes-workspace` version 2.3.0; Node 22+; MIT; local fork of `outsourc-e/hermes-workspace`.                                                                                                                                                                                                                  |
| Repository state  | Git commit `858b605693e3194c97647851e40a4044ec2e6caa`, dated 2026-07-05 | Package targets this local commit, not an assumed newer release.                                                                                                                                                                                                                                               |
| Roster            | `swarm.yaml` and `src/server/swarm-roster.ts`                           | Confirmed fields: `id`, `name`, `role`, `specialty`, `model`, `mission`, `profile`, `modes`, `tools`, `skills`, `plugins`, `pluginToolsets`, `mcpServers`, `wrapper`, `capabilities`, `defaultCwd`, `preferredTaskTypes`, `greenlightRequiredFor`, `maxConcurrentTasks`, `acceptsBroadcast`, `reviewRequired`. |
| Profiles          | `AGENTS.md`, `src/server/swarm-profile-config.ts`                       | Profiles are expected under `~/.hermes/profiles/<worker-id>/`; each can have `config.yaml`, profile files, a core skill and a wrapper.                                                                                                                                                                         |
| Model config      | `src/server/swarm-profile-config.ts`                                    | Hermes reads `config.yaml` with `model.provider` and `model.default`. Exact provider/model must be selected on the target host.                                                                                                                                                                                |
| Sessions/runtime  | local source and docs                                                   | `state.db`, `runtime.json`, tmux-backed worker sessions and gateway/dashboard APIs are supported by this Workspace code.                                                                                                                                                                                       |
| Memory            | `src/server/swarm-memory.ts`                                            | Durable role memory is at profile-root `MEMORY.md`, `SOUL.md`, `USER.md`; mission events and handoffs live under `profile/memory/`. This code resolves a contradiction in an older memory spec.                                                                                                                |
| Dispatch          | local docs/source                                                       | Workspace supports roster-based assignments, persistent workers, checkpoint envelopes and native-swarm fallback when Conductor is absent.                                                                                                                                                                      |
| Logical tools     | existing `AGENTS.md`/`swarm.yaml`                                       | Confirmed names in the current roster include `file`, `terminal`, `web`, `browser`, `gbrain`, `session_search`, `skills`, `todo`, `kanban`, `delegation`, `cronjob`, `clarify`, `vision`. Availability still depends on the target profile/runtime.                                                            |
| Gateway endpoints | README and capability code                                              | Health, OpenAI-compatible chat, models, sessions, skills, config, jobs, memory and optional MCP/Conductor/Kanban are capability-probed.                                                                                                                                                                        |
| Docker shape      | local `docker-compose.yml`                                              | Agent and Workspace share a named volume; gateway 8642, dashboard 9119 and Workspace 3000; host ports are loopback-bound by default.                                                                                                                                                                           |

## Not confirmed

- No `hermes` executable is present in the current Windows PATH.
- No local `~/.hermes` directory or profile set was present.
- The Docker daemon could not be inspected from this session and the repository has no `.env`.
- The live VPS was not accessible, so the installed `hermes-agent` version, image digest, active plugins, tools, profiles, secrets, sessions and connectors are unknown.
- The repository documentation says vanilla `hermes-agent` 0.10.0 supplies a capability baseline, but that is documentation evidence, not proof of the installed VPS runtime.
- Compose references `nousresearch/hermes-agent:latest` and `ghcr.io/outsourc-e/hermes-workspace:latest`; no immutable digest is confirmed.

## Security-relevant findings

1. The Workspace UI approval store in `src/screens/gateway/lib/approvals-store.ts` persists approvals in browser `localStorage`. It does not cryptographically bind action, target, content, volume or expiry and is not acceptable as the commercial A3 Approval Gateway.
2. `ensureSwarmProfileConfig` may symlink the main `.env`, `auth.json` and MCP token files into worker profiles. Production least privilege requires per-agent secret scopes or a broker that never exposes raw secrets to model context.
3. Existing `swarm.yaml` tool and skill lists are descriptive roster metadata. A production enforcement layer must separately authorize tool calls server-side.
4. Mission state stored only in browser local storage is not a durable audit source. PostgreSQL/Supabase must hold authoritative approval and audit records.

## Adaptation rule

Files named `*.proposed.yaml` are portable design inputs, not executable truth. Before installation, Codex must inspect the live host, export capabilities, pin image digests, validate the exact profile/skill format, map logical connector names to installed adapters, and regenerate native files. If a property is unsupported, it must remain in the external policy layer rather than being silently dropped.
