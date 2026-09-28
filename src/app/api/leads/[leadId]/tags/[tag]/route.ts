export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { normalizeTag, PESSOA_TAG, BOT_PAUSED_BY_TAG_PESSOA, isLeadChannel } from '@/lib/lead-tags'
import { notifyNaoResponder } from '@/lib/nao-responder'

type Params = { params: Promise<{ leadId: string; tag: string }> }

/**
 * DELETE /api/leads/[leadId]/tags/[tag]
 *
 * Remove uma tag do lead. Se for a ÚLTIMA variante de "pessoa": avisa a
 * ponte da Nina pra voltar a responder (efeito não-bloqueante, mesmo
 * tratamento de falha do POST) e SÓ reverte botPaused=false quando
 * botPausedBy for exatamente 'tag:pessoa' — a pausa que ESTA feature causou.
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
 * cima. Por isso o CAS trava na IDENTIDADE da pausa observada DEPOIS do
 * DELETE e da confirmação de que não resta nenhuma variante (botPausedAt
 * relido antes do await): um re-tag posterior produz outro timestamp e o CAS
 * deixa de casar. A releitura tardia também inclui um POST idempotente que
 * tenha renovado a pausa antes do DELETE físico remover a linha existente.
 */
export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId, tag: rawTagParam } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const tag = normalizeTag(decodeURIComponent(rawTagParam))
  if (!tag) return NextResponse.json({ error: 'Tag inválida' }, { status: 400 })

  const rawScopeChannel = req.nextUrl.searchParams.get('scopeChannel')
  if (rawScopeChannel !== null && !isLeadChannel(rawScopeChannel)) {
    return NextResponse.json({ error: 'Canal de escopo inválido' }, { status: 400 })
  }

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const [deleted] = await db
    .delete(leadTags)
    .where(and(
      eq(leadTags.leadId, id),
      eq(leadTags.tag, tag),
      rawScopeChannel === null
        ? isNull(leadTags.scopeChannel)
        : eq(leadTags.scopeChannel, rawScopeChannel),
    ))
    .returning()

  if (!deleted) return NextResponse.json({ error: 'Tag não encontrada neste lead' }, { status: 404 })

  let warning: string | undefined
  let botPaused = lead.botPaused

  if (tag === PESSOA_TAG) {
    // Geral e variantes por canal podem coexistir. Remover uma linha não
    // encerra o handoff enquanto qualquer outra tag "pessoa" ainda cobrir o
    // lead; nesse caso não avisa a Nina nem toca na pausa/CAS.
    const [remainingPessoaTag] = await db
      .select({ id: leadTags.id })
      .from(leadTags)
      .where(and(eq(leadTags.leadId, id), eq(leadTags.tag, PESSOA_TAG)))
      .limit(1)

    if (remainingPessoaTag) {
      const tags = await db.select().from(leadTags).where(eq(leadTags.leadId, id))
      return NextResponse.json({ ok: true, tags, botPaused })
    }

    // A decisão de encerrar o handoff só pôde ser tomada depois da consulta
    // acima. O snapshot do CAS também precisa ser desta janela tardia: um
    // POST idempotente pode ter renovado botPausedAt entre a leitura inicial
    // do lead e o DELETE físico (quando a linha antiga ainda existia). Nesse
    // caso a tag acabou de ser removida e esta pausa renovada ficou órfã, por
    // isso deve ser desfeita. Um POST posterior a ESTE snapshot continua
    // protegido pelo CAS de botPausedBy + botPausedAt abaixo.
    const [pauseSnapshot] = await db
      .select({
        botPaused: recoveryLeads.botPaused,
        botPausedBy: recoveryLeads.botPausedBy,
        botPausedAt: recoveryLeads.botPausedAt,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.id, id))

    if (pauseSnapshot) botPaused = pauseSnapshot.botPaused

    // Fecha a pequena janela entre a primeira confirmação de ausência e a
    // releitura da pausa. Se um POST inteiro (insert + pause) terminou nesse
    // intervalo, a linha reapareceu e este DELETE já não deve encerrar o
    // handoff. Depois desta segunda checagem, qualquer POST novo renovará o
    // timestamp após o snapshot e será barrado pelo CAS.
    const [pessoaTagAfterSnapshot] = await db
      .select({ id: leadTags.id })
      .from(leadTags)
      .where(and(eq(leadTags.leadId, id), eq(leadTags.tag, PESSOA_TAG)))
      .limit(1)

    if (pessoaTagAfterSnapshot) {
      const tags = await db.select().from(leadTags).where(eq(leadTags.leadId, id))
      return NextResponse.json({ ok: true, tags, botPaused })
    }

    const result = await notifyNaoResponder(lead.phone, 'desmarcar', lead.channel)
    if (!result.ok) warning = result.warning

    // Compare-and-swap: a condição é repetida no WHERE (não só checada em
    // memória antes do await acima), pra não reativar o bot por cima de uma
    // pausa concorrente que apareceu enquanto esperávamos a Nina responder.
    // Além do VALOR de botPausedBy, trava também na IDENTIDADE da pausa
    // (botPausedAt relido): duas pausas por "tag:pessoa" em momentos
    // diferentes (ABA) têm timestamps diferentes, então um re-tag no meio do
    // await nunca é desfeito por este DELETE.
    const [updated] = pauseSnapshot?.botPausedBy === BOT_PAUSED_BY_TAG_PESSOA
      ? await db
          .update(recoveryLeads)
          .set({
            botPaused: false,
            botPausedAt: null,
            botPausedBy: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(recoveryLeads.id, id),
            eq(recoveryLeads.botPausedBy, pauseSnapshot.botPausedBy),
            pauseSnapshot.botPausedAt === null
              ? isNull(recoveryLeads.botPausedAt)
              : eq(recoveryLeads.botPausedAt, pauseSnapshot.botPausedAt),
          ))
          .returning()
      : []

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
