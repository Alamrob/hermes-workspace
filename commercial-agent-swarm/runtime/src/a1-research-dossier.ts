export type A1ResearchDossierStatus = 'review_incomplete' | 'no_eligible_accounts' | 'authorization_required'

export interface A1ResearchDossierAccount {
  slot: number
  companyName: string
  sourceUrl: string
  decision: 'accepted_internal' | 'revised_internal'
  decisionVersion: number
}

export interface A1ResearchDossier {
  reviewId: string
  projectId: 'proptimiza'
  offerId: 'operacion-sin-planillas'
  offerVersion: 'v1'
  status: A1ResearchDossierStatus
  reviewCompleted: boolean
  eligibleAccountCount: number
  accounts: A1ResearchDossierAccount[]
  autonomyLevel: 'A1'
  allowedActions: ['analysis.internal', 'research.public.read']
  prohibitedActions: string[]
  approvedChannels: ['internal', 'public_web']
  requestedTools: ['hermes.analysis', 'hermes.web']
  allowedDataCategories: ['public_company_identity', 'public_business_information', 'public_source_provenance', 'published_role_based_corporate_channel']
  maximumAccounts: number
  maximumContacts: 0
  maximumExternalActions: 0
  maximumBudgetUsd: 0.5
  providerCreditSpendAllowed: false
  internetAccessAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  authorizationRequired: boolean
  missionCreated: false
  productionGate: 'blocked'
  externalActions: 0
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROHIBITED = [
  'credit.consume', 'personal_contact.discover', 'personal_email.infer', 'crm.write',
  'mail.send', 'message.send', 'campaign.activate', 'a3.enable',
]

export function validateA1ResearchDossier(value: unknown): A1ResearchDossier {
  try {
    const dossier = object(value)
    exactKeys(dossier, [
      'reviewId','projectId','offerId','offerVersion','status','reviewCompleted',
      'eligibleAccountCount','accounts','autonomyLevel','allowedActions','prohibitedActions',
      'approvedChannels','requestedTools','allowedDataCategories','maximumAccounts',
      'maximumContacts','maximumExternalActions','maximumBudgetUsd',
      'providerCreditSpendAllowed','internetAccessAllowed','contactPermitted','crmWriteAllowed',
      'authorizationRequired','missionCreated','productionGate','externalActions','provenance',
    ])
    if (!UUID.test(text(dossier.reviewId)) || dossier.projectId !== 'proptimiza' ||
        dossier.offerId !== 'operacion-sin-planillas' || dossier.offerVersion !== 'v1' ||
        !['review_incomplete','no_eligible_accounts','authorization_required'].includes(text(dossier.status)) ||
        typeof dossier.reviewCompleted !== 'boolean' || !integer(dossier.eligibleAccountCount, 0, 3) ||
        dossier.autonomyLevel !== 'A1' ||
        !exactArray(dossier.allowedActions, ['analysis.internal','research.public.read']) ||
        !stringArray(dossier.prohibitedActions) || PROHIBITED.some((item) => !(dossier.prohibitedActions as string[]).includes(item)) ||
        !exactArray(dossier.approvedChannels, ['internal','public_web']) ||
        !exactArray(dossier.requestedTools, ['hermes.analysis','hermes.web']) ||
        !exactArray(dossier.allowedDataCategories, ['public_company_identity','public_business_information','public_source_provenance','published_role_based_corporate_channel']) ||
        !integer(dossier.maximumAccounts, 0, 3) || dossier.maximumContacts !== 0 ||
        dossier.maximumExternalActions !== 0 || dossier.maximumBudgetUsd !== 0.5 ||
        dossier.providerCreditSpendAllowed !== false || dossier.internetAccessAllowed !== false ||
        dossier.contactPermitted !== false || dossier.crmWriteAllowed !== false ||
        typeof dossier.authorizationRequired !== 'boolean' || dossier.missionCreated !== false ||
        dossier.productionGate !== 'blocked' || dossier.externalActions !== 0) throw new Error('fields')

    const accounts = array(dossier.accounts)
    if (accounts.length !== dossier.eligibleAccountCount || accounts.length !== dossier.maximumAccounts) throw new Error('counts')
    const slots = new Set<number>()
    for (const candidate of accounts) {
      const account = object(candidate)
      exactKeys(account, ['slot','companyName','sourceUrl','decision','decisionVersion'])
      if (!integer(account.slot, 1, 3) || slots.has(account.slot as number) || !text(account.companyName) ||
          !httpsUrl(account.sourceUrl) || !['accepted_internal','revised_internal'].includes(text(account.decision)) ||
          !integer(account.decisionVersion, 1, Number.MAX_SAFE_INTEGER)) throw new Error('account')
      slots.add(account.slot as number)
    }
    if (accounts.some((account, index) => index > 0 && Number((accounts[index - 1] as Record<string, unknown>).slot) >= Number((account as Record<string, unknown>).slot))) throw new Error('order')

    if (dossier.status === 'review_incomplete' && (dossier.reviewCompleted !== false || accounts.length !== 0 || dossier.authorizationRequired !== false)) throw new Error('incomplete')
    if (dossier.status === 'no_eligible_accounts' && (dossier.reviewCompleted !== true || accounts.length !== 0 || dossier.authorizationRequired !== false)) throw new Error('empty')
    if (dossier.status === 'authorization_required' && (dossier.reviewCompleted !== true || accounts.length < 1 || dossier.authorizationRequired !== true)) throw new Error('authorization')

    const provenance = object(dossier.provenance)
    exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
    if (provenance.source !== 'control-broker' || provenance.sourceId !== `a1-research-dossier:${dossier.reviewId}` ||
        !validDate(provenance.observedAt) || provenance.synthetic !== false) throw new Error('provenance')
    return value as A1ResearchDossier
  } catch {
    throw new Error('A1_RESEARCH_DOSSIER_INVALID')
  }
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object'); return value as Record<string, unknown> }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('array'); return value }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length }
function exactArray(value: unknown, expected: string[]): boolean { return Array.isArray(value) && value.length === expected.length && value.every((item,index) => item === expected[index]) }
function exactKeys(value: Record<string, unknown>, expected: string[]): void { const actual=Object.keys(value).sort(), wanted=[...expected].sort(); if (actual.length !== wanted.length || actual.some((key,index)=>key!==wanted[index])) throw new Error('keys') }
function validDate(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function httpsUrl(value: unknown): boolean { try { const url=new URL(text(value)); return url.protocol === 'https:' && Boolean(url.hostname) } catch { return false } }
