import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { listMetaTemplates } from '@/lib/whatsapp/meta'

export async function GET(): Promise<NextResponse> {
  const company = await requireCompany()
  const [cfg] = await db.select().from(settings).where(eq(settings.companyId, company.id))

  if (!cfg?.metaWabaId || !cfg?.metaAccessToken) {
    return NextResponse.json({ error: 'Configure o WABA ID e o Access Token Meta primeiro.' }, { status: 400 })
  }

  const templates = await listMetaTemplates(cfg.metaWabaId, cfg.metaAccessToken)
  return NextResponse.json(templates)
}
