import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'crypto'

export const dynamic = 'force-dynamic'

const ROTATABLE_AGENTS = {
  bia: 'agentBiaApiKey',
  luana: 'agentLuanaApiKey',
  renato: 'agentRenatoApiKey',
} as const

type RotatableAgent = keyof typeof ROTATABLE_AGENTS

// Rotaciona a chave de API de UM agente de UMA empresa por vez. Corrige, para
// quem já tem chave em produção, o achado de auditoria de segurança P0
// (26/09/2026): as chaves antigas foram geradas por md5(slug + id da empresa),
// sem entropia privada nenhuma, e quem soubesse os dois dados recalculava a
// credencial sozinho. Este endpoint NUNCA roda em massa sozinho: cada chamada
// exige o id da empresa e qual agente, uma de cada vez, sob autorização
// explícita — trocar a chave de uma empresa que já tem integração ativa com a
// chave antiga derruba essa integração na hora, e isso é uma decisão de quem
// pediu a rotação, não deste endpoint.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const { id } = await params
  const companyId = parseInt(id)
  if (!Number.isFinite(companyId)) {
    return NextResponse.json({ error: 'id de empresa inválido' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const agent = body?.agent as RotatableAgent | undefined
  if (!agent || !(agent in ROTATABLE_AGENTS)) {
    return NextResponse.json(
      { error: 'Campo "agent" obrigatório: "bia", "luana" ou "renato".' },
      { status: 400 }
    )
  }

  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1)
  if (!company) {
    return NextResponse.json({ error: `Empresa ${companyId} não encontrada.` }, { status: 404 })
  }

  const column = ROTATABLE_AGENTS[agent]
  const newKey = `sac_${agent}_${company.slug}_${randomBytes(24).toString('hex')}`

  const [updated] = await db
    .update(settings)
    .set({ [column]: newKey } as Record<string, string>)
    .where(eq(settings.companyId, companyId))
    .returning({ companyId: settings.companyId })

  if (!updated) {
    return NextResponse.json(
      { error: `Empresa ${companyId} não tem registro em settings ainda.` },
      { status: 404 }
    )
  }

  return NextResponse.json({
    ok: true,
    companyId,
    companySlug: company.slug,
    agent,
    newKey,
    warning:
      'A chave antiga deste agente para de funcionar imediatamente — qualquer integração que ainda a usa quebra na hora. ' +
      'Esta rota não guarda nem loga o valor novo, mas ele continua visível em texto plano para quem acessar GET /api/admin/audit-clients (admin logado ou ADMIN_AUDIT_KEY) — não é um segredo de exibição única.',
  })
}
