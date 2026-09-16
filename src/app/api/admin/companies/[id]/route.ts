import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'crypto'
function genToken() { return randomBytes(24).toString('hex') }

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const { id } = await params
  const companyId = parseInt(id)
  const body = await req.json()

  const allowed = ['name', 'slug', 'plan', 'stackAuthUserId'] as const
  const update: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }
  update.updatedAt = new Date()

  const [updated] = await db
    .update(companies)
    .set(update)
    .where(eq(companies.id, companyId))
    .returning()

  if ('sidebarConfig' in body) {
    const existing = await db.select().from(settings).where(eq(settings.companyId, companyId)).limit(1)
    if (existing.length > 0) {
      await db.update(settings).set({ sidebarConfig: body.sidebarConfig, updatedAt: new Date() }).where(eq(settings.companyId, companyId))
    } else {
      await db.insert(settings).values({ companyId, sidebarConfig: body.sidebarConfig })
    }
  }

  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const { id } = await params
  await db.delete(companies).where(eq(companies.id, parseInt(id)))
  return NextResponse.json({ ok: true })
}

// Regenerar invite token
export async function PUT(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const { id } = await params
  const inviteToken = genToken()

  const [updated] = await db
    .update(companies)
    .set({ inviteToken })
    .where(eq(companies.id, parseInt(id)))
    .returning()

  return NextResponse.json(updated)
}
