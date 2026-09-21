// Dedup de mensagem inbound contra reentrega de webhook da Meta (Instagram e
// WhatsApp). Reentrega é comportamento real e documentado da Meta, não
// hipotético: sem isso, o mesmo evento reentregue grava duas linhas inbound
// iguais e generateAndSendAiReply() dispara DUAS respostas reais pro mesmo
// cliente pra mesma mensagem.
//
// Duas camadas:
// 1. isInboundMessageAlreadyProcessed() — SELECT antes do INSERT, cobre o
//    caso comum (reentrega chega depois que a primeira já foi processada).
// 2. índice único parcial whatsapp_messages_inbound_external_id_unique em
//    (channel, external_id), só pra direction='inbound' (ver src/lib/db/schema.ts).
//    Fecha a corrida entre duas requisições concorrentes que passam pelo
//    SELECT ao mesmo tempo. isUniqueViolation() detecta essa violação no
//    catch do insert pra tratar como "já processado", não como erro fatal.

import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { whatsappMessages } from '@/lib/db/schema'

export async function isInboundMessageAlreadyProcessed(
  companyId: number,
  externalId: string | null | undefined,
): Promise<boolean> {
  if (!externalId) return false
  const [existing] = await db
    .select({ id: whatsappMessages.id })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, companyId),
        eq(whatsappMessages.externalId, externalId),
        eq(whatsappMessages.direction, 'inbound'),
      ),
    )
    .limit(1)
  return !!existing
}

// Código de erro do Postgres pra unique_violation (23505). O driver
// @neondatabase/serverless lança NeonDbError com .code já nesse formato
// (mesma convenção do node-postgres), MAS o drizzle-orm envelopa todo erro
// do driver numa exceção própria ("Failed query: ...") e guarda o erro
// original em `.cause`, então `.code` não fica no nível raiz. Confirmado
// batendo de frente num teste E2E local com requisições concorrentes de
// verdade (sem isso, a corrida era detectada pelo Postgres mas o código caía
// no catch genérico da rota em vez de tratar como "já processado", abortando
// o resto do batch do webhook em vez de só pular a mensagem duplicada).
function unwrapErrorCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 5) return undefined
  const code = (err as { code?: string }).code
  if (typeof code === 'string') return code
  const cause = (err as { cause?: unknown }).cause
  return cause ? unwrapErrorCode(cause, depth + 1) : undefined
}

export function isUniqueViolation(err: unknown): boolean {
  return unwrapErrorCode(err) === '23505'
}
