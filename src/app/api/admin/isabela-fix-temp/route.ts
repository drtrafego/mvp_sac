import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { companies, companyMembers } from '@/lib/db/schema'
import { eq, and, inArray, ilike } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

const EMAILS_PRA_REMOVER = [
  'itinha_23@hotmail.com',
  'lucasfernandesba@gmail.com',
  'patyabreusilva83@gmail.com',
  'willinhoqui@gmail.com',
]

export async function GET(req: NextRequest) {
  const secret = process.env.OPS_ISABELA_FIX_KEY?.trim()
  if (!secret) {
    return NextResponse.json({ error: 'OPS_ISABELA_FIX_KEY nao configurada' }, { status: 503 })
  }
  const provided = req.nextUrl.searchParams.get('key')
  if (!provided || !safeEqual(provided, secret)) {
    return NextResponse.json({ error: 'acesso restrito' }, { status: 401 })
  }

  const [isabela] = await db
    .select()
    .from(companies)
    .where(ilike(companies.name, '%isabela%'))
    .limit(1)

  if (!isabela) {
    return NextResponse.json({ error: 'empresa da Isabela nao encontrada' }, { status: 404 })
  }

  const antes = await db
    .select()
    .from(companyMembers)
    .where(eq(companyMembers.companyId, isabela.id))

  const removidos = await db
    .delete(companyMembers)
    .where(
      and(
        eq(companyMembers.companyId, isabela.id),
        inArray(companyMembers.email, EMAILS_PRA_REMOVER),
      ),
    )
    .returning()

  const depois = await db
    .select()
    .from(companyMembers)
    .where(eq(companyMembers.companyId, isabela.id))

  return NextResponse.json({
    ok: true,
    empresa: { id: isabela.id, name: isabela.name },
    antes: antes.map((m) => ({ email: m.email, status: m.status })),
    removidos: removidos.map((m) => m.email),
    depois: depois.map((m) => ({ email: m.email, status: m.status })),
  })
}
