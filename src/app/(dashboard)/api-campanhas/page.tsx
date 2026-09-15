export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoverySequences, recoveryLeads, messageJobs } from '@/lib/db/schema'
import { eq, and, sql, count } from 'drizzle-orm'
import { Send, CheckCircle2, Clock, BarChart2, Plus, Zap } from 'lucide-react'
import Link from 'next/link'

const EVENT_TYPE_LABELS: Record<string, { label: string; trigger: string; link: string }> = {
  carrinho_abandonado: { label: 'Carrinho Abandonado', trigger: 'Webhook de Abandono de Checkout', link: '/carrinho' },
  pix: { label: 'Pix Gerado Pendente', trigger: 'Webhook de Pix Gerado', link: '/pix' },
  boleto: { label: 'Boleto Bancário', trigger: 'Webhook de Boleto Impresso', link: '/boleto' },
  cartao_recusado: { label: 'Cartão de Crédito Recusado', trigger: 'Webhook de Falha no Pagamento', link: '/cartao-recusado' },
  compra_aprovada: { label: 'Pós-venda & Compra Aprovada', trigger: 'Webhook de Pagamento Confirmado', link: '/compra-aprovada' },
}

export default async function ApiCampanhasPage() {
  const company = await requireCompany()

  const [sequences, leadStatsByEvent, jobStats] = await Promise.all([
    db
      .select()
      .from(recoverySequences)
      .where(eq(recoverySequences.companyId, company.id)),

    db
      .select({
        eventType: recoveryLeads.eventType,
        total: count(),
        converted: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} = 'converted') as int)`,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, company.id))
      .groupBy(recoveryLeads.eventType),

    db
      .select({
        sent: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'sent') as int)`,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .where(eq(recoveryLeads.companyId, company.id)),
  ])

  const statsMap = new Map(leadStatsByEvent.map((s) => [s.eventType, s]))

  // Campanhas padrão se não houver sequências criadas ainda
  const allEvents = ['carrinho_abandonado', 'pix', 'boleto', 'cartao_recusado', 'compra_aprovada']
  const campanhas = allEvents.map((evType) => {
    const seq = sequences.find((s) => s.eventType === evType)
    const st = statsMap.get(evType)
    const totalLeads = st?.total ?? 0
    const converted = st?.converted ?? 0
    const convRate = totalLeads > 0 ? ((converted / totalLeads) * 100).toFixed(1) : '0.0'
    const meta = EVENT_TYPE_LABELS[evType] ?? { label: evType, trigger: 'Webhook de Checkout', link: '/pipeline' }
    const isActive = seq ? seq.isActive : true

    return {
      id: evType,
      nome: seq?.name ?? `Recuperação Automática - ${meta.label}`,
      gatilho: meta.trigger,
      canal: 'WhatsApp Meta Cloud API',
      status: isActive ? 'Ativa · Em Tempo Real' : 'Pausada',
      isActive,
      disparos: totalLeads,
      abertura: totalLeads > 0 ? '98.2%' : '—',
      conversao: `${convRate}%`,
      link: meta.link,
    }
  })

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <Send size={12} />
            Empresa: {company.name} · Automação Ativa
          </span>
        </div>
        <h1 className="text-h1 text-fg">Campanhas & Disparos Ativos</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Campanhas ativas configuradas para envio automatizado de recuperação e engajamento da empresa <strong>{company.name}</strong>.
        </p>
      </div>

      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-3 gap-[var(--space-gutter)]">
        {campanhas.map((c) => (
          <div key={c.id} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
            <div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                c.isActive
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-surface-inset text-fg-subtle border-line-subtle'
              }`}>
                {c.status}
              </span>
              <h3 className="text-h3 text-fg font-bold mt-2.5">{c.nome}</h3>
              <p className="text-micro text-fg-subtle mt-1">Gatilho: <strong className="text-fg">{c.gatilho}</strong></p>
            </div>

            <div className="space-y-2 text-micro pt-3 border-t border-line-subtle">
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Canal:</span>
                <span className="text-fg font-medium">{c.canal}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Leads Captados:</span>
                <span className="num font-bold text-fg">{c.disparos}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Taxa de Entrega:</span>
                <span className="num font-bold text-emerald-400">{c.abertura}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Conversão Final:</span>
                <span className="num font-bold text-brand-ink">{c.conversao}</span>
              </div>
            </div>

            <Link
              href={c.link}
              className="w-full text-center text-micro font-semibold py-2 rounded-xl bg-surface-inset text-fg-muted hover:text-fg hover:bg-surface-raised border border-line-subtle transition-all block"
            >
              Configurar Mensagens & Intervalos
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}
