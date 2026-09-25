export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { normalizeTag, PESSOA_TAG, BOT_PAUSED_BY_TAG_PESSOA } from '@/lib/lead-tags'
import { notifyNaoResponder } from '@/lib/nao-responder'

type Params = { params: Promise<{ leadId: string; tag: string }> }

/**
 * DELETE /api/leads/[leadId]/tags/[tag]
 *
 * Remove uma tag do lead. Se a tag removida for "pessoa": avisa a ponte da
 * Nina pra voltar a responder (efeito não-bloqueante, mesmo tratamento de
 * falha do POST) e SÓ reverte botPaused=false quando botPausedBy for
 * exatamente 'tag:pessoa' — a pausa que ESTA feature causou.
 *
 * ‼️ Invariante importante: se o lead foi pausado por outro motivo nesse meio
 * tempo (atendente humano assumiu manualmente via /api/inbox/[leadId]/pause,
 * ou o anti-loop de bot-detector.ts), botPausedBy vai ter outro valor e este
 * endpoint NÃO mexe em botPaused/botPausedAt/botPausedBy — não pode reativar
 * o bot silenciosamente por cima de uma pausa com motivo diferente.
 *
 * ‼️ QA (25/09/2026, CRÍTICO, TOCTOU): NÃO decida com base no `lead` lido no
 * INÍCIO da função. O `await notifyNaoResponder(...)` pode levar até 5s
 * (timeout real), e nesse intervalo o anti-loop (src/lib/ai-reply.ts, roda em
 * TODA mensagem inbound) pode pausar o lead por outro motivo. O UPDATE final
 * é um compare-and-swap: só reativa o bot se botPausedBy AINDA for
 * 'tag:pessoa' NO MOMENTO do UPDATE (condição repetida no WHERE, não só
 * checada em memória antes do await). Se o CAS não afetar nenhuma linha, é
 * porque algo mudou botPausedBy durante a espera — a resposta reflete uma
 * LEITURA FRESCA do estado atual, nunca o valor otimista de antes do await.
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId, tag: rawTagParam } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const tag = normalizeTag(decodeURIComponent(rawTagParam))
  if (!tag) return NextResponse.json({ error: 'Tag inválida' }, { status: 400 })

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const [deleted] = await db
    .delete(leadTags)
    .where(and(eq(leadTags.leadId, id), eq(leadTags.tag, tag)))
    .returning()

  if (!deleted) return NextResponse.json({ error: 'Tag não encontrada neste lead' }, { status: 404 })

  let warning: string | undefined
  let botPaused = lead.botPaused

  if (tag === PESSOA_TAG) {
    const result = await notifyNaoResponder(lead.phone, 'desmarcar', lead.channel)
    if (!result.ok) warning = result.warning

    // Compare-and-swap: a condição é repetida no WHERE (não só checada em
    // memória antes do await acima), pra não reativar o bot por cima de uma
    // pausa concorrente que apareceu enquanto esperávamos a Nina responder.
    const [updated] = await db
      .update(recoveryLeads)
      .set({
        botPaused: false,
        botPausedAt: null,
        botPausedBy: null,
        updatedAt: new Date(),
      })
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.botPausedBy, BOT_PAUSED_BY_TAG_PESSOA)))
      .returning()

    if (updated) {
      botPaused = updated.botPaused
    } else {
      // Ninguém foi afetado: ou já não estava pausado por 'tag:pessoa', ou
      // outra coisa (anti-loop, pausa manual) mudou botPausedBy durante o
      // await. Leitura fresca do banco, nunca o valor otimista de `lead`.
      const [fresh] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, id))
      botPaused = fresh?.botPaused ?? lead.botPaused
    }
  }

  const tags = await db.select().from(leadTags).where(eq(leadTags.leadId, id))

  return NextResponse.json({ ok: true, tags, botPaused, warning })
}
