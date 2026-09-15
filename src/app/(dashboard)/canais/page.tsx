export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { settings, recoveryLeads, messageJobs } from '@/lib/db/schema'
import { eq, sql, count } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { Radio, MessageSquare, Settings, CheckCircle2, AlertCircle, Zap, ShieldCheck } from 'lucide-react'
import Link from 'next/link'

export default async function CanaisPage() {
  const company = await requireCompany()

  const [[companySettings], [leadStats], [jobStats]] = await Promise.all([
    db.select().from(settings).where(eq(settings.companyId, company.id)),
    db
      .select({
        total: count(),
        recovered: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} = 'converted') as int)`,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, company.id)),
    db
      .select({
        sent: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'sent') as int)`,
        pending: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'pending') as int)`,
        failed: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'failed') as int)`,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .where(eq(recoveryLeads.companyId, company.id)),
  ])

  const hasMeta = !!(companySettings?.metaPhoneNumberId && companySettings?.metaAccessToken)
  const hasUazapi = !!(companySettings?.uazapiInstanceToken && companySettings?.uazapiBaseUrl)
  const isMetaActive = companySettings?.whatsappProvider === 'meta' && hasMeta
  const isUazapiActive = companySettings?.whatsappProvider === 'uazapi' && hasUazapi

  const sentJobs = jobStats?.sent ?? 0
  const pendingJobs = jobStats?.pending ?? 0
  const failedJobs = jobStats?.failed ?? 0
  const totalLeads = leadStats?.total ?? 0
  const recoveredLeads = leadStats?.recovered ?? 0
  const convRate = totalLeads > 0 ? ((recoveredLeads / totalLeads) * 100).toFixed(1) : '0.0'
  const deliveryRate = sentJobs + failedJobs > 0 ? (((sentJobs) / (sentJobs + failedJobs)) * 100).toFixed(1) : (sentJobs > 0 ? '100.0' : '—')

  const canais = [
    {
      id: 'meta',
      name: 'WhatsApp Meta Cloud API (Oficial)',
      icon: MessageSquare,
      iconColor: 'text-emerald-400',
      bgColor: hasMeta ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-zinc-800/40 border-zinc-700',
      badgeColor: hasMeta ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10' : 'text-amber-400 border-amber-500/20 bg-amber-500/10',
      status: hasMeta ? (companySettings?.whatsappProvider === 'meta' ? 'Ativo & Operando' : 'Credenciais Salvas') : 'Não Configurado',
      isConfigured: hasMeta,
      provider: 'Meta Cloud API Oficial',
      conversas: isMetaActive ? totalLeads : 0,
      mensagens: isMetaActive ? sentJobs : 0,
      pendentes: isMetaActive ? pendingJobs : 0,
      entrega: isMetaActive ? `${deliveryRate}%` : '—',
      conversao: isMetaActive ? `${convRate}%` : '—',
    },
    {
      id: 'uazapi',
      name: 'WhatsApp Uazapi (Instância Web)',
      icon: Zap,
      iconColor: 'text-cyan-400',
      bgColor: hasUazapi ? 'bg-cyan-500/10 border-cyan-500/20' : 'bg-zinc-800/40 border-zinc-700',
      badgeColor: hasUazapi ? 'text-cyan-400 border-cyan-500/20 bg-cyan-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-800',
      status: hasUazapi ? (companySettings?.whatsappProvider === 'uazapi' ? 'Ativo & Operando' : 'Credenciais Salvas') : 'Não Configurado',
      isConfigured: hasUazapi,
      provider: 'UazAPI Gateway',
      conversas: isUazapiActive ? totalLeads : 0,
      mensagens: isUazapiActive ? sentJobs : 0,
      pendentes: isUazapiActive ? pendingJobs : 0,
      entrega: isUazapiActive ? `${deliveryRate}%` : '—',
      conversao: isUazapiActive ? `${convRate}%` : '—',
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <Radio size={12} />
            Canais da Empresa: {company.name}
          </span>
        </div>
        <h1 className="text-h1 text-fg">Canais de Atendimento & Disparo</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Provedores de WhatsApp oficiais e alternativos configurados exclusivamente para <strong>{company.name}</strong>.
        </p>
      </div>

      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
        {canais.map((c) => {
          const Icon = c.icon
          return (
            <div key={c.id} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <div className={`p-2 rounded-xl ${c.bgColor} border flex items-center justify-center`}>
                    <Icon size={18} className={c.iconColor} />
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${c.badgeColor}`}>
                    {c.status}
                  </span>
                </div>
                <h3 className="text-h3 text-fg font-bold mt-3">{c.name}</h3>
                <p className="text-micro text-fg-subtle">Provedor: <strong className="text-fg">{c.provider}</strong></p>
              </div>

              <div className="space-y-2 text-micro pt-3 border-t border-line-subtle">
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Leads Atendidos:</span>
                  <span className="num font-bold text-fg">{c.conversas}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Mensagens Enviadas:</span>
                  <span className="num font-bold text-fg">{c.mensagens}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Mensagens em Fila:</span>
                  <span className="num font-bold text-fg">{c.pendentes}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Taxa de Entrega:</span>
                  <span className="num font-bold text-emerald-400">{c.entrega}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Taxa de Conversão:</span>
                  <span className="num font-bold text-brand-ink">{c.conversao}</span>
                </div>
              </div>

              <Link
                href="/configuracoes"
                className="w-full text-center text-micro font-semibold py-2 rounded-xl bg-surface-inset text-fg-muted hover:text-fg hover:bg-surface-raised border border-line-subtle transition-all flex items-center justify-center gap-1.5"
              >
                <Settings size={13} />
                {c.isConfigured ? 'Gerenciar Credenciais' : 'Configurar Canal'}
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
