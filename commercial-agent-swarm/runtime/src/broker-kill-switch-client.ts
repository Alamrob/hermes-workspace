const BROKER_ORIGIN = 'http://broker:8080'

export class BrokerKillSwitchClient {
  constructor(private readonly options: {
    readBearer: () => Promise<string>
    fetch?: typeof fetch
    timeoutMs?: number
  }) {}

  async isActive(input: { missionId: string; channel: string }): Promise<boolean> {
    const bearer = (await this.options.readBearer()).trim()
    if (bearer.length < 32 || bearer.length > 4_096 || /\s/.test(bearer))
      throw new Error('BROKER_SAFETY_BEARER_INVALID')
    const fetchImpl = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${BROKER_ORIGIN}/internal/v1/safety/kill-switch`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout()),
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mission_id: input.missionId, channel: input.channel }),
      })
    } catch {
      throw new Error('BROKER_SAFETY_UNAVAILABLE')
    }
    if (response.status !== 200) throw new Error(`BROKER_SAFETY_HTTP_${response.status}`)
    let value: unknown
    try { value = await response.json() }
    catch { throw new Error('BROKER_SAFETY_RESPONSE_INVALID') }
    if (!record(value) || typeof value.active !== 'boolean' || Object.keys(value).length !== 1)
      throw new Error('BROKER_SAFETY_RESPONSE_INVALID')
    return value.active
  }

  private timeout(): number {
    const value = this.options.timeoutMs ?? 5_000
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 10_000)
      throw new Error('BROKER_SAFETY_TIMEOUT_INVALID')
    return value
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
