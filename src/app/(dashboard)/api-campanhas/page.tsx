export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { Send, CheckCircle2, Clock, BarChart2 } from 'lucide-react'

export default async function ApiCampanhasPage() {
  await requireCompany()

  const campanhas = [
    {
      nome: 'Disparo Imediato - Carrinho Abandonado',
      gatilho: 'Webhook Hotmart / Kiwify / Greenn',
      canal: 'WhatsApp Meta Cloud API',
      status: 'Ativa · Em Tempo Real',
      disparos: '1.420',
      abertura: '94.2%',
      conversao: '34.8%',
    },
    {
      nome: 'Lembrete D-1 Vencimento de Pix',
      gatilho: '2 horas antes de expirar chave Pix',
      canal: 'WhatsApp Meta Cloud API',
      status: 'Ativa · Automática',
      disparos: '680',
      abertura: '91.6%',
      conversao: '42.1%',
    },
    {
      nome: 'Boas-Vindas & Acesso ao Curso',
      gatilho: 'Compra Aprovada (Todas as Plataformas)',
      canal: 'WhatsApp + E-mail Brevo',
      status: 'Ativa · Imediata',
      disparos: '890',
      abertura: '98.4%',
      conversao: '100%',
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <Send size={12} />
            Automação Ativa
          </span>
        </div>
        <h1 className="text-h1 text-fg">Campanhas & Disparos Ativos</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Campanhas ativas configuradas para envio automatizado de recuperação e engajamento.
        </p>
      </div>

      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-3 gap-[var(--space-gutter)]">
        {campanhas.map((c) => (
          <div key={c.nome} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
            <div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
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
                <span className="text-fg-subtle">Disparos Totais:</span>
                <span className="num font-bold text-fg">{c.disparos}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Taxa de Abertura:</span>
                <span className="num font-bold text-emerald-400">{c.abertura}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Conversão Final:</span>
                <span className="num font-bold text-brand-ink">{c.conversao}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
