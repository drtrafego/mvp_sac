import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

/** Uses counts already loaded by the dashboard; no extra request or invented KPI. */
export function DashboardFocus({ awaiting, pendingMessages, checkout = false }: { awaiting: number; pendingMessages: number; checkout?: boolean }) {
  return <section className="dashboard-focus" aria-label="Acesso à operação de hoje">
    <div className="dashboard-focus-primary"><div><p>DA VISÃO À AÇÃO</p><h2>Cada conversa merece<br />um próximo passo.</h2></div><Link href="/atender-agora">Organizar atendimentos <ArrowUpRight size={16} /></Link></div>
    <div className="dashboard-focus-secondary"><div><span>{checkout ? 'Abordagem de contatos' : 'Aguardam abordagem'}</span><strong>{checkout ? '—' : awaiting}</strong><Link href={checkout ? '/operacao' : '/inbox'}>{checkout ? 'Não se aplica ao checkout' : 'Abrir conversas'} ↗</Link></div><div><span>Mensagens pendentes</span><strong>{pendingMessages}</strong><Link href="/operacao">Ver fila de envio ↗</Link></div></div>
  </section>
}
