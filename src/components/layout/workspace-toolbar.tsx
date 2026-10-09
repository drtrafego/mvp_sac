'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowUpRight, ChevronRight, LayoutGrid } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'

const labels: Record<string, string> = {
  '/': 'Visão geral', '/inbox': 'Conversas', '/instagram': 'Instagram',
  '/atender-agora': 'Atender agora', '/pipeline': 'Pipeline', '/leads': 'Contatos',
  '/canais': 'Canais', '/origens': 'Origens', '/operacao': 'Operação',
  '/analytics-vendas': 'Analytics', '/agente': 'Agente', '/configuracoes': 'Configurações',
  '/biblioteca': 'Biblioteca', '/api-docs': 'Documentação', '/api-modelos': 'Mensagens aprovadas',
  '/api-campanhas': 'Campanhas', '/api-followup': 'Follow-up', '/webhooks-log': 'Webhooks',
  '/disparo-em-massa': 'Disparo em massa', '/comentarios-instagram': 'Comentários Instagram',
  '/recuperador-admin': 'Recuperação',
}

export function WorkspaceToolbar({ companyName }: { companyName: string }) {
  const pathname = usePathname()
  const root = '/' + pathname.split('/').filter(Boolean)[0]
  const current = labels[pathname] || labels[root] || 'Área de trabalho'
  return <header className="studio-toolbar">
    <div className="studio-toolbar-location"><LayoutGrid size={16} /><span title={companyName}>{companyName}</span><ChevronRight size={12} /><strong>{current}</strong></div>
    <div className="studio-toolbar-actions"><Link href="/atender-agora">Atender agora <ArrowUpRight size={13} /></Link><div><ThemeToggle /></div></div>
  </header>
}
