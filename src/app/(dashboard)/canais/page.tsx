export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { Radio, MessageSquare, Mail } from 'lucide-react'

function InstagramIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

export default async function CanaisPage() {
  await requireCompany()

  const canais = [
    {
      id: 'whatsapp',
      name: 'WhatsApp Meta Cloud API',
      icon: MessageSquare,
      iconColor: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10 border-emerald-500/20',
      badgeColor: 'text-emerald-400',
      conversas: 842,
      mensagens: '14.820',
      share: '72%',
      tmr: '1.2 min',
      entrega: '98.8%',
      conversao: '34.2%',
      status: 'Conectado & Operando',
    },
    {
      id: 'instagram',
      name: 'Instagram Direct (Meta Graph)',
      icon: InstagramIcon,
      iconColor: 'text-pink-400',
      bgColor: 'bg-pink-500/10 border-pink-500/20',
      badgeColor: 'text-pink-400',
      conversas: 218,
      mensagens: '3.410',
      share: '19%',
      tmr: '2.8 min',
      entrega: '95.4%',
      conversao: '28.1%',
      status: 'Conectado & Operando',
    },
    {
      id: 'email',
      name: 'Brevo E-mail Transacional',
      icon: Mail,
      iconColor: 'text-blue-400',
      bgColor: 'bg-blue-500/10 border-blue-500/20',
      badgeColor: 'text-blue-400',
      conversas: 105,
      mensagens: '1.290',
      share: '9%',
      tmr: '18.4 min',
      entrega: '99.2%',
      conversao: '16.5%',
      status: 'Conectado & Operando',
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <Radio size={12} />
            Desempenho por Canal
          </span>
        </div>
        <h1 className="text-h1 text-fg">Canais de Atendimento</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Métricas de volume, entrega, tempos de resposta e conversão em cada canal conectado.
        </p>
      </div>

      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-3 gap-[var(--space-gutter)]">
        {canais.map((c) => {
          const Icon = c.icon
          return (
            <div key={c.id} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <div className={`p-2 rounded-xl ${c.bgColor} border flex items-center justify-center`}>
                    <Icon size={18} className={c.iconColor} />
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${c.bgColor} ${c.badgeColor}`}>
                    {c.status}
                  </span>
                </div>
                <h3 className="text-h3 text-fg font-bold mt-3">{c.name}</h3>
                <p className="text-micro text-fg-subtle">Participação no atendimento: <strong className="text-fg">{c.share}</strong></p>
              </div>

              <div className="space-y-2 text-micro pt-3 border-t border-line-subtle">
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Conversas Totais:</span>
                  <span className="num font-bold text-fg">{c.conversas}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Mensagens Trocadas:</span>
                  <span className="num font-bold text-fg">{c.mensagens}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">1ª Resposta (TMR):</span>
                  <span className="num font-bold text-emerald-400">{c.tmr}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Taxa de Entrega:</span>
                  <span className="num font-bold text-fg">{c.entrega}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Taxa de Conversão:</span>
                  <span className="num font-bold text-brand-ink">{c.conversao}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
