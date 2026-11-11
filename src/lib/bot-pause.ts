import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companyPauseSwitches, recoveryLeads } from '@/lib/db/schema'

/**
 * Chave persistente de pausa do bot, por empresa e escopo.
 *
 * Antes desta chave, "Pausar tudo" e "Pausar canal" faziam UPDATE só nos leads
 * que JÁ existiam. Lead novo nascia despausado e o comentário automático do
 * Instagram (processInstagramComment) nem consultava pausa, então a empresa
 * "pausada" continuava mandando mensagem de bot. Aqui a pausa passa a ser um
 * estado da empresa:
 *   - criação de lead herda a chave (getInheritedPauseFields);
 *   - todo envio automático consulta a chave E lead.botPaused (isBotBlocked).
 *
 * A pausa é do bot CONVERSACIONAL (IA respondendo, follow-up de IA, comentário
 * automático, upsell, disparo em massa). NÃO é do funil de evento da Kiwify da
 * Isabela: os jobs com jobType explícito da lista de permissão
 * (message-job-class.ts: TRANSACTIONAL_BYPASS_ALLOWLIST) passam por cima da
 * pausa GERADA pela chave/"Pausar tudo"/"Pausar canal". Pausa individual de
 * atendente e opt-out bloqueiam sempre. Para todo o resto a pausa vale como
 * antes. "Lead nasce pausado" significa "a IA não conversa com ele".
 *
 * Escopos: 'all' (geral) vale para qualquer canal; 'whatsapp', 'instagram' e
 * 'email' valem só para leads daquele canal (canal A pausado não afeta B).
 */
export const PAUSE_SWITCH_SCOPES = ['all', 'whatsapp', 'instagram', 'email'] as const
export type PauseSwitchScope = (typeof PAUSE_SWITCH_SCOPES)[number]

export interface PauseSwitchState {
  scope: PauseSwitchScope
  active: boolean
  pausedAt: Date | null
  pausedBy: string | null
  reason: string | null
}

export function isPauseSwitchScope(value: unknown): value is PauseSwitchScope {
  return typeof value === 'string' && (PAUSE_SWITCH_SCOPES as readonly string[]).includes(value)
}

/** Escopos que valem para um lead de `channel`: sempre 'all' + o próprio canal (se for um canal pausável). */
export function pauseScopesForChannel(channel: string | null | undefined): PauseSwitchScope[] {
  const ch = (channel || 'whatsapp').toLowerCase()
  return ch !== 'all' && isPauseSwitchScope(ch) ? ['all', ch] : ['all']
}

/** Puro: entre as chaves da empresa, a que bloqueia um lead do canal (geral antes do canal). */
export function pickBlockingSwitch(
  switches: PauseSwitchState[],
  channel: string | null | undefined,
): PauseSwitchState | null {
  const scopes = pauseScopesForChannel(channel)
  for (const scope of scopes) {
    const found = switches.find(sw => sw.scope === scope && sw.active)
    if (found) return found
  }
  return null
}

export interface InheritedPauseFields {
  botPaused: true
  botPausedAt: Date
  botPausedBy: string
  botPausedAll: boolean
  botPausedChannel: string | null
}

/**
 * Puro: campos de pausa que um lead novo (ou um lead existente que ainda não
 * estava pausado) recebe. 'all' marca botPausedAll (o "Reativar tudo" reverte);
 * escopo de canal marca botPausedChannel (o "Reativar canal" reverte).
 */
export function pauseFieldsFromSwitch(sw: PauseSwitchState, now: Date = new Date()): InheritedPauseFields {
  return {
    botPaused: true,
    botPausedAt: now,
    botPausedBy: sw.scope === 'all' ? 'auto (pausa geral ativa)' : `auto (canal ${sw.scope} pausado)`,
    botPausedAll: sw.scope === 'all',
    botPausedChannel: sw.scope === 'all' ? null : sw.scope,
  }
}

function rowToState(row: typeof companyPauseSwitches.$inferSelect): PauseSwitchState | null {
  if (!isPauseSwitchScope(row.scope)) return null
  return {
    scope: row.scope,
    active: row.active,
    pausedAt: row.pausedAt ?? null,
    pausedBy: row.pausedBy ?? null,
    reason: row.reason ?? null,
  }
}

/** Todas as chaves registradas da empresa (ligadas e desligadas). */
export async function listPauseSwitches(companyId: number): Promise<PauseSwitchState[]> {
  const rows = await db
    .select()
    .from(companyPauseSwitches)
    .where(eq(companyPauseSwitches.companyId, companyId))
  return rows.map(rowToState).filter((s): s is PauseSwitchState => s !== null)
}

/** Estado das quatro chaves, sempre completo (desligada quando não há linha). */
export async function getPauseSwitchMap(companyId: number): Promise<Record<PauseSwitchScope, PauseSwitchState>> {
  const rows = await listPauseSwitches(companyId)
  const map = {} as Record<PauseSwitchScope, PauseSwitchState>
  for (const scope of PAUSE_SWITCH_SCOPES) {
    map[scope] = rows.find(r => r.scope === scope) ?? {
      scope, active: false, pausedAt: null, pausedBy: null, reason: null,
    }
  }
  return map
}

/** Chave que bloqueia o canal da empresa agora, ou null. LANÇA em erro de banco: quem envia decide (fail-closed). */
export async function getBlockingPauseSwitch(
  companyId: number,
  channel: string | null | undefined,
): Promise<PauseSwitchState | null> {
  return pickBlockingSwitch(await listPauseSwitches(companyId), channel)
}

export type BotBlockReason = 'lead' | 'switch'

export interface BotBlockDecision {
  blocked: boolean
  reason: BotBlockReason | null
  scope?: PauseSwitchScope
}

/**
 * Decisão única para todo envio automático do bot. Bloqueia se o lead está
 * pausado OU se a chave da empresa/canal está ligada. Não captura erro de
 * banco de propósito: um envio automático nunca sai no escuro.
 */
export async function isBotBlocked(input: {
  companyId: number
  channel: string | null | undefined
  leadBotPaused?: boolean | null
}): Promise<BotBlockDecision> {
  if (input.leadBotPaused === true) return { blocked: true, reason: 'lead' }
  const sw = await getBlockingPauseSwitch(input.companyId, input.channel)
  if (sw) return { blocked: true, reason: 'switch', scope: sw.scope }
  return { blocked: false, reason: null }
}

/**
 * Campos de pausa para espalhar no `.values({...})` de qualquer INSERT em
 * recovery_leads. Nunca lança: se a leitura falhar, o lead nasce como hoje e
 * o guard de envio (isBotBlocked) continua barrando o bot.
 */
export async function getInheritedPauseFields(
  companyId: number,
  channel: string | null | undefined,
): Promise<Partial<InheritedPauseFields>> {
  try {
    const sw = await getBlockingPauseSwitch(companyId, channel)
    return sw ? pauseFieldsFromSwitch(sw) : {}
  } catch (err) {
    console.error('[bot-pause] falha ao ler chave de pausa para herdar no lead novo:', err instanceof Error ? err.message : err)
    return {}
  }
}

/**
 * Lead que já existia e ainda não estava pausado, tocado enquanto a chave
 * está ligada: passa a constar como pausado (a UI não mostra "ativo" um lead
 * que o bot não responde). Pausa individual existente nunca é sobrescrita.
 * Devolve o lead atualizado (ou o mesmo, se nada mudou). Nunca lança.
 */
export async function ensureLeadPausedBySwitch<
  L extends { id: number; companyId: number; channel?: string | null; botPaused?: boolean | null },
>(lead: L): Promise<L> {
  if (lead.botPaused === true) return lead
  try {
    const sw = await getBlockingPauseSwitch(lead.companyId, lead.channel)
    if (!sw) return lead
    const fields = pauseFieldsFromSwitch(sw)
    const [updated] = await db
      .update(recoveryLeads)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(recoveryLeads.id, lead.id), eq(recoveryLeads.botPaused, false)))
      .returning({ id: recoveryLeads.id })
    return updated ? ({ ...lead, ...fields } as L) : lead
  } catch (err) {
    console.error('[bot-pause] falha ao marcar lead existente como pausado pela chave:', err instanceof Error ? err.message : err)
    return lead
  }
}

/** Liga/desliga uma chave (upsert por empresa+escopo). */
export async function setPauseSwitch(input: {
  companyId: number
  scope: PauseSwitchScope
  active: boolean
  by: string
  reason?: string | null
}): Promise<void> {
  const now = new Date()
  const values = {
    companyId: input.companyId,
    scope: input.scope,
    active: input.active,
    pausedAt: input.active ? now : null,
    pausedBy: input.active ? input.by : null,
    reason: input.active ? input.reason ?? null : null,
    updatedAt: now,
  }
  await db
    .insert(companyPauseSwitches)
    .values(values)
    .onConflictDoUpdate({
      target: [companyPauseSwitches.companyId, companyPauseSwitches.scope],
      set: {
        active: values.active,
        pausedAt: values.pausedAt,
        pausedBy: values.pausedBy,
        reason: values.reason,
        updatedAt: now,
      },
    })
}
