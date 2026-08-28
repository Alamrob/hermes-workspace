import { runCommercialAutomationPreflight } from './commercial-automation-main.js'

try {
  process.stdout.write(`${JSON.stringify(await runCommercialAutomationPreflight())}\n`)
} catch {
  process.stderr.write('{"schema_version":"1.0","event":"commercial_automation_preflight_failed","error_code":"AUTOMATION_PREFLIGHT_UNAVAILABLE","external_actions":0}\n')
  process.exitCode = 1
}
