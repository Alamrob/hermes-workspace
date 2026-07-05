import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const host = process.env.HOST || '0.0.0.0'
const port = Number.parseInt(process.env.PORT || '3000', 10)
const startedAt = Date.now()
const serverEntryPath = resolve('server-entry.js')
const serverBuildPath = resolve('dist/server/server.js')
const clientBuildPath = resolve('dist/client')

let currentPayload = diagnosticPayload('bootstrapping')

function summarizeUrl(rawUrl) {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    return {
      protocol: parsed.protocol.replace(/:$/, ''),
      hostname: parsed.hostname || null,
      port: parsed.port || null,
      pathname: parsed.pathname || '/',
    }
  } catch {
    return { parseError: true }
  }
}

function activeHandleSummary() {
  const getHandles = process._getActiveHandles
  if (typeof getHandles !== 'function') return []
  return getHandles.call(process).map((handle) => handle?.constructor?.name ?? 'Unknown')
}

function redact(value) {
  let output = String(value)
    .replace(/(authorization|cookie|password|secret|token|api[_-]?key)([=:]\s*)[^\s,"'}]+/gi, '$1$2[REDACTED]')
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, '$1[REDACTED]$2')

  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8) continue
    if (!/(SECRET|TOKEN|KEY|PASSWORD|HERMES_API_TOKEN|API_SERVER_KEY)/i.test(key)) continue
    output = output.split(secret).join(`[REDACTED:${key}]`)
  }

  return output
}

function htmlEscape(value) {
  return value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] ?? char)
}

function deploymentMode() {
  if (process.env.HERMES_DASHBOARD_URL) return 'hermes-agent-full'
  if (process.env.HERMES_API_URL) return 'portable-openai-compatible'
  return 'unconfigured'
}

function diagnosticPayload(reason, extra = {}) {
  return {
    ok: false,
    phase: 'hostinger-start',
    reason,
    elapsedMs: Date.now() - startedAt,
    node: process.version,
    cwd: process.cwd(),
    host,
    port,
    serverEntryPath,
    serverEntryExists: existsSync(serverEntryPath),
    serverBuildPath,
    serverBuildExists: existsSync(serverBuildPath),
    clientBuildPath,
    clientBuildExists: existsSync(clientBuildPath),
    deploymentMode: deploymentMode(),
    hasHermesPassword: Boolean(process.env.HERMES_PASSWORD || process.env.CLAUDE_PASSWORD),
    cookieSecure: process.env.COOKIE_SECURE ?? null,
    trustProxy: process.env.TRUST_PROXY ?? null,
    hermesApiUrl: summarizeUrl(process.env.HERMES_API_URL || process.env.CLAUDE_API_URL),
    hermesDashboardUrl: summarizeUrl(process.env.HERMES_DASHBOARD_URL || process.env.CLAUDE_DASHBOARD_URL),
    hasHermesApiToken: Boolean(process.env.HERMES_API_TOKEN || process.env.CLAUDE_API_TOKEN),
    ...extra,
  }
}

function writeDiagnosticsResponse(req, res) {
  if (req.url?.startsWith('/api/health')) {
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(currentPayload, null, 2))
    return
  }

  const body = htmlEscape(JSON.stringify(currentPayload, null, 2))
  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hermes Workspace Hostinger diagnostics</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 24px; background: #111; color: #f4f4f4; }
      pre { white-space: pre-wrap; background: #1d1d1d; border: 1px solid #444; padding: 16px; border-radius: 8px; }
    </style>
  </head>
  <body>
    <h1>Hermes Workspace Hostinger diagnostics</h1>
    <p>The workspace server has not finished starting.</p>
    <pre>${body}</pre>
  </body>
</html>`)
}

const earlyServer = createServer(writeDiagnosticsResponse)

function updateDiagnostics(reason, extra) {
  currentPayload = diagnosticPayload(reason, extra)
  console.error(JSON.stringify(currentPayload, null, 2))
}

await new Promise((resolveListen, rejectListen) => {
  const onError = (error) => {
    earlyServer.off('error', onError)
    rejectListen(error)
  }
  earlyServer.once('error', onError)
  earlyServer.listen(port, host, () => {
    earlyServer.off('error', onError)
    console.error(`Hermes Workspace Hostinger entry listening early on ${host}:${port}`)
    resolveListen()
  })
}).catch((error) => {
  console.error('Failed to start Hermes Workspace Hostinger entry server', error)
  process.exit(1)
})

globalThis.__HERMES_WORKSPACE_HOSTINGER_EARLY_SERVER = earlyServer
process.env.HERMES_HOSTINGER_EARLY_LISTEN = 'true'

if (!existsSync(serverEntryPath)) {
  updateDiagnostics('missing-server-entry')
} else if (!existsSync(serverBuildPath)) {
  updateDiagnostics('missing-server-build', {
    note: 'Run `corepack pnpm build` before starting Hostinger Node.js.',
  })
} else {
  const slowStartupTimer = setTimeout(() => {
    updateDiagnostics('starting-server-slow', {
      activeHandles: activeHandleSummary(),
      note: 'The entrypoint is alive, but server startup has not completed yet.',
    })
  }, Number.parseInt(process.env.HERMES_HOSTINGER_SLOW_START_MS || '30000', 10))
  slowStartupTimer.unref?.()

  try {
    updateDiagnostics('importing-server')
    const serverModule = await import(`file://${serverEntryPath}`)

    if (typeof serverModule.startServer !== 'function') {
      clearTimeout(slowStartupTimer)
      updateDiagnostics('missing-start-server-export')
    } else {
      updateDiagnostics('starting-server')
      serverModule.startServer({ server: earlyServer, host, port })
      clearTimeout(slowStartupTimer)
    }
  } catch (error) {
    clearTimeout(slowStartupTimer)
    updateDiagnostics('start-server-error', {
      error: redact(error.stack ?? error.message ?? String(error)),
    })
  }
}
