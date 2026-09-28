import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { BOT_PAUSED_BY_TAG_PESSOA } from '@/lib/lead-tags'
import { notifyNaoResponder } from '@/lib/nao-responder'

/**
 * Aplica o efeito colateral da tag especial "pessoa".
 *
 * O UPDATE e sua condição formam um CAS: uma pausa ausente (ou uma pausa
 * anterior desta mesma feature) pode ser gravada/reafirmada, mas uma pausa
 * concorrente de qualquer outro motivo nunca é sobrescrita. Reafirmar uma
 * pausa de tag:pessoa renova botPausedAt de propósito; o DELETE usa esse
 * timestamp como identidade da pausa para se proteger do cenário ABA.
 */
export async function pauseBotForPessoaTag(lead: {
  id: number
  phone: string | null
  channel: string | null
}): Promise<{ warning?: string }> {
  const now = new Date()

  await db
    .update(recoveryLeads)
    .set({
      botPaused: true,
      botPausedAt: now,
      botPausedBy: BOT_PAUSED_BY_TAG_PESSOA,
      updatedAt: now,
    })
    .where(and(
      eq(recoveryLeads.id, lead.id),
      or(
        eq(recoveryLeads.botPaused, false),
        isNull(recoveryLeads.botPaused),
        eq(recoveryLeads.botPausedBy, BOT_PAUSED_BY_TAG_PESSOA),
      ),
    ))

  const result = await notifyNaoResponder(lead.phone, 'marcar', lead.channel)
  return result.ok ? {} : { warning: result.warning }
}
