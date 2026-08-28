import { runCommercialAutomationAuthorizedOneShot } from './commercial-automation-main.js'

try {
  process.stdout.write(`${JSON.stringify(await runCommercialAutomationAuthorizedOneShot())}\n`)
} catch {
  process.stderr.write('{"schema_version":"1.0","event":"commercial_automation_one_shot_failed","error_code":"AUTOMATION_ONE_SHOT_UNAVAILABLE","external_actions":0}\n')
  process.exitCode = 1
}
