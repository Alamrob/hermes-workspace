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

export type PortfolioReadModel = ReturnType<typeof inMemoryPortfolioReadModel>

const PORTFOLIO_KEYS = [
  'portfolio', 'projects', 'missions', 'missionDrafts', 'approvals', 'qa',
  'agents', 'experiments', 'costs', 'audit', 'control',
] as const
const PROJECT_KEYS = [
  'projectId', 'displayName', 'operatingState', 'activatable',
  'maturityStatus', 'offerEvidence', 'icpEvidence', 'policyEvidence',
  'provenance',
] as const

export function inMemoryPortfolioReadModel(input: {
  missionCount: number
  approvalCount: number
  auditCount: number
  killSwitchActive: boolean
}) {
  const knownCount = (count: number) => ({ status: 'known' as const, count, provenance: 'runtime-memory' })
  const unknownCount = () => ({ status: 'unknown' as const, count: null, provenance: 'not-modeled' })
  return {
    portfolio: {
      status: 'known' as const,
      projectCount: INITIAL_PROJECT_INVENTORY.length,
      provenance: 'user-approved-inventory-2026-08-16',
    },
    projects: INITIAL_PROJECT_INVENTORY.map(([projectId, displayName]) => ({
      projectId, displayName,
      operatingState: projectId === 'proptimiza' ? 'read_only' as const : 'inactive' as const,
      activatable: projectId === 'proptimiza',
      maturityStatus: 'unknown' as const,
      offerEvidence: projectId === 'proptimiza' ? 'versioned-catalog' : null,
      icpEvidence: projectId === 'proptimiza' ? 'versioned-catalog' : null,
      policyEvidence: projectId === 'proptimiza' ? 'versioned-catalog' : null,
      provenance: 'user-approved-inventory-2026-08-16',
    })),
    missions: knownCount(input.missionCount),
    missionDrafts: unknownCount(),
    approvals: knownCount(input.approvalCount),
    qa: unknownCount(), agents: unknownCount(), experiments: unknownCount(),
    costs: {
      status: 'unknown' as const,
      usageValueMicroCents: null,
      cashCostMicroCents: null,
      provenance: 'not-aggregated',
    },
    audit: knownCount(input.auditCount),
    control: {
      killSwitch: {
        status: 'known' as const,
        active: input.killSwitchActive,
        provenance: 'runtime-memory',
      },
    },
  }
}

export function validatePortfolioReadModel(value: unknown): PortfolioReadModel {
  try {
    const model = object(value)
    exactKeys(model, PORTFOLIO_KEYS)
    const portfolio = object(model.portfolio)
    exactKeys(portfolio, ['status', 'projectCount', 'provenance'])
    if (portfolio.status !== 'known' || portfolio.projectCount !== INITIAL_PROJECT_INVENTORY.length ||
        portfolio.provenance !== 'user-approved-inventory-2026-08-16') throw new Error('portfolio')
    if (!Array.isArray(model.projects) || model.projects.length !== INITIAL_PROJECT_INVENTORY.length)
      throw new Error('projects')
    const expected = new Map<string, string>(INITIAL_PROJECT_INVENTORY)
    const seen = new Set<string>()
    for (const candidate of model.projects) {
      const project = object(candidate)
      exactKeys(project, PROJECT_KEYS)
      if (typeof project.projectId !== 'string' || typeof project.displayName !== 'string' ||
          seen.has(project.projectId) || expected.get(project.projectId) !== project.displayName ||
          project.operatingState !== (project.projectId === 'proptimiza' ? 'read_only' : 'inactive') ||
          project.activatable !== (project.projectId === 'proptimiza') ||
          project.maturityStatus !== 'unknown' ||
          project.provenance !== 'user-approved-inventory-2026-08-16') throw new Error('project')
      for (const evidence of ['offerEvidence', 'icpEvidence', 'policyEvidence'] as const)
        if (project[evidence] !== null && project[evidence] !== 'versioned-catalog')
          throw new Error('evidence')
      if (project.projectId !== 'proptimiza' &&
          (project.offerEvidence !== null || project.icpEvidence !== null || project.policyEvidence !== null))
        throw new Error('invented evidence')
      seen.add(project.projectId)
    }
    knownCount(model.missions)
    unknownCount(model.missionDrafts)
    knownCount(model.approvals)
    unknownCount(model.qa)
    unknownCount(model.agents)
    unknownCount(model.experiments)
    knownCount(model.audit)
    const costs = object(model.costs)
    exactKeys(costs, ['status', 'usageValueMicroCents', 'cashCostMicroCents', 'provenance'])
    if (costs.status !== 'unknown' || costs.usageValueMicroCents !== null ||
        costs.cashCostMicroCents !== null || costs.provenance !== 'not-aggregated') throw new Error('costs')
    const control = object(model.control)
    exactKeys(control, ['killSwitch'])
    const killSwitch = object(control.killSwitch)
    exactKeys(killSwitch, ['status', 'active', 'provenance'])
    if (killSwitch.status !== 'known' || typeof killSwitch.active !== 'boolean' ||
        !['postgres', 'runtime-memory'].includes(String(killSwitch.provenance))) throw new Error('kill switch')
    return value as PortfolioReadModel
  } catch {
    throw new Error('PORTFOLIO_READ_MODEL_INVALID')
  }
}

function knownCount(value: unknown): void {
  const candidate = object(value)
  exactKeys(candidate, ['status', 'count', 'provenance'])
  if (candidate.status !== 'known' || !nonnegativeInteger(candidate.count) ||
      !['postgres', 'runtime-memory'].includes(String(candidate.provenance))) throw new Error('known count')
}

function unknownCount(value: unknown): void {
  const candidate = object(value)
  exactKeys(candidate, ['status', 'count', 'provenance'])
  if (candidate.status !== 'unknown' || candidate.count !== null || candidate.provenance !== 'not-modeled')
    throw new Error('unknown count')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error('keys')
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
