export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { Activity, ShieldCheck, CheckCircle2, Clock, ThumbsUp, AlertTriangle } from 'lucide-react'

export default async function OperacaoPage() {
  await requireCompany()

  const saude = [
    { label: 'Fila de Saída (Outbox)', valor: '0 mensagens', apoio: 'Nenhuma mensagem represada', status: 'Entregando', statusColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    { label: 'Dead-letter (Falhas)', valor: '0 travados', apoio: 'Limpo · Sem intervenção manual necessária', status: 'Limpo', statusColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    { label: 'Webhooks Inbound', valor: '0 pendentes', apoio: 'Todos os eventos Hotmart, Kiwify, Greenn e Zouti em dia', status: 'Em dia', statusColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  ]

  const operadores = [
    { nome: 'AutonomIA (Agente IA)', acoes: 412, taxaSucesso: '99.4%', status: 'Online' },
    { nome: 'Bella (Agente IA)', acoes: 287, taxaSucesso: '98.9%', status: 'Online' },
    { nome: 'Casal do Tráfego (Agente IA)', acoes: 194, taxaSucesso: '99.8%', status: 'Online' },
    { nome: 'Gastão Matos (Agente IA)', acoes: 142, taxaSucesso: '99.1%', status: 'Online' },
    { nome: 'Operador Humano (Dr. Tráfego)', acoes: 58, taxaSucesso: '100%', status: 'Ativo' },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <Activity size={12} />
            Saúde & Auditoria
          </span>
        </div>
        <h1 className="text-h1 text-fg">Operação & SLA</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Auditoria das ações automatizadas, saúde das filas de envio e integridade da infraestrutura.
        </p>
      </div>

      {/* Saúde da Entrega */}
      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-3 gap-[var(--space-gutter)]">
        {saude.map((s) => (
          <div key={s.label} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-micro uppercase font-semibold text-fg-subtle">{s.label}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${s.statusColor}`}>
                {s.status}
              </span>
            </div>
            <div>
              <span className="num text-h3 font-bold text-fg block">{s.valor}</span>
              <span className="text-micro text-fg-faint mt-1 block">{s.apoio}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Auditoria por Operador / Agente */}
      <div className="rise rise-3 card-section p-5">
        <h3 className="text-h3 text-fg font-bold mb-4 flex items-center gap-2">
          <ShieldCheck size={18} className="text-brand-ink" />
          Ações por Agente e Auditoria
        </h3>
        <div className="space-y-3">
          {operadores.map((op) => (
            <div key={op.nome} className="flex flex-wrap items-center justify-between p-3 bg-surface-raised border border-line-subtle rounded-xl text-body gap-2">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-semibold text-fg">{op.nome}</span>
              </div>
              <div className="flex items-center gap-4 text-micro">
                <span className="text-fg-subtle">Ações Registradas: <strong className="text-fg">{op.acoes}</strong></span>
                <span className="text-fg-subtle">Taxa de Sucesso: <strong className="text-emerald-400">{op.taxaSucesso}</strong></span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
