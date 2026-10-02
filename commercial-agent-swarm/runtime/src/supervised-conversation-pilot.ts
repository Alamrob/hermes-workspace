import type { ChatwootConversationSnapshot } from './comms/chatwoot-outbound.js'
import type { CommercialFact } from './commercial-fact-authority.js'
import {
  compileSupervisedMasterCase,
  type ObservableOutcome,
  type SupervisedMasterCase,
  type SupervisedMasterInput,
} from './supervised-conversation-master.js'

const DECIMAL = /^[1-9][0-9]{0,18}$/
const SHA256 = /^[0-9a-f]{64}$/

/** The pilot is intentionally unable to send, assign or mutate Chatwoot. */
export interface SupervisedConversationReader {
  snapshot(conversationId: string, messageId: string, expectedContentSha256: string): Promise<ChatwootConversationSnapshot>
}

export interface SupervisedReviewWriter {
  createPrivateNote(conversationId: string, content: string): Promise<{ message_id: string }>
  assignTeam(conversationId: string, teamId: string): Promise<{ team_id: string }>
}

export interface SupervisedConversationPilotInput {
  conversation_id: string
  message_id: string
  content_sha256: string
  authorized_facts: readonly Readonly<CommercialFact>[]
  observable_outcome?: ObservableOutcome
  capabilities: Omit<SupervisedMasterInput['capabilities'], 'chatwoot_read'>
}

export type SupervisedConversationPilotResult = Readonly<
  | { status: 'draft_ready'; case_file: Readonly<SupervisedMasterCase>; review_note: string }
  | { status: 'held'; case_ref: string; reason: 'human_already_replied' | 'target_not_current' }
>

/**
 * Reads one pinned snapshot and either compiles a review-only case or holds it.
 * It performs no retry and its dependency surface has no mutation method.
 */
export async function runSupervisedConversationPilot(
  reader: SupervisedConversationReader,
  input: SupervisedConversationPilotInput,
): Promise<SupervisedConversationPilotResult> {
  if (!reader || typeof reader.snapshot !== 'function' || !DECIMAL.test(input.conversation_id)
    || !DECIMAL.test(input.message_id) || !SHA256.test(input.content_sha256))
    throw new Error('SUPERVISED_PILOT_INPUT_INVALID')
  const caseRef = `cw:${input.conversation_id}:${input.message_id}`
  const snapshot = await reader.snapshot(input.conversation_id, input.message_id, input.content_sha256)
  if (snapshot.human_replied) return Object.freeze({ status: 'held', case_ref: caseRef, reason: 'human_already_replied' })
  if (!snapshot.current) return Object.freeze({ status: 'held', case_ref: caseRef, reason: 'target_not_current' })
  const caseFile = compileSupervisedMasterCase({
    case_ref: caseRef,
    transcript: snapshot.transcript.map(message => ({ kind: message.kind, content: message.content })),
    authorized_facts: input.authorized_facts,
    observable_outcome: input.observable_outcome,
    capabilities: { ...input.capabilities, chatwoot_read: true },
  })
  return Object.freeze({ status: 'draft_ready', case_file: caseFile, review_note: formatSupervisedReviewNote(caseFile) })
}

export function formatSupervisedReviewNote(caseFile: Readonly<SupervisedMasterCase>): string {
  if (caseFile.send_permitted !== false || caseFile.automatic_reply_permitted !== false
    || caseFile.human_review_required !== true) throw new Error('SUPERVISED_REVIEW_CASE_UNSAFE')
  const values = [
    '[REVISIÓN HUMANA OBLIGATORIA]',
    `Caso: ${caseFile.case_ref}`,
    `Motivo: ${caseFile.contact_reason}`,
    `Objetivo: ${caseFile.customer_objective}`,
    `Recomendación: ${caseFile.recommendation}`,
    `Borrador no enviado: ${caseFile.suggested_response}`,
    `Siguiente acción: ${caseFile.next_action}`,
    `Derivación: ${caseFile.handoff_reason}`,
    `Hechos aplicados: ${caseFile.applied_fact_ids.length > 0 ? caseFile.applied_fact_ids.join(',') : 'ninguno'}`,
    'Envío automático: BLOQUEADO',
  ]
  const note = values.join('\n')
  if (Buffer.byteLength(note, 'utf8') > 2000 || note.includes('\0')) throw new Error('SUPERVISED_REVIEW_NOTE_TOO_LARGE')
  return note
}

export async function stageSupervisedReview(
  writer: SupervisedReviewWriter,
  conversationId: string,
  result: Extract<SupervisedConversationPilotResult, { status: 'draft_ready' }>,
): Promise<Readonly<{ note_message_id: string; team_assigned: boolean }>> {
  if (!writer || typeof writer.createPrivateNote !== 'function' || typeof writer.assignTeam !== 'function'
    || !DECIMAL.test(conversationId) || result.case_file.human_review_required !== true
    || result.case_file.send_permitted !== false || result.case_file.automatic_reply_permitted !== false)
    throw new Error('SUPERVISED_REVIEW_STAGE_INVALID')
  const note = await writer.createPrivateNote(conversationId, result.review_note)
  if (!DECIMAL.test(note.message_id)) throw new Error('SUPERVISED_REVIEW_NOTE_RESULT_INVALID')
  if (result.case_file.next_action !== 'human_handoff')
    return Object.freeze({ note_message_id: note.message_id, team_assigned: false })
  const assignment = await writer.assignTeam(conversationId, '1')
  if (assignment.team_id !== '1') throw new Error('SUPERVISED_REVIEW_ASSIGNMENT_RESULT_INVALID')
  return Object.freeze({ note_message_id: note.message_id, team_assigned: true })
}
