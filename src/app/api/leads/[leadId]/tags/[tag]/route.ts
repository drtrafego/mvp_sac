export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
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
 *
 * ‼️ QA (25/09/2026, CRÍTICO, ABA): comparar só o VALOR de botPausedBy
 * ('tag:pessoa') não basta, porque é uma string constante que não distingue
 * ENTRE pausas diferentes com o mesmo motivo. Cenário real: DELETE A lê
 * botPausedBy='tag:pessoa', entra no await acima; ENQUANTO espera, um POST B
 * re-adiciona a tag "pessoa" no MESMO lead (uso legítimo, ex. desmarcar e
 * remarcar rápido) — o POST SEMPRE regrava botPausedBy='tag:pessoa' E um
 * botPausedAt NOVO. Quando A termina de esperar, um CAS que só olha o valor
 * de botPausedBy erra: a string nunca mudou, então A desfaz a pausa de B por
 * cima. Por isso o CAS também trava na IDENTIDADE daquela pausa específica
 * (botPausedAt capturado no início, antes do await): um re-tag durante a
 * espera sempre produz um botPausedAt diferente, o CAS deixa de casar, e cai
 * no caminho de leitura fresca (não mexe na pausa nova).
 */
export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId, tag: rawTagParam } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const tag = normalizeTag(decodeURIComponent(rawTagParam))
  if (!tag) return NextResponse.json({ error: 'Tag inválida' }, { status: 400 })

  const scopeChannelParam = req.nextUrl.searchParams.get('scopeChannel')

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const deleteCondition = scopeChannelParam
    ? and(eq(leadTags.leadId, id), eq(leadTags.tag, tag), eq(leadTags.scopeChannel, scopeChannelParam))
    : and(eq(leadTags.leadId, id), eq(leadTags.tag, tag))

  const [deleted] = await db
    .delete(leadTags)
    .where(deleteCondition)
    .returning()

  if (!deleted) return NextResponse.json({ error: 'Tag não encontrada neste lead' }, { status: 404 })

  let warning: string | undefined
  let botPaused = lead.botPaused

  if (tag === PESSOA_TAG) {
    // Capturado ANTES do await: identidade da pausa específica que este
    // DELETE está autorizado a desfazer. Se um POST concorrente re-tagear
    // "pessoa" enquanto esperamos, ele grava um botPausedAt novo — e esse
    // valor capturado aqui vai deixar de bater com o do banco no CAS abaixo.
    const capturedBotPausedAt = lead.botPausedAt

    const result = await notifyNaoResponder(lead.phone, 'desmarcar', lead.channel)
    if (!result.ok) warning = result.warning

    // Compare-and-swap: a condição é repetida no WHERE (não só checada em
    // memória antes do await acima), pra não reativar o bot por cima de uma
    // pausa concorrente que apareceu enquanto esperávamos a Nina responder.
    // Além do VALOR de botPausedBy, trava também na IDENTIDADE da pausa
    // (botPausedAt capturado): duas pausas por "tag:pessoa" em momentos
    // diferentes (ABA) têm timestamps diferentes, então um re-tag no meio do
    // await nunca é desfeito por este DELETE.
    const [updated] = await db
      .update(recoveryLeads)
      .set({
        botPaused: false,
        botPausedAt: null,
        botPausedBy: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(recoveryLeads.id, id),
        eq(recoveryLeads.botPausedBy, BOT_PAUSED_BY_TAG_PESSOA),
        capturedBotPausedAt === null
          ? isNull(recoveryLeads.botPausedAt)
          : eq(recoveryLeads.botPausedAt, capturedBotPausedAt),
      ))
      .returning()

    if (updated) {
      botPaused = updated.botPaused
    } else {
      // Ninguém foi afetado: ou já não estava pausado por 'tag:pessoa', ou
      // outra coisa mudou o estado durante o await — outro motivo assumiu
      // (anti-loop, pausa manual) OU um re-tag "pessoa" concorrente criou
      // uma pausa NOVA (mesmo motivo, botPausedAt diferente, cenário ABA).
      // Leitura fresca do banco, nunca o valor otimista de `lead`.
      const [fresh] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, id))
      botPaused = fresh?.botPaused ?? lead.botPaused
    }
  }

  const tags = await db.select().from(leadTags).where(eq(leadTags.leadId, id))

  return NextResponse.json({ ok: true, tags, botPaused, warning })
}
