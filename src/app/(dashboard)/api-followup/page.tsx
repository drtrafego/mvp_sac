export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { ListOrdered, Sparkles, Clock, CheckCircle2, ArrowRight } from 'lucide-react'

export default async function ApiFollowupPage() {
  await requireCompany()

  const sequencias = [
    {
      etapa: 'Mensagem 1',
      tempo: '5 minutos após o evento',
      tipo: 'Abordagem Inicial & Link Especial',
      taxa: '48.2% de conversão',
      descricao: 'Entrega do link direto de finalização com cupom ou suporte personalizado imediato do bot.',
    },
    {
      etapa: 'Mensagem 2',
      tempo: '2 horas após o evento',
      tipo: 'Quebra de Objeção & Formas de Pagamento',
      taxa: '26.4% de conversão',
      descricao: 'Perguntas sobre dúvidas de parcelamento, Pix ou garantia incondicional.',
    },
    {
      etapa: 'Mensagem 3',
      tempo: '24 horas após o evento',
      tipo: 'Última Chamada & Bônus Exclusivo',
      taxa: '15.1% de conversão',
      descricao: 'Lembrete de expiração de oferta com bônus de mentoria ou suporte prioritário.',
    },
    {
      etapa: 'Mensagem 4',
      tempo: '48 horas após o evento',
      tipo: 'Encerramento de Carrinho',
      taxa: '10.3% de conversão',
      descricao: 'Aviso de encerramento do carrinho e liberação da vaga para a fila de espera.',
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <ListOrdered size={12} />
            Régua de Relacionamento
          </span>
        </div>
        <h1 className="text-h1 text-fg">Follow-up Inteligente</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Sequências temporais de mensagens e gatilhos automatizados para recuperação máxima de vendas.
        </p>
      </div>

      <div className="rise rise-2 space-y-3">
        {sequencias.map((s, idx) => (
          <div key={s.etapa} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-glow border border-brand-solid/30 text-brand-ink font-bold shrink-0">
                {idx + 1}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-body font-bold text-fg">{s.etapa}: {s.tipo}</h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-surface-inset text-fg-subtle border border-line-subtle">
                    ⏱️ {s.tempo}
                  </span>
                </div>
                <p className="text-micro text-fg-muted mt-1">{s.descricao}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0 self-end md:self-center">
              <span className="num text-micro font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-xl">
                {s.taxa}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
