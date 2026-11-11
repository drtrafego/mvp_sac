import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { queryAgentsDb } from '@/lib/db/agents-db'
import { getPauseSwitchMap } from '@/lib/bot-pause'

/**
 * Espelho da pausa do SAC no banco central que a Gabi (Gramado Plaza) lê.
 *
 * POR QUE EXISTE (11/11/2026, ordem do Gastão: "todos os bots têm que passar
 * pelo SAC, o SAC é o coração e o cérebro dos bots"): "Pausar tudo", "Pausar
 * canal" e a pausa por lead do SAC só valiam para o que o próprio SAC envia. A
 * Gabi roda no servidor do restaurante (ponte uaz_bridge) e lê a pausa de
 * `public.agent_pause` (global) e `public.agent_chat_pause` (por conversa) no
 * banco central, a cada ~20 s. Quem escrevia ali era só o painel antigo, que
 * desde o cutover de 17/10 grava em OUTRO banco (Neon), então nem o botão
 * antigo alcançava a Gabi. O SAC já escreve nesse banco (followup_config), então
 * o caminho de menor risco é gravar as MESMAS linhas, sem tocar na ponte.
 *
 * REGRA DE QUEM MANDA (a mesma está em LEIA-ME.txt da execução 2026-11-11_gabi_pausa-do-sac):
 *  1. Qualquer fonte pausada cala a Gabi (união): linha do SAC, pausa geral,
 *     pausa_global.json, paused.json (handoff do bot ou dono no celular).
 *  2. Quem pausou é quem libera. O SAC só mexe em linha cujo `por` começa com
 *     'sac:'. Nunca grava `paused=false` por conversa: a ponte lê `false`
 *     explícito como "o painel despausou" e APAGA a pausa local que o dono do
 *     restaurante pode ter posto no celular. Liberar = apagar a PRÓPRIA linha.
 *  3. Pausa do SAC não expira sozinha (expira_pausa.py pula linhas 'sac:').
 *  4. Divergência cai para o lado do silêncio, nunca do envio.
 *
 * Nada aqui lança: o chamador (rotas de pausa, cron) recebe o resultado e
 * decide. A pausa do SAC em si já foi gravada antes; falha aqui significa "o
 * SAC pausou, a Gabi ainda NÃO soube", e o resultado diz isso com clareza.
 */

export const GABI_COMPANY_SLUG = 'gramado-plaza'
export const GABI_AGENT_SLUG = 'gramadoplazza'
/** Marca em `por`: identifica linhas que o SAC escreveu (e que só o SAC apaga). */
export const GABI_SAC_MARK = 'sac:'

export interface GabiMirrorResult {
  /** false = a Gabi pode NÃO ter sabido da mudança (erro de banco). */
  ok: boolean
  /** Motivo de não ter feito nada (empresa/canal/telefone que não é da Gabi). */
  skipped?: string
  /** Texto curto para o operador/log; nunca contém telefone inteiro. */
  detail?: string
}

export function isGabiCompany(companySlug: string | null | undefined): boolean {
  return (companySlug || '').toLowerCase().trim() === GABI_COMPANY_SLUG
}

/** Mesma conta que a ponte faz (`so_digitos`): só dígitos. Sem inventar DDI. */
export function gabiChatId(channel: string | null | undefined, phone: string | null | undefined): string | null {
  if ((channel || 'whatsapp').toLowerCase() !== 'whatsapp') return null
  const digits = (phone || '').replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

/**
 * Chaves sob as quais a ponte pode conhecer a MESMA conversa. A ponte compara
 * o chat_id por IGUALDADE de dígitos, e no banco central há celulares do Brasil
 * com 13 dígitos (com o 9) e com 12 (sem o 9, é o JID que a UazAPI entrega para
 * contas antigas). Se o lead do SAC tem uma forma e o JID a outra, gravar só a do
 * lead não pausaria ninguém. Para celular brasileiro (55 + DDD + [9] + 8 dígitos,
 * assinante começando em 6-9) gravamos AS DUAS formas; qualquer outro número, só a
 * dele. Liberar apaga as duas. Fixo (2 dígitos 55+DDD) nunca ganha 9.
 */
export function gabiChatIds(channel: string | null | undefined, phone: string | null | undefined): string[] {
  const id = gabiChatId(channel, phone)
  if (!id) return []
  // 13 digitos: a forma sem o 9 so existe se o assinante resultante tambem e de celular (6-9); se nao,
  // seria um numero FIXO (outra pessoa), ex.: 5551931234567 NAO gera 555131234567.
  if (id.startsWith('55') && id.length === 13 && id[4] === '9' && '6789'.includes(id[5])) return [id, id.slice(0, 4) + id.slice(5)]
  if (id.startsWith('55') && id.length === 12 && '6789'.includes(id[4])) return [id, id.slice(0, 4) + '9' + id.slice(4)]
  return [id]
}

function por(kind: 'geral' | 'lead', by?: string | null): string {
  const quem = (by || '').replace(/[^\p{L}\p{N} ._()@-]/gu, '').trim().slice(0, 60)
  return `${GABI_SAC_MARK}${kind}${quem ? `:${quem}` : ''}`
}

function mask(chatId: string): string {
  return `…${chatId.slice(-3)}`
}

/**
 * Pausa GERAL da Gabi = chave 'all' OU 'whatsapp' da empresa no SAC (a Gabi só
 * fala WhatsApp; instagram/email não a afetam). Lê as chaves e grava o estado
 * resultante, então é idempotente e serve de reconciliação.
 */
export async function syncGabiGlobalPause(company: { id: number; slug: string }): Promise<GabiMirrorResult> {
  if (!isGabiCompany(company.slug)) return { ok: true, skipped: 'empresa sem bot espelhado' }
  try {
    const map = await getPauseSwitchMap(company.id)
    const ativo = map.all.active || map.whatsapp.active
    const pausadoPor = map.all.active ? map.all.pausedBy : map.whatsapp.pausedBy
    if (ativo) {
      // Se OUTRA origem já tinha pausado a geral (painel antigo, pausar.sh grava
      // arquivo, não aqui), o `por` dela é mantido: quem pausou é quem libera.
      const r = await queryAgentsDb(
        `INSERT INTO public.agent_pause (agent_slug, paused, por, updated_at)
         VALUES ($1, true, $2, now())
         ON CONFLICT (agent_slug) DO UPDATE SET
           paused = true,
           por = CASE WHEN public.agent_pause.paused AND coalesce(public.agent_pause.por, '') NOT LIKE $3
                      THEN public.agent_pause.por ELSE EXCLUDED.por END,
           updated_at = now()`,
        [GABI_AGENT_SLUG, por('geral', pausadoPor), `${GABI_SAC_MARK}%`],
      )
      if (r === null) return { ok: false, detail: 'pausa geral gravada no SAC, mas NÃO chegou na Gabi (banco central)' }
      return { ok: true, detail: 'pausa geral enviada à Gabi' }
    }
    const r = await queryAgentsDb(
      `UPDATE public.agent_pause SET paused = false, por = $2, updated_at = now()
       WHERE agent_slug = $1 AND paused AND coalesce(por, '') LIKE $3
       RETURNING agent_slug`,
      [GABI_AGENT_SLUG, `${GABI_SAC_MARK}liberado`, `${GABI_SAC_MARK}%`],
    )
    if (r === null) return { ok: false, detail: 'pausa geral liberada no SAC, mas a Gabi NÃO soube (banco central); ela segue pausada' }
    if (r.length > 0) return { ok: true, detail: 'pausa geral liberada na Gabi' }
    const resto = await queryAgentsDb(
      `SELECT paused FROM public.agent_pause WHERE agent_slug = $1`, [GABI_AGENT_SLUG],
    )
    if (resto && resto[0] && (resto[0] as { paused?: boolean }).paused) {
      return { ok: true, detail: 'a Gabi continua com pausa geral de OUTRA origem (não é do SAC); só quem pausou libera' }
    }
    return { ok: true, detail: 'a Gabi já estava sem pausa geral' }
  } catch (err) {
    console.error('[gabi-pause] pausa geral falhou:', err instanceof Error ? err.message : err)
    return { ok: false, detail: 'erro ao espelhar a pausa geral na Gabi' }
  }
}

/** Pausa/libera UMA conversa da Gabi. Liberar apaga só a linha que o SAC escreveu. */
export async function mirrorGabiLeadPause(input: {
  company: { id: number; slug: string }
  channel: string | null | undefined
  phone: string | null | undefined
  paused: boolean
  by?: string | null
  /** id do lead sendo pausado/liberado: na liberacao, as formas do numero que OUTRO lead pausado ainda usa ficam. */
  leadId?: number | null
}): Promise<GabiMirrorResult> {
  if (!isGabiCompany(input.company.slug)) return { ok: true, skipped: 'empresa sem bot espelhado' }
  const ids = gabiChatIds(input.channel, input.phone)
  if (ids.length === 0) return { ok: true, skipped: 'lead sem WhatsApp válido para a Gabi' }
  const rotulo = mask(ids[0])
  try {
    if (input.paused) {
      // Sobrescreve inclusive uma pausa 'bot (handoff)' da própria Gabi: um
      // humano do SAC assumiu, então a pausa deixa de ser candidata a expirar.
      let falhou = false
      for (const id of ids) {
        const r = await queryAgentsDb(
          `INSERT INTO public.agent_chat_pause (agent_slug, chat_id, paused, por, updated_at)
           VALUES ($1, $2, true, $3, now())
           ON CONFLICT (agent_slug, chat_id) DO UPDATE SET paused = true, por = EXCLUDED.por, updated_at = now()`,
          [GABI_AGENT_SLUG, id, por('lead', input.by)],
        )
        if (r === null) falhou = true
      }
      if (falhou) return { ok: false, detail: `conversa ${rotulo} pausada no SAC, mas a Gabi NÃO soube (banco central)` }
      return { ok: true, detail: `conversa ${rotulo} pausada na Gabi` }
    }
    // A mesma pessoa pode ter 2 leads (um com 13 digitos e outro com 12): liberar um nao pode apagar a forma que o outro,
    // ainda pausado, usa. Se nao der para saber (erro ao ler os leads), NAO apaga: fica em silencio e o cron refaz.
    const mantidos = new Set<string>()
    try {
      const outros = await db
        .select({ id: recoveryLeads.id, phone: recoveryLeads.phone, channel: recoveryLeads.channel })
        .from(recoveryLeads)
        .where(and(
          eq(recoveryLeads.companyId, input.company.id),
          eq(recoveryLeads.botPaused, true),
          sql`coalesce(${recoveryLeads.botPausedAll}, false) = false`,
          sql`${recoveryLeads.botPausedChannel} is null`,
        ))
      for (const o of outros) {
        if (input.leadId != null && o.id === input.leadId) continue
        for (const k of gabiChatIds(o.channel, o.phone)) mantidos.add(k)
      }
    } catch (err) {
      console.error('[gabi-pause] nao consegui ler os outros leads pausados; nao libero:', err instanceof Error ? err.message : err)
      return { ok: false, detail: `conversa ${rotulo} liberada no SAC, mas a Gabi NÃO soube (não deu para conferir outros leads do mesmo número); ela segue pausada` }
    }
    let falhou = false
    let apagou = 0
    for (const id of ids) {
      if (mantidos.has(id)) continue
      const r = await queryAgentsDb(
        `DELETE FROM public.agent_chat_pause
         WHERE agent_slug = $1 AND chat_id = $2 AND coalesce(por, '') LIKE $3
         RETURNING chat_id`,
        [GABI_AGENT_SLUG, id, `${GABI_SAC_MARK}%`],
      )
      if (r === null) falhou = true
      else apagou += r.length
    }
    if (falhou) return { ok: false, detail: `conversa ${rotulo} liberada no SAC, mas a Gabi NÃO soube (banco central); ela segue pausada` }
    return {
      ok: true,
      detail: apagou > 0
        ? `conversa ${rotulo} liberada na Gabi (se o restaurante também a segura, ela segue em silêncio)`
        : `conversa ${rotulo}: nada do SAC para liberar na Gabi`,
    }
  } catch (err) {
    console.error('[gabi-pause] pausa por lead falhou:', err instanceof Error ? err.message : err)
    return { ok: false, detail: 'erro ao espelhar a pausa da conversa na Gabi' }
  }
}

/**
 * Data de ativação do espelho por lead (env GABI_PAUSE_MIRROR_SINCE, ISO 8601).
 * A reconciliação só CRIA linha para pausa individual feita nesta data ou depois.
 * Sem a variável (ou inválida) ela não cria nenhuma linha por lead.
 *
 * POR QUÊ: linhas 'sac:' não expiram. Hoje a Gabi ignora toda pausa do SAC; se o
 * primeiro reconcile espelhasse o ESTOQUE de leads que alguém pausou (ou que a
 * IA pausou) meses atrás, a Gabi passaria a calar essas pessoas para sempre. O
 * estoque antigo é só MEDIDO (campos `estoqueAntigo*` do retorno e do log do
 * cron) e tratado por decisão humana; o que acontece de agora em diante entra
 * pelas rotas com gancho (que não dependem desta data) e por este reconcile.
 */
const ISO_ESTRITO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const sinceJaLogados = new Set<string>()

/**
 * ISO 8601 ESTRITO, com hora e fuso: '2026-11-12T03:00:00Z'. Data solta ('2026-11-12') e formatos locais
 * ('12/11/2026', que o Date do JS leria como 11 de dezembro) sao RECUSADOS e logados (uma vez por valor), e o
 * efeito de um valor invalido e o mesmo de nao ter a variavel: nenhuma linha por lead e criada.
 */
export function gabiMirrorSince(env: string | undefined = process.env.GABI_PAUSE_MIRROR_SINCE): Date | null {
  if (!env) return null
  const bruto = env.trim()
  const d = ISO_ESTRITO.test(bruto) ? new Date(bruto) : new Date(NaN)
  if (Number.isNaN(d.getTime())) {
    if (!sinceJaLogados.has(bruto)) {
      sinceJaLogados.add(bruto)
      console.error(`[gabi-pause] GABI_PAUSE_MIRROR_SINCE invalida (${JSON.stringify(bruto.slice(0, 40))}): use ISO 8601 com hora e fuso, ex. 2026-11-12T03:00:00Z. Sem data valida NENHUMA pausa por lead e espelhada pelo reconcile.`)
    }
    return null
  }
  return d
}

export interface GabiReconcileResult {
  global: GabiMirrorResult
  inserted: number
  removed: number
  ok: boolean
  /** Leads WhatsApp com pausa individual no SAC que NÃO foram espelhados (anteriores à ativação ou sem data). */
  estoqueAntigo: number
  /** Idade em dias da pausa mais antiga entre eles (null se não há). */
  estoqueAntigoMaisAntigoDias: number | null
  since: string | null
}

/**
 * Reconciliação (cron): refaz o espelho a partir do estado do SAC. Cobre os
 * caminhos de pausa que não passam pelas rotas com gancho (tag pessoa, pausa
 * automática da IA, PATCH de lead, falha de banco no momento do clique).
 *
 *  - pausa geral: reaplica a chave;
 *  - por lead: só pausas INDIVIDUAIS (botPausedAll=false e sem canal) de leads
 *    WhatsApp, e só as feitas em/depois de GABI_PAUSE_MIRROR_SINCE (ver acima).
 *    Quem foi pausado em massa é coberto pela pausa geral e NÃO vira uma linha
 *    por lead (seriam milhares);
 *  - só cria/apaga linhas 'sac:'. Linhas do bot ou do painel nunca são tocadas;
 *  - uma linha 'sac:' só é apagada se o lead NÃO está mais pausado individualmente
 *    (a data de ativação não faz apagar linha de pausa que continua valendo).
 *  - `dryRun`: não escreve nada, só mede (estoque e o que criaria/apagaria).
 */
export async function reconcileGabiPause(
  company: { id: number; slug: string },
  opts: { dryRun?: boolean; since?: Date | null } = {},
): Promise<GabiReconcileResult> {
  const since = opts.since === undefined ? gabiMirrorSince() : opts.since
  const base: GabiReconcileResult = {
    global: { ok: true, skipped: 'empresa sem bot espelhado' },
    inserted: 0, removed: 0, ok: true, estoqueAntigo: 0, estoqueAntigoMaisAntigoDias: null,
    since: since ? since.toISOString() : null,
  }
  if (!isGabiCompany(company.slug)) return base
  const global: GabiMirrorResult = opts.dryRun ? { ok: true, detail: 'dryRun: pausa geral não reaplicada' } : await syncGabiGlobalPause(company)
  try {
    const leads = await db
      .select({ phone: recoveryLeads.phone, channel: recoveryLeads.channel, by: recoveryLeads.botPausedBy, at: recoveryLeads.botPausedAt })
      .from(recoveryLeads)
      .where(and(
        eq(recoveryLeads.companyId, company.id),
        eq(recoveryLeads.botPaused, true),
        sql`coalesce(${recoveryLeads.botPausedAll}, false) = false`,
        sql`${recoveryLeads.botPausedChannel} is null`,
      ))
    const todosPausados = new Set<string>()
    const criar = new Map<string, string | null>()
    let estoqueAntigo = 0
    let maisAntigo: number | null = null
    for (const l of leads) {
      const ids = gabiChatIds(l.channel, l.phone)
      if (ids.length === 0) continue
      for (const id of ids) todosPausados.add(id)
      if (since && l.at && l.at >= since) {
        for (const id of ids) criar.set(id, l.by ?? null)
      } else {
        estoqueAntigo += 1
        const dias = l.at ? Math.floor((Date.now() - l.at.getTime()) / 86_400_000) : null
        if (dias !== null && (maisAntigo === null || dias > maisAntigo)) maisAntigo = dias
      }
    }
    const medida = { estoqueAntigo, estoqueAntigoMaisAntigoDias: maisAntigo, since: base.since }
    const atual = await queryAgentsDb<{ chat_id: string }>(
      `SELECT chat_id FROM public.agent_chat_pause WHERE agent_slug = $1 AND paused AND coalesce(por, '') LIKE $2`,
      [GABI_AGENT_SLUG, `${GABI_SAC_MARK}%`],
    )
    if (atual === null) return { ...base, ...medida, global, ok: false }
    const jaTem = new Set(atual.map(r => String(r.chat_id)))
    let inserted = 0
    let removed = 0
    let ok = global.ok
    for (const [id, by] of criar) {
      if (jaTem.has(id)) continue
      if (opts.dryRun) { inserted += 1; continue }
      const r = await queryAgentsDb(
        `INSERT INTO public.agent_chat_pause (agent_slug, chat_id, paused, por, updated_at)
         VALUES ($1, $2, true, $3, now())
         ON CONFLICT (agent_slug, chat_id) DO UPDATE SET paused = true, por = EXCLUDED.por, updated_at = now()`,
        [GABI_AGENT_SLUG, id, por('lead', by)],
      )
      if (r === null) ok = false
      else inserted += 1
    }
    for (const id of jaTem) {
      if (todosPausados.has(id)) continue
      if (opts.dryRun) { removed += 1; continue }
      const r = await queryAgentsDb(
        `DELETE FROM public.agent_chat_pause WHERE agent_slug = $1 AND chat_id = $2 AND coalesce(por, '') LIKE $3`,
        [GABI_AGENT_SLUG, id, `${GABI_SAC_MARK}%`],
      )
      if (r === null) ok = false
      else removed += 1
    }
    return { global, inserted, removed, ok, ...medida }
  } catch (err) {
    console.error('[gabi-pause] reconciliação falhou:', err instanceof Error ? err.message : err)
    return { ...base, global, ok: false }
  }
}
