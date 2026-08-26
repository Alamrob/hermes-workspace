import { execFileSync } from 'node:child_process'
import {
  ACTIVE_PROFILE_IDS,
  PROFILE_TOOLSETS,
  validateHermesEffectiveToolSummary,
} from '../src/server/commercial-swarm-validator'

const errors: Array<string> = []

for (const profileId of ACTIVE_PROFILE_IDS) {
  try {
    const summary = execFileSync(
      'hermes',
      ['-p', profileId, 'tools', '--summary', 'list'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    errors.push(
      ...validateHermesEffectiveToolSummary(
        summary,
        PROFILE_TOOLSETS[profileId],
        profileId,
      ),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(
      `${profileId}: Hermes tools preflight command failed (${message})`,
    )
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log(
    `Hermes commercial tool preflight passed for ${ACTIVE_PROFILE_IDS.length} profiles`,
  )
}
