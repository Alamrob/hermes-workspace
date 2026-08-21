import type {
  BrokerAutomationPort,
  PaperclipAutomationPort,
  PaperclipComment,
  PaperclipIssue,
} from './commercial-automation.js'
import type { AssignmentPlan } from './assignment-plan.js'
import type { MissionExecution } from './dispatch-queue.js'
import type { WorkOrder } from './work-orders.js'

const RESPONSE_LIMIT = 1_048_576

export class PaperclipHttpClient implements PaperclipAutomationPort {
  private readonly base: URL
  constructor(
    baseUrl: string,
    private readonly companyId: string,
    private readonly bearer: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = exactInternalOrigin(baseUrl, 'paperclip', 3100)
  }

  async listIssues(): Promise<PaperclipIssue[]> {
    const value = await this.request(`/api/companies/${this.companyId}/issues?view=compact`, 'GET')
    const items = Array.isArray(value) ? value : record(value) && Array.isArray(value.items) ? value.items : null
    if (!items) throw new Error('PAPERCLIP_RESPONSE_INVALID')
    return items.map(parseIssue)
  }

  async listComments(issueId: string): Promise<PaperclipComment[]> {
    const value = await this.request(`/api/issues/${uuid(issueId)}/comments`, 'GET')
    const items = Array.isArray(value) ? value : record(value) && Array.isArray(value.items) ? value.items : null
    if (!items) throw new Error('PAPERCLIP_RESPONSE_INVALID')
    return items.map((entry) => {
      if (!record(entry) || typeof entry.body !== 'string') throw new Error('PAPERCLIP_RESPONSE_INVALID')
      const authorType = ['user', 'agent', 'system'].includes(String(entry.authorType)) ? entry.authorType as PaperclipComment['authorType'] : null
      return { body: entry.body, authorType }
    })
  }

  async addSystemComment(issueId: string, body: string): Promise<void> {
    if (body.length < 1 || body.length > 4_000) throw new Error('PAPERCLIP_COMMENT_INVALID')
    await this.request(`/api/issues/${uuid(issueId)}/comments`, 'POST', {
      body,
      authorType: 'system',
      presentation: { kind: 'system_notice', tone: 'info', title: 'Commercial automation', detailsDefaultOpen: false, density: 'compact' },
    })
  }

  async updateIssueStatus(issueId: string, status: 'in_progress' | 'in_review' | 'blocked'): Promise<void> {
    await this.request(`/api/issues/${uuid(issueId)}`, 'PATCH', { status })
  }

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await this.fetchImpl(new URL(path, this.base), {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${await this.bearer()}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(`PAPERCLIP_HTTP_${response.status}`)
      return await boundedJson(response)
    } catch (error) {
      if (error instanceof Error && /^PAPERCLIP_(?:HTTP_|RESPONSE_)/.test(error.message)) throw error
      throw new Error('PAPERCLIP_UNAVAILABLE')
    } finally {
      clearTimeout(timer)
    }
  }
}

export class BrokerHttpClient implements BrokerAutomationPort {
  private readonly base: URL
  constructor(
    baseUrl: string,
    private readonly controlBearer: () => Promise<string>,
    private readonly internalBearer: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = exactInternalOrigin(baseUrl, 'broker', 8080)
  }

  async createWorkOrder(order: WorkOrder): Promise<void> {
    await this.request('/v1/work-orders', 'POST', order, await this.controlBearer(), [201])
  }
  async createAssignments(plan: AssignmentPlan): Promise<void> {
    await this.request(`/v1/missions/${plan.mission_id}/assignments`, 'POST', plan, await this.controlBearer(), [202])
  }
  async getExecution(missionId: string): Promise<MissionExecution> {
    const value = await this.request(`/internal/v1/missions/${uuid(missionId)}/execution`, 'GET', undefined, await this.internalBearer(), [200])
    if (!record(value) || value.mission_id !== missionId || !Array.isArray(value.assignments) || !['queued', 'running', 'completed', 'failed', 'blocked'].includes(String(value.status))) throw new Error('BROKER_RESPONSE_INVALID')
    return value as unknown as MissionExecution
  }

  private async request(path: string, method: string, body: unknown, bearer: string, statuses: number[]): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await this.fetchImpl(new URL(path, this.base), {
        method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!statuses.includes(response.status)) throw new Error(`BROKER_HTTP_${response.status}`)
      return await boundedJson(response)
    } catch (error) {
      if (error instanceof Error && /^BROKER_(?:HTTP_|RESPONSE_)/.test(error.message)) throw error
      throw new Error('BROKER_UNAVAILABLE')
    } finally {
      clearTimeout(timer)
    }
  }
}

function parseIssue(value: unknown): PaperclipIssue {
  if (!record(value)) throw new Error('PAPERCLIP_RESPONSE_INVALID')
  const id = value.id
  const identifier = value.identifier
  const title = value.title
  const description = value.description
  const status = value.status
  const projectId = value.projectId
  const updatedAt = value.updatedAt
  if (
    typeof id !== 'string' || !UUID.test(id) || typeof identifier !== 'string' ||
    !/^ALA-[0-9]{1,6}$/.test(identifier) || typeof title !== 'string' || title.length > 500 ||
    (description !== null && typeof description !== 'string') ||
    !['backlog','todo','in_progress','in_review','done','blocked','cancelled'].includes(String(status)) ||
    (projectId !== null && (typeof projectId !== 'string' || !UUID.test(projectId))) ||
    typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))
  ) throw new Error('PAPERCLIP_RESPONSE_INVALID')
  return { id, identifier, title, description: description as string | null, status: status as PaperclipIssue['status'], projectId: projectId as string | null, updatedAt }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('RESPONSE_BODY_REQUIRED')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > RESPONSE_LIMIT) {
      await reader.cancel()
      throw new Error('RESPONSE_TOO_LARGE')
    }
    chunks.push(part.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('RESPONSE_INVALID_JSON')
  }
}

function exactInternalOrigin(value: string, host: string, port: number): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== host || Number(url.port || 80) !== port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('AUTOMATION_INTERNAL_ORIGIN_INVALID')
  return url
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function uuid(value: string): string {
  if (!UUID.test(value)) throw new Error('AUTOMATION_ID_INVALID')
  return value
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
