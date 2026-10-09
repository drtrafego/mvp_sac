export const dynamic = 'force-dynamic'

import { PageHeader } from '@/components/ui/page-header'
import { db } from '@/lib/db'
import { settings, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { eq, sql, count } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { Radio, MessageSquare, Settings, Mail } from 'lucide-react'
import Link from 'next/link'
import { aggregateChannelSendMetrics } from '@/lib/channel-send-metrics'

function InstagramIcon({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

export default async function CanaisPage() {
  const company = await requireCompany()

  const [[companySettings], channelMsgStats, channelLeadStats] = await Promise.all([
    db.select().from(settings).where(eq(settings.companyId, company.id)),
    db.select({
      channel: whatsappMessages.channel,
      sendState: whatsappMessages.sendState,
      hasExternalId: sql<boolean>`nullif(${whatsappMessages.externalId}, '') is not null`,
      total: sql<number>`cast(count(*) as int)`,
    }).from(whatsappMessages)
      .where(sql`${whatsappMessages.companyId} = ${company.id} and ${whatsappMessages.direction} = 'outbound'`)
      .groupBy(whatsappMessages.channel, whatsappMessages.sendState, sql`nullif(${whatsappMessages.externalId}, '') is not null`),
    db.select({ channel: recoveryLeads.channel, total: count() })
      .from(recoveryLeads).where(eq(recoveryLeads.companyId, company.id)).groupBy(recoveryLeads.channel),
  ])
  const metrics = aggregateChannelSendMetrics(channelMsgStats)
  const leadCounts = new Map(channelLeadStats.map(row => [row.channel, row.total]))
  const hasMeta = !!(companySettings?.metaPhoneNumberId && companySettings?.metaAccessToken)
  const hasUazapi = !!(companySettings?.uazapiInstanceToken && companySettings?.uazapiBaseUrl)
  const hasInstagram = !!(companySettings?.instagramAccountId || (companySettings?.metaAccessToken && companySettings?.instagramUsername))
  const hasBrevo = !!(companySettings?.brevoApiKey && companySettings?.brevoSenderEmail)
  const whatsappConfigured = companySettings?.whatsappProvider === 'meta' ? hasMeta : companySettings?.whatsappProvider === 'uazapi' ? hasUazapi : false
  const canais = [
    { id: 'whatsapp', name: 'WhatsApp', icon: MessageSquare, iconColor: 'text-emerald-400',
      isConfigured: whatsappConfigured, provider: companySettings?.whatsappProvider === 'meta' ? 'Meta Cloud API' : companySettings?.whatsappProvider === 'uazapi' ? 'UazAPI' : 'Provedor não configurado' },
    { id: 'instagram', name: 'Instagram Direct', icon: InstagramIcon, iconColor: 'text-pink-400',
      isConfigured: hasInstagram, provider: 'Meta Graph API' },
    { id: 'email', name: 'E-mail', icon: Mail, iconColor: 'text-indigo-400',
      isConfigured: hasBrevo, provider: 'Brevo' },
  ].map(channel => ({ ...channel,
    status: channel.isConfigured ? 'Configurado · conexão não verificada' : 'Não configurado',
    bgColor: 'bg-surface-inset border-line-subtle', badgeColor: 'text-fg-muted border-line-subtle bg-surface-inset',
    conversas: leadCounts.get(channel.id) ?? 0,
    metric: metrics.get(channel.id) || { total: 0, accepted: 0, failed: 0, pending: 0, uncertain: 0, unknown: 0 },
  }))
  const unclassified = [...metrics].filter(([channel]) => !['whatsapp', 'instagram', 'email'].includes(channel)).reduce((sum, [, metric]) => sum + metric.total, 0)

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <PageHeader
        icon={<Radio size={22} />}
        title="Canais de Atendimento & Disparo"
        description={<>
          Provedores oficiais de <strong>WhatsApp</strong>, <strong>Instagram Direct</strong> e <strong>E-mail (Brevo)</strong> configurados para <strong>{company.name}</strong>.
        </>}
        eyebrow={<>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
              <Radio size={12} />
              Canais da Empresa: {company.name}
            </span>
          </div>
        </>}
      />

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
                  <span className="text-fg-subtle">Intentos de envio:</span>
                  <span className="num font-bold text-fg">{c.metric.total}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Aguardando resultado:</span>
                  <span className="num font-bold text-fg">{c.metric.pending}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Aceitos pelo provedor:</span>
                  <span className="num font-bold text-emerald-400">{c.metric.accepted}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Falhas confirmadas:</span>
                  <span className="num font-bold text-brand-ink">{c.metric.failed}</span>
                </div>
              </div>

              <div className="space-y-2 text-micro text-fg-subtle">
                <div className="flex justify-between"><span>Resultado incerto:</span><span className="num">{c.metric.uncertain}</span></div>
                <div className="flex justify-between"><span>Sem confirmação de aceitação:</span><span className="num">{c.metric.unknown}</span></div>
                <p>Entrega e leitura não são medidas neste histórico. Aceitação confirma o recebimento pelo provedor.</p>
                {c.id === 'whatsapp' && <p>Dados do canal, reunindo os provedores usados; a configuração atual não identifica o provedor de mensagens antigas.</p>}
              </div>
              <div className="flex flex-col gap-1.5 pt-2">
                {c.id === 'instagram' && (
                  <Link
                    href="/comentarios-instagram"
                    className="w-full text-center text-micro font-semibold py-2 rounded-xl bg-pink-500/10 text-pink-400 hover:bg-pink-500/20 border border-pink-500/30 transition-all flex items-center justify-center gap-1.5"
                  >
                    <InstagramIcon size={13} />
                    Configurar Comentário → DM
                  </Link>
                )}
                <Link
                  href="/configuracoes"
                  className="w-full text-center text-micro font-semibold py-2 rounded-xl bg-surface-inset text-fg-muted hover:text-fg hover:bg-surface-raised border border-line-subtle transition-all flex items-center justify-center gap-1.5"
                >
                  <Settings size={13} />
                  {c.isConfigured ? 'Gerenciar Credenciais' : 'Configurar Canal'}
                </Link>
              </div>
            </div>
          )
        })}
      </div>
      {unclassified > 0 && <p className="text-micro text-fg-muted">{unclassified} intentos sem canal identificado não entram nos indicadores acima.</p>}
    </div>
  )
}
