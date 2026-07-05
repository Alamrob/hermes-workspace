# Hostinger Node.js Deployment

This guide prepares Hermes Workspace for Hostinger's Node.js hosting flow. It
does not start `hermes gateway` or `hermes dashboard` inside the Hostinger app
process. For full Workspace features, run Hermes Agent gateway and dashboard on
a separate reachable host and point this app at them.

## Hostinger Commands

Use these commands in the Hostinger Node.js app settings:

```sh
corepack enable && corepack pnpm install --frozen-lockfile
```

```sh
corepack enable && corepack pnpm build
```

```sh
node hostinger-start.mjs
```

The `hostinger-start.mjs` entrypoint opens the assigned port immediately and
serves diagnostic output on `/api/health` until the built app is ready. This is
useful when Hostinger checks the port while dependencies, build output, or
runtime environment variables are still being validated.

## Required Environment

Set these in Hostinger's environment variable panel:

```env
NODE_ENV=production
HOST=0.0.0.0
HERMES_PASSWORD=<strong 32+ character secret>
COOKIE_SECURE=1
TRUST_PROXY=1
```

Hostinger assigns `PORT` automatically for many Node.js apps. If the panel
requires an explicit value, use the same port configured for the app.

## Full Hermes Agent Mode

Use this when a separate Hermes Agent gateway and dashboard are reachable from
Hostinger:

```env
HERMES_API_URL=https://<agent-gateway-domain>
HERMES_DASHBOARD_URL=https://<agent-dashboard-domain>
HERMES_API_TOKEN=<same value as API_SERVER_KEY>
```

On the Hermes Agent host, the gateway must have `API_SERVER_ENABLED=true`.
If the gateway is exposed outside loopback, protect it with `API_SERVER_KEY`
and use the same value as `HERMES_API_TOKEN` in Hostinger.

Full mode enables chat plus dashboard-backed features such as sessions, memory,
skills, jobs, MCP, and conductor surfaces when the upstream services provide
those APIs.

## Portable OpenAI-Compatible Mode

Use this when Hostinger should connect directly to an OpenAI-compatible backend:

```env
HERMES_API_URL=https://<openai-compatible-base-url>
```

Leave `HERMES_DASHBOARD_URL` unset in this mode. Chat can work, but dashboard
features such as sessions, memory, skills, jobs, and some operations panes may
show as unavailable.

## GitHub Deployment Flow

Recommended repository layout:

```sh
git remote -v
# origin   https://github.com/Alamrob/hermes-workspace.git
# upstream https://github.com/outsourc-e/hermes-workspace.git
```

Deploy Hostinger from `Alamrob/hermes-workspace` on the `main` branch. To pull
future upstream updates:

```sh
git fetch upstream
git merge upstream/main
```

Resolve conflicts locally, rerun the build, then push `main` back to `origin`.

## Verification

Before deploying:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Local smoke test:

```sh
PORT=3000 HOST=0.0.0.0 HERMES_PASSWORD=test-password COOKIE_SECURE=0 node hostinger-start.mjs
```

Then check:

```sh
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/api/health
```

On Hostinger, review the app logs after first boot. If the app is not ready,
`/api/health` returns a JSON diagnostic payload showing whether `server-entry.js`,
`dist/server/server.js`, and `dist/client` exist, which backend mode is
configured, and whether required security variables are present.
