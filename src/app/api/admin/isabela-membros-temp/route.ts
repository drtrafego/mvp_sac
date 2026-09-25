import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { companies, companyMembers } from '@/lib/db/schema'
import { eq, ilike } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// dr.trafego@gmail.com fica de fora: ele é o admin/dono do sistema (acesso
// via login de admin), não precisa de convite de membro por empresa.
const EMAILS = [
  'amandafelixgolden@gmail.com',
  'amandaferreirafelixsilva@gmail.com',
  'itinha_23@hotmail.com',
  'lucasfernandesba@gmail.com',
  'patyabreusilva83@gmail.com',
  'willinhoqui@gmail.com',
]

export async function GET(req: NextRequest) {
  const secret = process.env.OPS_ISABELA_MEMBROS_KEY?.trim()
  if (!secret) {
    return NextResponse.json({ error: 'OPS_ISABELA_MEMBROS_KEY nao configurada' }, { status: 503 })
  }
  const provided = req.nextUrl.searchParams.get('key')
  if (!provided || !safeEqual(provided, secret)) {
    return NextResponse.json({ error: 'acesso restrito' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'

  const [isabela] = await db
    .select()
    .from(companies)
    .where(ilike(companies.name, '%isabela%'))
    .limit(1)

  if (!isabela) {
    return NextResponse.json({ error: 'empresa da Isabela nao encontrada' }, { status: 404 })
  }

  const existentes = await db
    .select()
    .from(companyMembers)
    .where(eq(companyMembers.companyId, isabela.id))

  const jaTem = new Set(existentes.map((m) => m.email.toLowerCase()))
  const faltando = EMAILS.filter((e) => !jaTem.has(e.toLowerCase()))

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      empresa: { id: isabela.id, name: isabela.name, slug: isabela.slug },
      jaMembros: [...jaTem],
      seriamAdicionados: faltando,
    })
  }

  const criados: { email: string; inviteUrl: string }[] = []
  for (const email of faltando) {
    const inviteToken = randomBytes(32).toString('hex')
    await db.insert(companyMembers).values({
      companyId: isabela.id,
      email: email.toLowerCase().trim(),
      role: 'admin',
      inviteToken,
      status: 'pending',
    })
    criados.push({
      email,
      inviteUrl: `https://sac.casaldotrafego.com/invite/membro/${inviteToken}`,
    })
  }

  return NextResponse.json({
    ok: true,
    empresa: { id: isabela.id, name: isabela.name, slug: isabela.slug },
    jaEramMembros: [...jaTem],
    adicionados: criados,
  })
}
