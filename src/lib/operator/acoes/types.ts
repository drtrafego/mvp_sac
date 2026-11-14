import type { sacOperatorActions } from '../schema'
import type { OperatorJob } from '../service'
export type Ator = { companyId: number; userId: string; role: string; actorName: string; companySlug: string }
export type LeadAlvo = { id: number; pipelineStageBruto: string | null; etapaEfetiva: string; contextVersion: number; rotulo: string; telefoneFinal: string | null }
export type Esclarecimento = { tipo: 'lead'; candidatos: Array<{ leadId: number; rotulo: string; telefoneFinal: string | null; etapa: string }> } | { tipo: 'etapa'; termo: string; opcoes: Array<{ id: string; label: string }> }
export type ActionRequest = { referencia: string; etapa?: string; etapaId?: string | null; texto?: string; textoReescrito?: boolean; leadId?: number; rotulo?: string; resumo: string; execucao: 'direto'; esclarecimento?: Esclarecimento; desfazDe?: string; noteId?: number; semEfeito?: boolean }
export type Snapshot = { pipelineStage?: string | null; etapaEfetiva?: string; contextVersion?: number; noteId?: number; erro?: string; semEfeito?: boolean }
export type PreparedAction = Omit<typeof sacOperatorActions.$inferSelect, 'requestJson' | 'beforeSnapshot' | 'afterSnapshot'> & { requestJson: ActionRequest; beforeSnapshot: Snapshot | null; afterSnapshot: Snapshot | null }
export type FlowOutcome = Pick<OperatorJob, 'status' | 'waitingReason' | 'planHash' | 'confirmationExpiresAt' | 'resultText' | 'resultJson' | 'errorCode'>
export type JobView = Pick<OperatorJob, 'id' | 'status' | 'waitingReason' | 'resultText' | 'errorCode' | 'confirmationExpiresAt'>
export type ActionView = { id: string; tipo: string; status: string; resumo: string; erro?: string; erroDesfazer?: string; podeDesfazer: boolean; desfeita: boolean; esclarecimento?: Esclarecimento }
