export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings, recoveryLeads, whatsappMessages, recoverySequences } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, sql, count } from 'drizzle-orm'
import { randomBytes } from 'crypto'

function genToken() { return randomBytes(24).toString('hex') }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await authenticateAgentRequest(req)
  if (error) return error

  // inviteToken NÃO entra aqui: funciona como credencial mestra da empresa
  // (mesmo formato aceito como chave nas rotas /companies/:slug/...), e esta
  // lista devolve TODAS as empresas para qualquer chave autenticada válida,
  // não só a da empresa dona da chave. Vazava a credencial mestra de todos
  // os clientes pra qualquer cliente autenticado. Também não faz parte do
  // contrato documentado em API_DOCS.md (id, name, slug, plan, createdAt).
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      slug: companies.slug,
      plan: companies.plan,
      createdAt: companies.createdAt,
      totalLeads: sql<number>`COALESCE((SELECT COUNT(*)::int FROM recovery_leads WHERE recovery_leads.company_id = "companies"."id"), 0)`,
      totalMessages: sql<number>`COALESCE((SELECT COUNT(*)::int FROM whatsapp_messages WHERE whatsapp_messages.company_id = "companies"."id"), 0)`,
    })
    .from(companies)
    .orderBy(companies.id)

  return NextResponse.json({ ok: true, count: rows.length, companies: rows })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await authenticateAgentRequest(req)
  if (error) return error

  try {
    const body = await req.json()
    const { name, slug, plan } = body

    if (!name || !slug) {
      return NextResponse.json({ error: 'Campos "name" e "slug" são obrigatórios' }, { status: 400 })
    }

    const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const inviteToken = genToken()

    const [created] = await db
      .insert(companies)
      .values({
        name: String(name).trim(),
        slug: cleanSlug,
        plan: plan || 'pro',
        inviteToken,
      })
      .returning()

    // Cria settings inicial
    await db.insert(settings).values({ companyId: created.id }).onConflictDoNothing()

    // Cria sequências padrão (boleto, pix, carrinho, cartao)
    const defaultEvents = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado']
    for (const ev of defaultEvents) {
      await db.insert(recoverySequences).values({
        companyId: created.id,
        eventType: ev,
        name: `Sequência de ${ev.replace('_', ' ')}`,
        isActive: true,
      }).onConflictDoNothing()
    }

    return NextResponse.json({
      ok: true,
      message: `Empresa "${created.name}" criada com sucesso.`,
      company: created,
    }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao criar empresa' }, { status: 500 })
  }
}
