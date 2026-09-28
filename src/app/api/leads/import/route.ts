import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, massDispatchBatches, massDispatchRecipients } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

function cleanPhone(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0')) digits = digits.slice(1)
  // Se não tiver DDI (55), adiciona se tiver 10 ou 11 dígitos
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits
  }
  return digits
}

function parseValueToCents(raw: string | number | null | undefined): number {
  if (raw == null) return 0
  if (typeof raw === 'number') return Math.round(raw * 100)
  const cleaned = raw.replace(/[^0-9,-.]/g, '').trim()
  if (!cleaned) return 0
  if (cleaned.includes(',')) {
    const norm = cleaned.replace(/\./g, '').replace(',', '.')
    return Math.round(parseFloat(norm) * 100) || 0
  }
  return Math.round(parseFloat(cleaned) * 100) || 0
}

interface ImportItem {
  name?: string
  phone: string
  email?: string
  productName?: string
  productValue?: string | number
  eventType?: string
  trackingSource?: string
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const body = await req.json()

  const { items, defaultEventType = 'carrinho_abandonado', defaultSource = 'mineracao', fileName } = body

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'Nenhum contato enviado para importação' }, { status: 400 })
  }

  let inserted = 0
  let updated = 0
  let skipped = 0
  const errors: string[] = []

  // Regra de segurança: o upload cria somente um draft. Mesmo clientes antigos
  // que ainda mandem triggerSequence=true não conseguem enfileirar nada aqui.
  const [batch] = await db.insert(massDispatchBatches).values({
    companyId: company.id,
    fileName: typeof fileName === 'string' ? fileName.slice(0, 255) : null,
    eventType: defaultEventType,
    trackingSource: defaultSource,
    status: 'draft',
  }).returning({ id: massDispatchBatches.id })

  for (const item of items as ImportItem[]) {
    try {
      if (!item.phone || typeof item.phone !== 'string') {
        skipped++
        continue
      }

      const phone = cleanPhone(item.phone)
      if (phone.length < 10) {
        skipped++
        errors.push(`Telefone inválido: "${item.phone}"`)
        continue
      }

      const name = item.name?.trim() || null
      const email = item.email?.trim() || null
      const productName = item.productName?.trim() || 'Produto Principal'
      const productValue = parseValueToCents(item.productValue)
      const eventType = item.eventType || defaultEventType
      const trackingSource = item.trackingSource || defaultSource

      // Verificar existência por telefone e empresa para idempotência
      const [existing] = await db
        .select({ id: recoveryLeads.id, status: recoveryLeads.status })
        .from(recoveryLeads)
        .where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.phone, phone)))
        .limit(1)

      let leadId: number

      if (existing) {
        // Atualiza dados adicionais se ainda não convertido
        await db
          .update(recoveryLeads)
          .set({
            name: name ?? undefined,
            email: email ?? undefined,
            productName: productName ?? undefined,
            productValue: productValue > 0 ? productValue : undefined,
            trackingSource,
            updatedAt: new Date(),
          })
          .where(eq(recoveryLeads.id, existing.id))
        
        leadId = existing.id
        updated++
      } else {
        const [created] = await db
          .insert(recoveryLeads)
          .values({
            companyId: company.id,
            platform: 'import_planilha',
            eventType,
            phone,
            name,
            email,
            productName,
            productValue,
            trackingSource,
            status: 'pending',
          })
          .returning({ id: recoveryLeads.id })

        leadId = created.id
        inserted++

      }

      await db.insert(massDispatchRecipients)
        .values({ batchId: batch.id, leadId })
        .onConflictDoNothing()
    } catch (err) {
      skipped++
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  const [recipientTotal] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(massDispatchRecipients)
    .where(eq(massDispatchRecipients.batchId, batch.id))

  await db.update(massDispatchBatches)
    .set({ recipientCount: recipientTotal?.count ?? 0 })
    .where(eq(massDispatchBatches.id, batch.id))

  return NextResponse.json({
    success: true,
    batchId: batch.id,
    batchStatus: 'draft',
    recipientCount: recipientTotal?.count ?? 0,
    total: items.length,
    inserted,
    updated,
    skipped,
    errors: errors.slice(0, 10),
  })
}
