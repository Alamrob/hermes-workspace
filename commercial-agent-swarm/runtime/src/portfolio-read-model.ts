export const INITIAL_PROJECT_INVENTORY = [
  ['proptimiza', 'Proptimiza'],
  ['proptimiza-divi-factory', 'Proptimiza Divi Factory'],
  ['proptimiza-metodologia', 'Proptimiza Metodología'],
  ['proptimiza-brain', 'Proptimiza Brain'],
  ['xg-systems', 'XG Systems'], ['vendia', 'VendIA'],
  ['prospecta360', 'Prospecta360'], ['diagnostico360', 'Diagnóstico360'],
  ['altiropay', 'AltiroPay'], ['mallaguardian', 'MallaGuardian'],
  ['regalorapido', 'Regalorapido'], ['pickerwheel', 'PickerWheel'],
  ['afilia2', 'Afilia2'], ['bellezapro', 'BellezaPro'],
  ['compactcompute', 'CompactCompute'], ['content-factory', 'Content Factory'],
  ['fabrica-ideas-virales', 'Fábrica de Ideas Virales'], ['ia-viva', 'IA Viva'],
  ['minimundos', 'MiniMundos'], ['pixyourbrain', 'PixYourBrain'],
  ['precioalerta', 'PrecioAlerta'], ['trackingpro', 'TrackingPro'],
  ['traderbotcl', 'TraderBotCL'], ['vozpropiaia', 'VozPropiaIA'],
  ['workagent', 'WorkAgent'], ['wspro', 'WSPro'],
] as const

type Provenance = {
  source: 'control-broker' | 'twenty' | 'bff'
  sourceId: string
  observedAt: string
  synthetic: false
}

type PortfolioItem = {
  id: string
  name: string
  stage: 'active' | 'incubating' | 'paused'
  activatable: boolean
  health: 'healthy' | 'watch' | 'risk' | 'unknown'
  metric: number | null
  metricStatus: 'known' | 'unknown'
  provenance: Provenance
}

export type PortfolioReadModel = {
  portfolio: PortfolioItem[]
  projects: unknown[]
  missions: unknown[]
  missionDrafts: unknown[]
  approvals: unknown[]
  qa: unknown[]
  agents: unknown[]
  experiments: unknown[]
  costs: unknown[]
  audit: unknown[]
  control: { killSwitch: boolean }
}

const PORTFOLIO_KEYS = [
  'portfolio', 'projects', 'missions', 'missionDrafts', 'approvals', 'qa',
  'agents', 'experiments', 'costs', 'audit', 'control',
] as const
const PORTFOLIO_ITEM_KEYS = [
  'id', 'name', 'stage', 'activatable', 'health', 'metric', 'metricStatus',
  'provenance',
] as const

export function inMemoryPortfolioReadModel(input: {
  missionCount: number
  approvalCount: number
  auditCount: number
  killSwitchActive: boolean
  observedAt?: string
}): PortfolioReadModel {
  const observedAt = input.observedAt ?? new Date().toISOString()
  return {
    portfolio: INITIAL_PROJECT_INVENTORY.map(([id, name]) => ({
      id,
      name,
      stage: 'paused',
      activatable: id === 'proptimiza',
      health: 'unknown',
      metric: null,
      metricStatus: 'unknown',
      provenance: {
        source: 'control-broker',
        sourceId: `inventory:${id}`,
        observedAt,
        synthetic: false,
      },
    })),
    projects: [{
      id: 'operacion-sin-planillas',
      portfolioId: 'proptimiza',
      name: 'Operación Sin Planillas',
      offer: 'Automatización operacional controlada para empresas chilenas de servicios.',
      icp: 'Empresas chilenas B2B de servicios con 10 a 100 empleados y operaciones manuales en Excel, WhatsApp y correo.',
      priceClpFrom: 1_800_000,
      stage: 'validation',
      provenance: {
        source: 'control-broker',
        sourceId: 'catalog:proptimiza:operacion-sin-planillas:offer-v1:icp-v1',
        observedAt,
        synthetic: false,
      },
    }], missions: [], missionDrafts: [], approvals: [], qa: [],
    agents: [], experiments: [], costs: [], audit: [],
    control: { killSwitch: input.killSwitchActive },
  }
}

export function validatePortfolioReadModel(value: unknown): PortfolioReadModel {
  try {
    const model = object(value)
    exactKeys(model, PORTFOLIO_KEYS)
    if (!Array.isArray(model.portfolio) || model.portfolio.length !== INITIAL_PROJECT_INVENTORY.length)
      throw new Error('portfolio')
    const expected = new Map<string, string>(INITIAL_PROJECT_INVENTORY)
    const seen = new Set<string>()
    for (const candidate of model.portfolio) {
      const item = object(candidate)
      exactKeys(item, PORTFOLIO_ITEM_KEYS)
      if (typeof item.id !== 'string' || typeof item.name !== 'string' ||
          seen.has(item.id) || expected.get(item.id) !== item.name ||
          item.stage !== 'paused' || item.activatable !== (item.id === 'proptimiza') ||
          item.health !== 'unknown' || item.metric !== null || item.metricStatus !== 'unknown')
        throw new Error('portfolio item')
      validateProvenance(item.provenance, 'control-broker', `inventory:${item.id}`)
      seen.add(item.id)
    }
    validateProjects(array(model.projects))
    validateMissions(array(model.missions))
    validateMissionDrafts(array(model.missionDrafts))
    validateApprovals(array(model.approvals))
    validateQa(array(model.qa))
    validateAgents(array(model.agents))
    validateExperiments(array(model.experiments))
    validateCosts(array(model.costs))
    validateAudit(array(model.audit))
    const control = object(model.control)
    exactKeys(control, ['killSwitch'])
    if (typeof control.killSwitch !== 'boolean') throw new Error('kill switch')
    return value as PortfolioReadModel
  } catch {
    throw new Error('PORTFOLIO_READ_MODEL_INVALID')
  }
}

function validateProjects(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'portfolioId', 'name', 'offer', 'icp', 'priceClpFrom', 'stage', 'provenance'])
    strings(item, ['id', 'portfolioId', 'name', 'offer', 'icp'])
    finiteNumber(item.priceClpFrom)
    enumValue(item.stage, ['discovery', 'validation', 'scale'])
    validateProvenance(item.provenance)
  }
}

function validateMissions(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'portfolioId', 'title', 'status', 'ownerAgentId', 'progress', 'provenance'])
    strings(item, ['id', 'portfolioId', 'title', 'ownerAgentId'])
    enumValue(item.status, ['queued', 'running', 'blocked', 'completed'])
    nullableNumber(item.progress)
    validateProvenance(item.provenance)
  }
}

function validateMissionDrafts(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'projectId', 'portfolioId', 'title', 'status', 'provenance'])
    strings(item, ['id', 'projectId', 'portfolioId', 'title'])
    enumValue(item.status, ['draft', 'submitted'])
    validateProvenance(item.provenance)
  }
}

function validateApprovals(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'missionId', 'title', 'risk', 'status', 'mode', 'provenance'])
    strings(item, ['id', 'missionId', 'title'])
    enumValue(item.risk, ['low', 'medium', 'high'])
    enumValue(item.status, ['pending', 'approved', 'rejected'])
    enumValue(item.mode, ['sales_only', 'telegram_only', 'either', 'dual_channel'])
    validateProvenance(item.provenance)
  }
}

function validateQa(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'missionId', 'check', 'score', 'evidenceCount', 'status', 'provenance'])
    strings(item, ['id', 'missionId', 'check'])
    nullableNumber(item.score)
    if (item.evidenceCount !== null && !nonnegativeInteger(item.evidenceCount)) throw new Error('evidence count')
    enumValue(item.status, ['pass', 'review'])
    validateProvenance(item.provenance)
  }
}

function validateAgents(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'code', 'name', 'role', 'status', 'currentMissionId', 'provenance'])
    strings(item, ['id', 'name', 'role'])
    enumValue(item.code, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'])
    enumValue(item.status, ['ready', 'running', 'blocked', 'offline'])
    if (item.currentMissionId !== null && typeof item.currentMissionId !== 'string') throw new Error('current mission')
    validateProvenance(item.provenance)
  }
}

function validateExperiments(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'portfolioId', 'name', 'hypothesis', 'status', 'primaryMetric', 'lift', 'provenance'])
    strings(item, ['id', 'portfolioId', 'name', 'hypothesis', 'primaryMetric'])
    enumValue(item.status, ['draft', 'running', 'won', 'lost'])
    nullableNumber(item.lift)
    validateProvenance(item.provenance)
  }
}

function validateCosts(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, ['id', 'agentId', 'amount', 'currency', 'status', 'period', 'provenance'])
    strings(item, ['id', 'agentId', 'period'])
    nullableNumber(item.amount)
    if (item.currency !== 'USD') throw new Error('currency')
    enumValue(item.status, ['known', 'unknown'])
    validateProvenance(item.provenance)
  }
}

function validateAudit(values: unknown[]): void {
  for (const value of values) {
    const item = object(value)
    exactKeys(item, item.reason === undefined
      ? ['id', 'portfolioId', 'actorId', 'action', 'targetId', 'at', 'provenance']
      : ['id', 'portfolioId', 'actorId', 'action', 'targetId', 'at', 'reason', 'provenance'])
    strings(item, ['id', 'portfolioId', 'actorId', 'action', 'targetId', 'at'])
    if (item.reason !== undefined && typeof item.reason !== 'string') throw new Error('reason')
    validateProvenance(item.provenance)
  }
}

function validateProvenance(value: unknown, source?: Provenance['source'], sourceId?: string): void {
  const provenance = object(value)
  exactKeys(provenance, ['source', 'sourceId', 'observedAt', 'synthetic'])
  if (!['control-broker', 'twenty', 'bff'].includes(String(provenance.source)) ||
      (source !== undefined && provenance.source !== source) ||
      typeof provenance.sourceId !== 'string' || provenance.sourceId.length === 0 ||
      (sourceId !== undefined && provenance.sourceId !== sourceId) ||
      typeof provenance.observedAt !== 'string' || !Number.isFinite(Date.parse(provenance.observedAt)) ||
      provenance.synthetic !== false) throw new Error('provenance')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('array')
  return value
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error('keys')
}

function strings(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) if (typeof value[key] !== 'string') throw new Error(key)
}

function enumValue(value: unknown, values: readonly string[]): void {
  if (!values.includes(String(value))) throw new Error('enum')
}

function finiteNumber(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('number')
}

function nullableNumber(value: unknown): void {
  if (value !== null) finiteNumber(value)
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
