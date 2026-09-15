'use client'

import { useState } from 'react'
import {
  Key,
  Shield,
  Bot,
  Copy,
  Check,
  Code2,
  Terminal,
  Layers,
  Database,
  Users,
  Send,
  PauseCircle,
  BarChart3,
  Globe,
  Lock,
  ChevronDown,
  Sparkles,
  ExternalLink,
  BookOpen
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface EndpointDoc {
  id: string
  title: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  category: 'empresas' | 'leads' | 'conversas' | 'config' | 'analytics'
  description: string
  headers: { name: string; required: boolean; description: string }[]
  params?: { name: string; type: string; required: boolean; description: string }[]
  bodyExample?: any
  responseExample: any
}

const ENDPOINTS: EndpointDoc[] = [
  {
    id: 'create-lead',
    title: 'Criar Lead no Pipeline com Atribuição de Tráfego & Follow-up',
    method: 'POST',
    path: '/api/v1/companies/:idOrSlug/leads',
    category: 'leads',
    description: 'Cria um novo lead no funil da empresa especificada com dados completos de campanha e lembrete de retorno.',
    headers: [
      { name: 'Authorization', required: true, description: 'Bearer <CHAVE_LUANA_OU_RENATO>' },
      { name: 'Content-Type', required: true, description: 'application/json' },
      { name: 'x-agent-id', required: false, description: 'Identificador do agente (ex: luana ou renato)' },
    ],
    params: [
      { name: 'name', type: 'string', required: false, description: 'Nome completo do contato' },
      { name: 'phone', type: 'string', required: true, description: 'Telefone com DDD (ex: 5511999998888)' },
      { name: 'email', type: 'string', required: false, description: 'E-mail do lead' },
      { name: 'stage', type: 'string', required: false, description: 'Etapa inicial: novo_contato, qualificado, agendado, fechado' },
      { name: 'productName', type: 'string', required: false, description: 'Nome do produto / serviço de interesse' },
      { name: 'productValue', type: 'number', required: false, description: 'Valor estimado em centavos (ex: 150000 = R$ 1.500,00)' },
      { name: 'trackingSource', type: 'string', required: false, description: 'Origem do lead (ex: Meta Ads, Instagram DM, Mineração)' },
      { name: 'utmCampaign', type: 'string', required: false, description: 'Nome da campanha no Meta / Google Ads' },
      { name: 'followUpDate', type: 'ISO Date', required: false, description: 'Data para retorno agendado (ex: 2026-09-20T14:00:00Z)' },
      { name: 'followUpNote', type: 'string', required: false, description: 'Observação ou motivo do retorno' },
      { name: 'responsibleAgent', type: 'string', required: false, description: 'Agente responsável ("Luana" ou "Renato")' },
    ],
    bodyExample: {
      name: 'Mariana Souza',
      phone: '5511999998888',
      email: 'mariana.souza@gmail.com',
      stage: 'qualificado',
      productName: 'Reserva Suíte Master',
      productValue: 180000,
      trackingSource: 'Meta Ads',
      utmCampaign: 'Campanha Férias Gramado',
      followUpDate: '2026-09-20T14:00:00Z',
      followUpNote: 'Ligar para confirmar pacote com café colonial',
      responsibleAgent: 'Luana'
    },
    responseExample: {
      ok: true,
      lead: {
        id: 482,
        companyId: 12,
        name: 'Mariana Souza',
        phone: '5511999998888',
        email: 'mariana.souza@gmail.com',
        pipelineStage: 'qualificado',
        productValue: 180000,
        responsibleAgent: 'Luana',
        lastActionBy: 'Luana (Agente IA)',
        lastActionAt: '2026-09-15T20:30:00.000Z',
        createdAt: '2026-09-15T20:30:00.000Z'
      }
    }
  },
  {
    id: 'update-lead',
    title: 'Atualizar Etapa do Funil, Follow-up e Agente Responsável',
    method: 'PATCH',
    path: '/api/v1/companies/:idOrSlug/leads/:leadId',
    category: 'leads',
    description: 'Atualiza o estágio do pipeline, remarca lembrete de contato e registra a autoria da alteração no log de auditoria.',
    headers: [
      { name: 'Authorization', required: true, description: 'Bearer <CHAVE_LUANA_OU_RENATO>' },
      { name: 'Content-Type', required: true, description: 'application/json' },
    ],
    bodyExample: {
      stage: 'agendado',
      followUpDate: '2026-09-18T10:00:00Z',
      followUpNote: 'Cliente confirmou proposta, aguardando pagamento do sinal',
      responsibleAgent: 'Renato'
    },
    responseExample: {
      ok: true,
      lead: {
        id: 482,
        pipelineStage: 'agendado',
        followUpDate: '2026-09-18T10:00:00.000Z',
        followUpNote: 'Cliente confirmou proposta...',
        responsibleAgent: 'Renato',
        lastActionBy: 'Renato (Agente IA)',
        lastActionAt: '2026-09-15T20:35:00.000Z',
        updatedAt: '2026-09-15T20:35:00.000Z'
      }
    }
  },
  {
    id: 'send-message',
    title: 'Enviar Mensagem WhatsApp / Instagram / E-mail',
    method: 'POST',
    path: '/api/v1/companies/:idOrSlug/conversations/:contact/messages',
    category: 'conversas',
    description: 'Envia mensagem em tempo real para o contato através do WhatsApp oficial (Cloud API / UazAPI), Direct do Instagram ou E-mail Brevo.',
    headers: [
      { name: 'Authorization', required: true, description: 'Bearer <CHAVE_LUANA_OU_RENATO>' },
      { name: 'Content-Type', required: true, description: 'application/json' },
    ],
    params: [
      { name: 'content', type: 'string', required: true, description: 'Texto da mensagem' },
      { name: 'channel', type: 'string', required: false, description: '"whatsapp", "instagram" ou "email"' },
      { name: 'senderName', type: 'string', required: false, description: 'Nome do remetente ("Luana" ou "Renato")' },
      { name: 'mediaUrl', type: 'string', required: false, description: 'URL de imagem ou PDF em anexo' },
    ],
    bodyExample: {
      channel: 'whatsapp',
      content: 'Olá Mariana! Tudo bem? Aqui é a Luana do Gramado Plaza. Vi que você se interessou pelo pacote de casal, posso tirar suas dúvidas?',
      senderName: 'Luana'
    },
    responseExample: {
      ok: true,
      message: 'Mensagem enviada e registrada com sucesso',
      sentMessage: {
        id: 1092,
        leadId: 482,
        phone: '5511999998888',
        channel: 'whatsapp',
        direction: 'outbound',
        senderName: 'Luana',
        agentId: 'luana',
        createdAt: '2026-09-15T20:36:00.000Z'
      }
    }
  },
  {
    id: 'pause-bot',
    title: 'Pausar Bot para Intervenção Humana (ou Retomar)',
    method: 'POST',
    path: '/api/v1/companies/:idOrSlug/conversations/:contact/pause-bot',
    category: 'conversas',
    description: 'Silencia as respostas automáticas da IA para que o atendente humano possa negociar no Inbox.',
    headers: [
      { name: 'Authorization', required: true, description: 'Bearer <API_KEY>' },
    ],
    bodyExample: {
      pause: true,
      reason: 'Lead solicitou desconto especial acima da alçada da IA',
      pausedBy: 'Luana (Agente IA)'
    },
    responseExample: {
      ok: true,
      botPaused: true,
      contact: '5511999998888',
      leadId: 482,
      actionBy: 'Luana (Agente IA)'
    }
  },
  {
    id: 'list-leads',
    title: 'Listar e Filtrar Leads no Pipeline',
    method: 'GET',
    path: '/api/v1/companies/:idOrSlug/leads?stage=qualificado&limit=50',
    category: 'leads',
    description: 'Busca leads ativos da empresa com suporte a filtros por etapa, canal, origem e busca textual.',
    headers: [
      { name: 'Authorization', required: true, description: 'Bearer <API_KEY>' },
    ],
    responseExample: {
      ok: true,
      company: { id: 12, slug: 'gramado-plaza' },
      count: 1,
      leads: [
        {
          id: 482,
          name: 'Mariana Souza',
          phone: '5511999998888',
          pipelineStage: 'qualificado',
          responsibleAgent: 'Luana',
          lastActionBy: 'Luana (Agente IA)',
          productValue: 180000
        }
      ]
    }
  },
  {
    id: 'company-settings',
    title: 'Consultar Credenciais & Configurações da Empresa',
    method: 'GET',
    path: '/api/v1/companies/:idOrSlug/settings',
    category: 'config',
    description: 'Obtém as credenciais ativas da empresa (Meta Pixel, WhatsApp IDs, Brevo, Supabase, Allowlist de IPs).',
    headers: [
      { name: 'Authorization', required: true, description: 'Bearer <API_KEY>' },
    ],
    responseExample: {
      ok: true,
      company: { id: 12, name: 'Gramado Plaza', slug: 'gramado-plaza' },
      settings: {
        whatsappProvider: 'meta',
        hasMetaToken: true,
        hasBrevoApiKey: true,
        hasSupabaseUrl: true,
        allowedIps: '192.168.1.100, 203.0.113.45',
        agentLuanaConfigured: true,
        agentRenatoConfigured: true
      }
    }
  },
  {
    id: 'company-analytics',
    title: 'Consultar Métricas & Conversões da Empresa',
    method: 'GET',
    path: '/api/v1/companies/:idOrSlug/analytics',
    category: 'analytics',
    description: 'Retorna contagem total de leads, faturamento recuperado/gerado e distribuição por etapa do funil.',
    headers: [
      { name: 'Authorization', required: true, description: 'Bearer <API_KEY>' },
    ],
    responseExample: {
      ok: true,
      company: { id: 12, slug: 'gramado-plaza' },
      analytics: {
        totalLeads: 694,
        activeLeads: 142,
        totalRevenue: 28450000,
        stages: {
          novo_contato: 85,
          qualificado: 112,
          agendado: 248,
          fechado: 249
        },
        agents: {
          luana: 380,
          renato: 240,
          unassigned: 74
        }
      }
    }
  }
]

export default function ApiDocsPage() {
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [activeCodeTab, setActiveCodeTab] = useState<{ [key: string]: 'curl' | 'python' | 'node' }>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedEndpoint, setExpandedEndpoint] = useState<string | null>('create-lead')

  function handleCopy(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2500)
  }

  function getCodeSnippet(ep: EndpointDoc, lang: 'curl' | 'python' | 'node') {
    const url = 'https://mvp-sac.vercel.app' + ep.path.replace(':idOrSlug', 'gramado-plaza').replace(':leadId', '482').replace(':contact', '5511999998888')
    
    if (lang === 'curl') {
      if (ep.method === 'GET') {
        return `curl -X GET "${url}" \\
  -H "Authorization: Bearer sac_agent_luana_live_2026" \\
  -H "x-agent-id: luana" \\
  -H "Content-Type: application/json"`
      }
      return `curl -X ${ep.method} "${url}" \\
  -H "Authorization: Bearer sac_agent_luana_live_2026" \\
  -H "x-agent-id: luana" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(ep.bodyExample, null, 2)}'`
    }

    if (lang === 'python') {
      if (ep.method === 'GET') {
        return `import requests

url = "${url}"
headers = {
    "Authorization": "Bearer sac_agent_luana_live_2026",
    "x-agent-id": "luana",
    "Content-Type": "application/json"
}

response = requests.get(url, headers=headers)
print(response.json())`
      }
      return `import requests

url = "${url}"
headers = {
    "Authorization": "Bearer sac_agent_luana_live_2026",
    "x-agent-id": "luana",
    "Content-Type": "application/json"
}
payload = ${JSON.stringify(ep.bodyExample, null, 4)}

response = requests.${ep.method.toLowerCase()}(url, json=payload, headers=headers)
print(response.json())`
    }

    if (lang === 'node') {
      if (ep.method === 'GET') {
        return `const response = await fetch('${url}', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer sac_agent_luana_live_2026',
    'x-agent-id': 'luana',
    'Content-Type': 'application/json',
  },
});
const data = await response.json();
console.log(data);`
      }
      return `const response = await fetch('${url}', {
  method: '${ep.method}',
  headers: {
    'Authorization': 'Bearer sac_agent_luana_live_2026',
    'x-agent-id': 'luana',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(${JSON.stringify(ep.bodyExample, null, 2)}),
});
const data = await response.json();
console.log(data);`
    }

    return ''
  }

  const filteredEndpoints = selectedCategory === 'all'
    ? ENDPOINTS
    : ENDPOINTS.filter(e => e.category === selectedCategory)

  return (
    <div className="space-y-6 pb-12">
      {/* Header Principal */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface-raised border border-line-subtle rounded-2xl p-6 shadow-sm">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-brand-glow text-brand-ink border border-brand-solid/30">
              <Bot size={22} />
            </span>
            <div>
              <h1 className="text-h2 font-bold text-fg flex items-center gap-2">
                Documentação da API para Agentes IA
                <span className="text-[10px] uppercase font-black px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  v1.0 Live
                </span>
              </h1>
              <p className="text-micro text-fg-subtle">
                Integração RESTful completa para os agentes autônomos <strong className="text-rose-400">Bia (Amanda)</strong> e <strong className="text-purple-400">Luana (Gastão)</strong>.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <a
            href="/docs/API_AGENTE_SAC.md"
            target="_blank"
            className="inline-flex items-center gap-1.5 text-micro font-bold px-3 py-2 rounded-xl bg-surface-base border border-line-subtle text-fg hover:border-brand-ink transition-all"
          >
            <BookOpen size={14} />
            Documentação Técnica (Markdown)
          </a>
        </div>
      </div>

      {/* Cartões dos 2 Agentes (Bia e Luana) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card Bia (Amanda) */}
        <div className="bg-surface-raised border border-rose-500/30 rounded-2xl p-5 relative overflow-hidden shadow-sm">
          <div className="absolute top-0 right-0 w-32 h-32 bg-rose-500/10 rounded-full blur-2xl pointer-events-none" />
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 font-black text-base shadow-sm">
                B
              </div>
              <div>
                <h3 className="text-body font-bold text-fg flex items-center gap-1.5">
                  Agente Bia
                  <Sparkles size={13} className="text-rose-400" />
                </h3>
                <p className="text-[11px] text-rose-400 font-medium">Vinculada aos Gastos / Operação: <strong>Amanda</strong></p>
              </div>
            </div>
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-rose-500/20 text-rose-300 border border-rose-500/30">
              Ativo
            </span>
          </div>

          <div className="mt-4 space-y-2 text-micro">
            <div className="bg-surface-base p-2.5 rounded-xl border border-line-subtle">
              <span className="text-fg-faint block uppercase text-[10px]">Chave de API / Header:</span>
              <code className="text-rose-300 font-mono font-bold break-all">
                Authorization: Bearer sac_agent_bia_live_2026
              </code>
            </div>
            <p className="text-fg-subtle text-[11px] leading-relaxed">
              <strong>Escopo de Atuação & Gastos:</strong> Atendimento, triagem e conversão associados à conta e campanhas da <strong>Amanda</strong>. Toda ação executada registra <code>responsibleAgent: &quot;Bia&quot;</code> e <code>lastActionBy: &quot;Bia (Agente IA)&quot;</code>.
            </p>
          </div>
        </div>

        {/* Card Luana (Gastão) */}
        <div className="bg-surface-raised border border-purple-500/30 rounded-2xl p-5 relative overflow-hidden shadow-sm">
          <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/10 rounded-full blur-2xl pointer-events-none" />
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/40 flex items-center justify-center text-purple-400 font-black text-base shadow-sm">
                L
              </div>
              <div>
                <h3 className="text-body font-bold text-fg flex items-center gap-1.5">
                  Agente Luana
                  <Sparkles size={13} className="text-purple-400" />
                </h3>
                <p className="text-[11px] text-purple-400 font-medium">Vinculada aos Gastos / Operação: <strong>Gastão</strong></p>
              </div>
            </div>
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-300 border border-purple-500/30">
              Ativo
            </span>
          </div>

          <div className="mt-4 space-y-2 text-micro">
            <div className="bg-surface-base p-2.5 rounded-xl border border-line-subtle">
              <span className="text-fg-faint block uppercase text-[10px]">Chave de API / Header:</span>
              <code className="text-purple-300 font-mono font-bold break-all">
                Authorization: Bearer sac_agent_luana_live_2026
              </code>
            </div>
            <p className="text-fg-subtle text-[11px] leading-relaxed">
              <strong>Escopo de Atuação & Gastos:</strong> Atendimento, reservas e fechamentos associados à conta e campanhas do <strong>Gastão Matos</strong>. Toda ação executada registra <code>responsibleAgent: &quot;Luana&quot;</code> e <code>lastActionBy: &quot;Luana (Agente IA)&quot;</code>.
            </p>
          </div>
        </div>
      </div>

      {/* Alerta de Segurança & Rastreamento */}
      <div className="bg-blue-500/10 border border-blue-500/25 rounded-2xl p-4 flex items-start gap-3">
        <Shield size={20} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-micro space-y-1">
          <h4 className="font-bold text-fg">Rastreabilidade Total & Allowlist de IPs</h4>
          <p className="text-fg-subtle text-[11px] leading-relaxed">
            Cada ação realizada (criação de lead, avanço de etapa no funil, envio de mensagem ou pausa do bot) é registrada no <strong>Log de Auditoria</strong> com a autoria de quem mexeu (<span className="text-purple-400 font-bold">Luana</span> ou <span className="text-emerald-400 font-bold">Renato</span>). Se a restrição por IP estiver ativada, as chamadas devem se originar estritamente dos IPs cadastrados da sua VPS.
          </p>
        </div>
      </div>

      {/* Filtro por Categorias de Endpoints */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle pb-3">
        {[
          { id: 'all', label: 'Todos os Endpoints' },
          { id: 'leads', label: 'Funil & Leads' },
          { id: 'conversas', label: 'WhatsApp & Conversas' },
          { id: 'config', label: 'Empresas & Configurações' },
          { id: 'analytics', label: 'Métricas & Conversão' },
        ].map(cat => (
          <button
            key={cat.id}
            onClick={() => setSelectedCategory(cat.id)}
            className={cn(
              "px-3 py-1.5 rounded-xl text-micro font-bold transition-all cursor-pointer",
              selectedCategory === cat.id
                ? "bg-brand-solid text-black shadow-sm"
                : "bg-surface-raised border border-line-subtle text-fg-subtle hover:text-fg hover:border-brand-ink/40"
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Lista de Endpoints */}
      <div className="space-y-4">
        {filteredEndpoints.map((ep) => {
          const isExpanded = expandedEndpoint === ep.id
          const currentTab = activeCodeTab[ep.id] || 'curl'

          return (
            <div
              key={ep.id}
              className="bg-surface-raised border border-line-subtle rounded-2xl overflow-hidden shadow-sm transition-all"
            >
              {/* Header do Endpoint */}
              <div
                onClick={() => setExpandedEndpoint(isExpanded ? null : ep.id)}
                className="p-4 flex items-center justify-between gap-3 cursor-pointer hover:bg-surface-base/50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={cn(
                      "font-mono font-black text-xs px-2.5 py-1 rounded-lg uppercase tracking-wider shrink-0",
                      ep.method === 'GET' && "bg-blue-500/15 text-blue-400 border border-blue-500/30",
                      ep.method === 'POST' && "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
                      ep.method === 'PATCH' && "bg-amber-500/15 text-amber-400 border border-amber-500/30",
                      ep.method === 'DELETE' && "bg-red-500/15 text-red-400 border border-red-500/30"
                    )}
                  >
                    {ep.method}
                  </span>
                  <code className="text-body font-mono font-bold text-fg truncate">
                    {ep.path}
                  </code>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-micro text-fg-subtle hidden md:inline">
                    {ep.title}
                  </span>
                  <ChevronDown
                    size={16}
                    className={cn("text-fg-subtle transition-transform duration-200", isExpanded && "rotate-180")}
                  />
                </div>
              </div>

              {/* Corpo Expandido */}
              {isExpanded && (
                <div className="p-5 border-t border-line-subtle bg-surface-base space-y-4">
                  <p className="text-micro text-fg-subtle leading-relaxed">
                    {ep.description}
                  </p>

                  {/* Tabela de Parâmetros se houver */}
                  {ep.params && ep.params.length > 0 && (
                    <div className="space-y-1.5">
                      <h4 className="text-[11px] uppercase font-bold text-fg-subtle tracking-wider">Parâmetros do Payload:</h4>
                      <div className="border border-line-subtle rounded-xl overflow-hidden">
                        <table className="w-full text-micro text-left">
                          <thead className="bg-surface-raised border-b border-line-subtle text-fg-faint uppercase text-[10px]">
                            <tr>
                              <th className="p-2.5">Campo</th>
                              <th className="p-2.5">Tipo</th>
                              <th className="p-2.5">Obrigatório</th>
                              <th className="p-2.5">Descrição</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line-subtle text-fg">
                            {ep.params.map(p => (
                              <tr key={p.name} className="hover:bg-surface-raised/40">
                                <td className="p-2.5 font-mono font-bold text-brand-ink">{p.name}</td>
                                <td className="p-2.5 text-fg-subtle font-mono">{p.type}</td>
                                <td className="p-2.5">
                                  {p.required ? (
                                    <span className="text-red-400 font-bold">Sim</span>
                                  ) : (
                                    <span className="text-fg-faint">Não</span>
                                  )}
                                </td>
                                <td className="p-2.5 text-fg-subtle">{p.description}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Abas de Código Exemplo */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1 bg-surface-raised p-1 rounded-xl border border-line-subtle">
                        {(['curl', 'python', 'node'] as const).map(tab => (
                          <button
                            key={tab}
                            onClick={() => setActiveCodeTab(prev => ({ ...prev, [ep.id]: tab }))}
                            className={cn(
                              "px-2.5 py-1 rounded-lg text-micro font-bold uppercase transition-all cursor-pointer",
                              currentTab === tab
                                ? "bg-brand-solid text-black shadow-xs"
                                : "text-fg-subtle hover:text-fg"
                            )}
                          >
                            {tab === 'curl' ? 'cURL' : tab === 'python' ? 'Python' : 'Node.js'}
                          </button>
                        ))}
                      </div>

                      <button
                        onClick={() => handleCopy(getCodeSnippet(ep, currentTab), ep.id)}
                        className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-surface-raised border border-line-subtle text-fg hover:border-brand-ink transition-all cursor-pointer"
                      >
                        {copiedId === ep.id ? (
                          <>
                            <Check size={12} className="text-emerald-400" />
                            <span className="text-emerald-400">Copiado!</span>
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            <span>Copiar Código</span>
                          </>
                        )}
                      </button>
                    </div>

                    <pre className="p-3.5 rounded-xl bg-surface-inset border border-line-subtle text-xs font-mono text-fg overflow-x-auto scroll-thin">
                      {getCodeSnippet(ep, currentTab)}
                    </pre>
                  </div>

                  {/* Exemplo de Resposta */}
                  <div className="space-y-1.5">
                    <h4 className="text-[11px] uppercase font-bold text-fg-subtle tracking-wider">Resposta da API (JSON):</h4>
                    <pre className="p-3.5 rounded-xl bg-surface-inset border border-line-subtle text-xs font-mono text-emerald-400 overflow-x-auto scroll-thin">
                      {JSON.stringify(ep.responseExample, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
