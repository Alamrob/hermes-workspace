export interface StructuredAuditEvent {
  mission_id: string | null
  agent_id: string
  tool_action: string
  started_at: string
  completed_at: string
  duration_ms: number
  token_cost: { input_tokens: number; output_tokens: number; currency: string; amount: number }
  redacted_input: string
  result: string | null
  error: string | null
  retries: number
  external_action: boolean
  approval_reference: string | null
  evidence: string[]
  state_changes: string[]
  deployed_version: string
}

export interface AuditSink {
  record(event: StructuredAuditEvent): Promise<void>
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: StructuredAuditEvent[] = []

  async record(event: StructuredAuditEvent): Promise<void> {
    this.events.push(structuredClone(event))
  }
}
