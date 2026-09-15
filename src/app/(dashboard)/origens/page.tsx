export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { Globe, ArrowUpRight, TrendingUp, Layers } from 'lucide-react'

export default async function OrigensPage() {
  await requireCompany()

  const origens = [
    {
      nome: 'Meta Ads (Facebook & Instagram)',
      slug: 'meta-ads',
      share: '54%',
      leads: 642,
      recuperado: 'R$ 68.420,00',
      conversao: '36.8%',
      cor: 'bg-blue-500',
    },
    {
      nome: 'Google Ads (Pesquisa / YouTube)',
      slug: 'google-ads',
      share: '22%',
      leads: 260,
      recuperado: 'R$ 29.150,00',
      conversao: '28.4%',
      cor: 'bg-amber-400',
    },
    {
      nome: 'Tráfego Orgânico & Direto',
      slug: 'organico',
      share: '14%',
      leads: 165,
      recuperado: 'R$ 18.230,00',
      conversao: '22.1%',
      cor: 'bg-purple-400',
    },
    {
      nome: 'Recuperação Ativa (Checkout Webhook)',
      slug: 'webhook-recuperacao',
      share: '10%',
      leads: 118,
      recuperado: 'R$ 14.890,00',
      conversao: '41.2%',
      cor: 'bg-emerald-400',
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <Globe size={12} />
            Origens de Tráfego
          </span>
        </div>
        <h1 className="text-h1 text-fg">Origens e Aquisição</h1>
        <p className="text-body text-fg-muted mt-0.5">
          De onde vêm os contatos atendidos e qual canal gera maior retorno de receita recuperada.
        </p>
      </div>

      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
        {origens.map((origem) => (
          <div key={origem.slug} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-micro font-mono uppercase text-fg-subtle">{origem.slug}</span>
                <span className="num text-metric-sm font-bold text-fg">{origem.share}</span>
              </div>
              <h3 className="text-h3 text-fg font-bold mt-2">{origem.nome}</h3>
              <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden mt-3">
                <div className={`h-full ${origem.cor} rounded-full`} style={{ width: origem.share }} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-3 border-t border-line-subtle text-micro">
              <div>
                <span className="text-fg-faint block uppercase text-[10px]">Leads:</span>
                <span className="num font-bold text-fg">{origem.leads}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[10px]">Conversão:</span>
                <span className="num font-bold text-brand-ink">{origem.conversao}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[10px]">Recuperado:</span>
                <span className="num font-bold text-emerald-400 truncate block">{origem.recuperado}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
