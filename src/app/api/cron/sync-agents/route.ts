export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { syncAgentsAndCompanies } from '@/lib/sync-agents'
import { db } from '@/lib/db'
import { companies, settings, whatsappMessages } from '@/lib/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { GABI_COMPANY_SLUG, reconcileGabiPause } from '@/lib/gabi-pause-mirror'

const HORAS_SILENCIO_ALARME = 6

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Espelha automaticamente as conversas dos bots Hermes (Nina/AutonomIA e
// demais agentes cadastrados em public.agents) no inbox do SAC: mesma
// função que o botão manual "Sincronizar Agentes" em /empresas já chama,
// só que disparada pelo Vercel Cron em vez de depender de um admin clicar.
// Autenticação por CRON_SECRET (mesmo segredo do /api/cron principal),
// nunca por sessão de admin, porque quem chama aqui é a infraestrutura.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET não configurado' }, { status: 500 })
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Pausa do SAC -> Gabi (Gramado Plaza): reaplica as chaves e as pausas
  // individuais no banco central que a Gabi lê. Rede de segurança para o que
  // não passa pelas rotas com gancho e retry de falha de banco no clique.
  // FICA ANTES do sync e em try próprio: se o sync de agentes demorar (o cron
  // tem 60 s) ou falhar, a pausa ainda é refeita. Nunca derruba o cron.
  // O log traz estoqueAntigo (pausas individuais anteriores a
  // GABI_PAUSE_MIRROR_SINCE, que NÃO são espelhadas) para medir o estoque.
  try {
    const [gramado] = await db
      .select({ id: companies.id, slug: companies.slug })
      .from(companies)
      .where(eq(companies.slug, GABI_COMPANY_SLUG))
      .limit(1)
    if (gramado) {
      // teto de 20 s: banco central lento não pode consumir os 60 s do cron e matar o sync
      const pausa = await Promise.race([
        reconcileGabiPause(gramado),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('reconcile da pausa passou de 20 s')), 20_000)),
      ])
      console.log('[Cron Sync Agents] Pausa SAC->Gabi:', JSON.stringify(pausa))
      if (!pausa.ok) console.error('[Cron Sync Agents] Pausa SAC->Gabi INCOMPLETA: a Gabi pode não ter sabido de uma pausa do SAC')
    }
  } catch (err) {
    console.error('[Cron Sync Agents] Pausa SAC->Gabi falhou:', err instanceof Error ? err.message : err)
  }

  try {
    const report = await syncAgentsAndCompanies()
    // Prova real do resultado no log do cron (nunca só "não deu erro"):
    // investigação de 19/09/2026 mostrou console.error de queries opcionais
    // (public.leads, ctwa_referrals) mascarando um sync principal que na
    // verdade estava completando. Este log deixa explícito ok/contadores
    // reais a cada execução, sem precisar reconstruir isso via CRON_SECRET.
    const safeDetails = report.details
      .filter((detail) => /gramado|cursor|conversas do schema/i.test(detail))
      .map((detail) => detail.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-url]'))

    console.log('[Cron Sync Agents] Relatório:', JSON.stringify({
      ok: report.ok,
      agentsFound: report.agentsFound,
      companiesCreated: report.companiesCreated,
      leadsCreated: report.leadsCreated,
      messagesImported: report.messagesImported,
      dbUrlUsed: report.dbUrlUsed,
      safeDetails,
    }))

    try {
      const canais = await db
        .select({
          companyId: companies.id,
          companyName: companies.name,
          companySlug: companies.slug,
          ultimaMensagemInbound: sql<Date | null>`max(${whatsappMessages.createdAt})`,
        })
        .from(companies)
        .innerJoin(settings, eq(settings.companyId, companies.id))
        .leftJoin(
          whatsappMessages,
          and(
            eq(whatsappMessages.companyId, companies.id),
            eq(whatsappMessages.channel, 'whatsapp'),
            eq(whatsappMessages.direction, 'inbound'),
          ),
        )
        .where(sql`${settings.metaPhoneNumberId} IS NOT NULL AND ${settings.metaPhoneNumberId} <> ''`)
        .groupBy(companies.id, companies.name, companies.slug)

      const agora = Date.now()
      for (const canal of canais) {
        if (!canal.ultimaMensagemInbound) continue

        const ultimaMensagemInbound = new Date(canal.ultimaMensagemInbound)
        const horasSemMensagem = (agora - ultimaMensagemInbound.getTime()) / (1000 * 60 * 60)
        if (horasSemMensagem > HORAS_SILENCIO_ALARME) {
          console.error('[Cron Sync Agents] Canal WhatsApp calado', {
            companyId: canal.companyId,
            companyName: canal.companyName || canal.companySlug,
            horasSemMensagem,
          })
        }
      }
    } catch (err) {
      console.error('[Cron Sync Agents] Falha ao checar canais calados', err)
    }

    return NextResponse.json(report)
  } catch (error) {
    console.error('[Cron Sync Agents Error]:', error)
    return NextResponse.json(
      { ok: false, error: 'Erro ao sincronizar agentes', detail: String(error) },
      { status: 500 }
    )
  }
}
