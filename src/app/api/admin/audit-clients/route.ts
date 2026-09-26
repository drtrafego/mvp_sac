import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { companies, settings, companyMembers, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Autenticação desta rota: sessão de admin OU chave via ADMIN_AUDIT_KEY (nunca
// hardcoded). Falha fechada: env não configurada -> 503; chave ausente ou
// divergente -> 401. Mesmo padrão de checkWebhookToken em lib/webhook-auth.ts.
function checkAdminAuditKey(req: NextRequest): { ok: true } | { ok: false; status: 401 | 503 } {
  const secret = process.env.ADMIN_AUDIT_KEY?.trim()
  if (!secret) return { ok: false, status: 503 }

  const provided = req.nextUrl.searchParams.get('key')
  if (!provided || !safeEqual(provided, secret)) return { ok: false, status: 401 }

  return { ok: true }
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()

  if (!user?.isAdmin) {
    const keyCheck = checkAdminAuditKey(req)
    if (!keyCheck.ok) {
      const message =
        keyCheck.status === 503
          ? 'Rota desativada: ADMIN_AUDIT_KEY não configurada.'
          : 'Acesso restrito ao administrador'
      return NextResponse.json({ error: message }, { status: keyCheck.status })
    }
  }

  const allCompanies = await db.select().from(companies).orderBy(companies.id)
  let allSettings = await db.select().from(settings).orderBy(settings.id)

  // Auto-heal: garante settings e chaves para qualquer empresa que estiver sem.
  // Chave gerada com randomBytes (entropia real), nunca `slug+id` concatenado:
  // esse formato antigo era recalculável por quem soubesse o slug e o id
  // numérico da empresa, nenhum dos dois secreto (mesmo achado de auditoria
  // de segurança P0, 26/09/2026, que corrigiu o gerador md5 de src/lib/db/index.ts).
  const genAgentKey = (agent: 'bia' | 'luana' | 'renato', slug: string) =>
    `sac_${agent}_${slug}_${randomBytes(24).toString('hex')}`

  for (const comp of allCompanies) {
    const s = allSettings.find(set => set.companyId === comp.id)
    if (!s) {
      await db
        .insert(settings)
        .values({
          companyId: comp.id,
          agentBiaApiKey: genAgentKey('bia', comp.slug),
          agentLuanaApiKey: genAgentKey('luana', comp.slug),
          agentRenatoApiKey: genAgentKey('renato', comp.slug),
        })
        .onConflictDoNothing()
    } else if (!s.agentBiaApiKey || !s.agentLuanaApiKey || !s.agentRenatoApiKey) {
      await db
        .update(settings)
        .set({
          agentBiaApiKey: s.agentBiaApiKey || genAgentKey('bia', comp.slug),
          agentLuanaApiKey: s.agentLuanaApiKey || genAgentKey('luana', comp.slug),
          agentRenatoApiKey: s.agentRenatoApiKey || genAgentKey('renato', comp.slug),
        })
        .where(eq(settings.companyId, comp.id))
    }
  }

  allSettings = await db.select().from(settings).orderBy(settings.id)
  const allMembers = await db.select().from(companyMembers).orderBy(companyMembers.id)

  const report = allCompanies.map(comp => {
    const compMembers = allMembers.filter(m => m.companyId === comp.id)
    const compSetting = allSettings.find(s => s.companyId === comp.id)
    return {
      id: comp.id,
      name: comp.name,
      slug: comp.slug,
      plan: comp.plan,
      inviteToken: comp.inviteToken,
      inviteUrl: comp.inviteToken ? `https://sac.casaldotrafego.com/invite/${comp.inviteToken}` : null,
      members: compMembers.map(m => ({
        id: m.id,
        email: m.email,
        name: m.name,
        role: m.role,
        status: m.status,
        hasStackAuthLinked: Boolean(m.stackAuthUserId),
        inviteToken: m.inviteToken,
      })),
      agentKeys: {
        bia: compSetting?.agentBiaApiKey,
        luana: compSetting?.agentLuanaApiKey,
        renato: compSetting?.agentRenatoApiKey,
      },
    }
  })

  return NextResponse.json({
    ok: true,
    totalCompanies: allCompanies.length,
    companies: report,
  })
}
