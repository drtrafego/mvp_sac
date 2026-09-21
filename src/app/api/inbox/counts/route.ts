export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'

// Contagem real por canal (COUNT com FILTER, não em memória sobre um LIMIT).
// A lista principal (/api/inbox) corta em 200 registros por aba de canal;
// esta rota conta a empresa inteira, então os números da aba batem com o
// banco mesmo quando o canal tem mais de 200 conversas.
export async function GET(): Promise<NextResponse> {
  const company = await requireCompany()

  const instagramCond = channelWhereCondition('instagram')!
  const emailCond = channelWhereCondition('email')!
  const mineracaoCond = channelWhereCondition('mineracao')!
  const whatsappCond = channelWhereCondition('whatsapp')!

  const [row] = await db
    .select({
      all: sql<number>`count(*)`,
      whatsapp: sql<number>`count(*) filter (where ${whatsappCond})`,
      instagram: sql<number>`count(*) filter (where ${instagramCond})`,
      email: sql<number>`count(*) filter (where ${emailCond})`,
      mineracao: sql<number>`count(*) filter (where ${mineracaoCond})`,
    })
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, company.id))

  return NextResponse.json({
    all: Number(row?.all ?? 0),
    whatsapp: Number(row?.whatsapp ?? 0),
    instagram: Number(row?.instagram ?? 0),
    email: Number(row?.email ?? 0),
    mineracao: Number(row?.mineracao ?? 0),
  })
}
