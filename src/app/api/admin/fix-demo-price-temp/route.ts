import { NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { whatsappMessages } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

// Rota TEMPORÁRIA (24/09/2026): a resposta seedada de "Quanto custa?" na
// empresa demo (5329) mencionava preço (R$ 297/mês), e o anúncio que vai
// usar essa gravação não pode mostrar preço de plano. Troca só essa
// mensagem, mantém as outras 12 intactas. Descartável.
const DEMO_PHONE = 'demo_5511900000001'
const OLD_TEXT = 'Oi! Nosso plano começa em R$ 297/mês, com 7 dias grátis pra testar. Quer que eu te mande o link?'
const NEW_TEXT = 'Oi! Te explico rapidinho como funciona e você testa 7 dias grátis. Quer que eu te mande o link?'

export async function POST() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const updated = await db
    .update(whatsappMessages)
    .set({ content: NEW_TEXT })
    .where(and(eq(whatsappMessages.phone, DEMO_PHONE), eq(whatsappMessages.content, OLD_TEXT)))
    .returning({ id: whatsappMessages.id })

  return NextResponse.json({ ok: true, updatedCount: updated.length })
}
