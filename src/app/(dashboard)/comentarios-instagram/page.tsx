'use client'

import { PageHeader } from '@/components/ui/page-header'
import { useState, useEffect } from 'react'
import {
  MessageCircle,
  Plus,
  Play,
  Pause,
  Trash2,
  Edit2,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Shield,
  EyeOff,
  Sparkles,
  Send,
  X,
} from 'lucide-react'

// lucide-react removeu os ícones de marca (Instagram incluso) a partir da v1.
// Mesmo padrão já usado em canais/page.tsx, origens/page.tsx e kanban-board.tsx.
function InstagramIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

interface AutomationRule {
  id: number
  name: string
  mediaId: string | null
  mediaUrl: string | null
  mediaCaption: string | null
  keywords: string | null
  matchType: string
  dmMessage: string
  publicReply: string | null
  hideCommentAfterReply: boolean
  activeHoursStart: string | null
  activeHoursEnd: string | null
  isActive: boolean
  requireFollowCheck: boolean
  totalTriggered: number
  createdAt: string
}

interface CommentLog {
  id: number
  automationId: number | null
  automationName: string | null
  commentId: string
  commenterId: string
  commenterUsername: string | null
  mediaId: string | null
  commentText: string | null
  matchedKeyword: string | null
  status: string
  errorMessage: string | null
  sentAt: string | null
  createdAt: string
}

interface MediaItem {
  id: string
  caption?: string
  media_type?: string
  media_url?: string
  thumbnail_url?: string
  permalink?: string
  timestamp?: string
}

export default function ComentariosInstagramPage() {
  const [activeTab, setActiveTab] = useState<'regras' | 'logs'>('regras')
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [logs, setLogs] = useState<CommentLog[]>([])
  const [recentMedia, setRecentMedia] = useState<MediaItem[]>([])
  const [loadingMedia, setLoadingMedia] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formPostType, setFormPostType] = useState<'all' | 'specific'>('all')
  const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null)
  const [formKeywords, setFormKeywords] = useState('')
  const [formMatchType, setFormMatchType] = useState<'contains' | 'exact' | 'any'>('contains')
  const [formDmMessage, setFormDmMessage] = useState('')
  const [formPublicReply, setFormPublicReply] = useState('')
  const [formHideComment, setFormHideComment] = useState(false)
  const [formHoursStart, setFormHoursStart] = useState('')
  const [formHoursEnd, setFormHoursEnd] = useState('')
  const [formRequireFollowCheck, setFormRequireFollowCheck] = useState(false)

  const loadData = async () => {
    setLoading(true)
    try {
      const [rulesRes, logsRes] = await Promise.all([
        fetch('/api/comment-automations'),
        fetch('/api/comment-automations/all/logs'),
      ])

      if (rulesRes.ok) {
        const rulesData = await rulesRes.json()
        setRules(rulesData.automations || [])
      }

      if (logsRes.ok) {
        const logsData = await logsRes.json()
        setLogs(logsData.logs || [])
      }
    } catch (err) {
      console.error('Erro ao carregar dados:', err)
    } finally {
      setLoading(false)
    }
  }

  const loadMedia = async () => {
    setLoadingMedia(true)
    try {
      const res = await fetch('/api/comment-automations/media')
      if (res.ok) {
        const data = await res.json()
        if (data.ok && Array.isArray(data.media)) {
          setRecentMedia(data.media)
        }
      }
    } catch (err) {
      console.error('Erro ao buscar mídias:', err)
    } finally {
      setLoadingMedia(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const openNewModal = () => {
    setEditingRule(null)
    setFormName('')
    setFormPostType('all')
    setSelectedMedia(null)
    setFormKeywords('QUERO, LINK, PRECO')
    setFormMatchType('contains')
    setFormDmMessage('Olá! Vi seu comentário no post. Aqui está o link que você pediu: [LINK]')
    setFormPublicReply('Te chamei no direct com todos os detalhes! Dá uma olhada 🚀')
    setFormHideComment(false)
    setFormHoursStart('')
    setFormHoursEnd('')
    setFormRequireFollowCheck(false)
    setActionError(null)
    setIsModalOpen(true)
    loadMedia()
  }

  const openEditModal = (rule: AutomationRule) => {
    setEditingRule(rule)
    setFormName(rule.name)
    setFormPostType(rule.mediaId ? 'specific' : 'all')
    if (rule.mediaId) {
      setSelectedMedia({
        id: rule.mediaId,
        caption: rule.mediaCaption || undefined,
        media_url: rule.mediaUrl || undefined,
        thumbnail_url: rule.mediaUrl || undefined,
      })
    } else {
      setSelectedMedia(null)
    }
    setFormKeywords(rule.keywords || '')
    setFormMatchType((rule.matchType as any) || 'contains')
    setFormDmMessage(rule.dmMessage)
    setFormPublicReply(rule.publicReply || '')
    setFormHideComment(rule.hideCommentAfterReply)
    setFormHoursStart(rule.activeHoursStart || '')
    setFormHoursEnd(rule.activeHoursEnd || '')
    setFormRequireFollowCheck(rule.requireFollowCheck)
    setActionError(null)
    setIsModalOpen(true)
    loadMedia()
  }

  const toggleRuleActive = async (rule: AutomationRule) => {
    try {
      const res = await fetch(`/api/comment-automations/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !rule.isActive }),
      })
      if (res.ok) {
        setRules(prev =>
          prev.map(r => (r.id === rule.id ? { ...r, isActive: !r.isActive } : r))
        )
      }
    } catch (err) {
      console.error('Erro ao alternar status:', err)
    }
  }

  const deleteRule = async (rule: AutomationRule) => {
    if (!confirm(`Deseja realmente excluir a automação "${rule.name}"?`)) return
    try {
      const res = await fetch(`/api/comment-automations/${rule.id}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setRules(prev => prev.filter(r => r.id !== rule.id))
      }
    } catch (err) {
      console.error('Erro ao excluir automação:', err)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formName.trim()) {
      setActionError('O nome da automação é obrigatório.')
      return
    }
    if (!formDmMessage.trim()) {
      setActionError('A mensagem da DM é obrigatória.')
      return
    }

    setSubmitting(true)
    setActionError(null)

    const payload = {
      name: formName.trim(),
      mediaId: formPostType === 'specific' ? selectedMedia?.id || null : null,
      mediaUrl: formPostType === 'specific' ? selectedMedia?.media_url || selectedMedia?.thumbnail_url || null : null,
      mediaCaption: formPostType === 'specific' ? selectedMedia?.caption || null : null,
      keywords: formMatchType === 'any' ? null : formKeywords.trim(),
      matchType: formMatchType,
      dmMessage: formDmMessage.trim(),
      publicReply: formPublicReply.trim() || null,
      hideCommentAfterReply: formHideComment,
      activeHoursStart: formHoursStart.trim() || null,
      activeHoursEnd: formHoursEnd.trim() || null,
      requireFollowCheck: formRequireFollowCheck,
    }

    try {
      if (editingRule) {
        const res = await fetch(`/api/comment-automations/${editingRule.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (!res.ok) {
          setActionError(data.error || 'Erro ao atualizar regra.')
          return
        }
        setIsModalOpen(false)
        loadData()
      } else {
        const res = await fetch('/api/comment-automations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (!res.ok) {
          setActionError(data.error || 'Erro ao criar regra.')
          return
        }
        setIsModalOpen(false)
        loadData()
      }
    } catch (err: any) {
      setActionError(err?.message || 'Erro de conexão.')
    } finally {
      setSubmitting(false)
    }
  }

  // Métricas
  const totalActive = rules.filter(r => r.isActive).length
  const totalSent = logs.filter(l => l.status === 'sent').length
  const totalFailed = logs.filter(l => l.status === 'failed').length
  const successRate = totalSent + totalFailed > 0 ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(1) : '100.0'

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* Header */}
      <PageHeader
        icon={<InstagramIcon size={22} />}
        title="Comentário vira DM no Instagram"
        description="Transforme quem comenta nos seus posts e reels em leads no Direct e no Inbox do SAC em tempo real."
        eyebrow={<>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-pink-400 bg-pink-500/10 px-2.5 py-0.5 rounded-full border border-pink-500/30">
              <InstagramIcon size={12} />
              Automação Oficial Meta Graph API
            </span>
          </div>
        </>}
        actions={<>
          <div className="flex items-center gap-2.5">
            <button
              onClick={loadData}
              title="Atualizar Dados"
              aria-label="Atualizar dados das automações"
              className="p-2.5 rounded-xl bg-surface-raised border border-line-subtle text-fg-muted hover:text-fg hover:bg-surface-base transition-colors"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={openNewModal}
              className="btn btn-primary flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs"
            >
              <Plus size={16} />
              Nova Automação
            </button>
          </div>
        </>}
        className="shrink-0"
      />

      {/* Cards de Métricas */}
      <div className="rise rise-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[var(--space-gutter)]">
        <div className="card bg-surface-raised border border-line-subtle p-4 rounded-2xl">
          <span className="text-micro text-fg-subtle">Regras Configuradas</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-h2 text-fg font-black">{rules.length}</span>
            <span className="text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
              {totalActive} ativas
            </span>
          </div>
        </div>

        <div className="card bg-surface-raised border border-line-subtle p-4 rounded-2xl">
          <span className="text-micro text-fg-subtle">DMs Disparadas</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-h2 text-fg font-black">{totalSent}</span>
            <span className="text-micro text-fg-faint">Meta Direct</span>
          </div>
        </div>

        <div className="card bg-surface-raised border border-line-subtle p-4 rounded-2xl">
          <span className="text-micro text-fg-subtle">Taxa de Sucesso</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-h2 text-emerald-400 font-black">{successRate}%</span>
            <span className="text-micro text-fg-faint">{totalFailed} falhas</span>
          </div>
        </div>

        <div className="card bg-surface-raised border border-line-subtle p-4 rounded-2xl">
          <span className="text-micro text-fg-subtle">Proteção & Rate Limit</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-h2 text-sky-400 font-black">750/h</span>
            <span className="text-[10px] font-bold text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded-full border border-sky-500/20 flex items-center gap-1">
              <Shield size={10} /> Seguro
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-line-subtle pb-2">
        <button
          onClick={() => setActiveTab('regras')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors ${
            activeTab === 'regras'
              ? 'bg-surface-raised text-fg border border-line-subtle shadow-sm'
              : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
          }`}
        >
          Regras de Automação ({rules.length})
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors ${
            activeTab === 'logs'
              ? 'bg-surface-raised text-fg border border-line-subtle shadow-sm'
              : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
          }`}
        >
          Histórico de Disparos ({logs.length})
        </button>
      </div>

      {/* Conteúdo Tab 1: Regras */}
      {activeTab === 'regras' && (
        <div className="space-y-4">
          {rules.length === 0 && !loading && (
            <div className="card bg-surface-raised border border-dashed border-line-subtle p-10 rounded-2xl text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-pink-500/10 text-pink-400 border border-pink-500/20 mx-auto flex items-center justify-center">
                <MessageCircle size={24} />
              </div>
              <h3 className="text-h3 text-fg font-bold">Nenhuma regra criada ainda</h3>
              <p className="text-body text-fg-muted max-w-md mx-auto">
                Crie sua primeira automação para responder comentários automaticamente no direct e capturar leads no Inbox do SAC.
              </p>
              <button
                onClick={openNewModal}
                className="btn btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-xs mt-2"
              >
                <Plus size={16} />
                Criar Primeira Regra
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
            {rules.map(rule => (
              <div
                key={rule.id}
                className={`card bg-surface-raised border p-5 rounded-2xl flex flex-col justify-between space-y-4 transition-all ${
                  rule.isActive ? 'border-line-subtle' : 'border-line-subtle/50 opacity-75'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                            rule.isActive
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : 'bg-surface-inset text-fg-subtle border-line-subtle'
                          }`}
                        >
                          {rule.isActive ? 'Ativa' : 'Pausada'}
                        </span>
                        {rule.hideCommentAfterReply && (
                          <span className="text-[9px] uppercase font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                            <EyeOff size={10} /> Oculta Comentário
                          </span>
                        )}
                        {rule.requireFollowCheck && (
                          <span className="text-[9px] uppercase font-bold px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center gap-1">
                            <Shield size={10} /> Exige Seguir
                          </span>
                        )}
                      </div>
                      <h3 className="text-h3 text-fg font-bold mt-2 truncate">{rule.name}</h3>
                      <p className="text-micro text-fg-subtle">
                        {rule.mediaId ? 'Gatilho: Post/Reel Específico' : 'Gatilho: Qualquer Post/Reel'}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => toggleRuleActive(rule)}
                        title={rule.isActive ? 'Pausar Automação' : 'Ativar Automação'}
                        className={`p-2 rounded-xl border transition-colors ${
                          rule.isActive
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                            : 'bg-surface-inset text-fg-muted border-line-subtle hover:text-fg'
                        }`}
                      >
                        {rule.isActive ? <Pause size={14} /> : <Play size={14} />}
                      </button>
                      <button
                        onClick={() => openEditModal(rule)}
                        title="Editar Regra"
                        className="p-2 rounded-xl bg-surface-inset text-fg-muted hover:text-fg hover:bg-surface-base border border-line-subtle transition-colors"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => deleteRule(rule)}
                        title="Excluir Regra"
                        className="p-2 rounded-xl bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Palavras-chave */}
                  <div className="mt-3 pt-3 border-t border-line-subtle">
                    <span className="text-micro text-fg-subtle font-semibold block mb-1.5">
                      Palavras-chave ({rule.matchType === 'any' ? 'Qualquer Comentário' : rule.matchType}):
                    </span>
                    {rule.matchType === 'any' ? (
                      <span className="text-[11px] font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                        * (Qualquer texto ou emoji)
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {(rule.keywords || '')
                          .split(',')
                          .map((k, i) => k.trim())
                          .filter(Boolean)
                          .map((kw, i) => (
                            <span
                              key={i}
                              className="text-[11px] font-mono text-fg font-medium bg-surface-inset px-2 py-0.5 rounded border border-line-subtle"
                            >
                              {kw}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>

                  {/* Prévia da DM */}
                  <div className="mt-3 bg-surface-base border border-line-subtle rounded-xl p-3">
                    <div className="flex items-center gap-1.5 text-micro text-fg-muted mb-1 font-semibold">
                      <Send size={11} className="text-pink-400" />
                      DM Enviada:
                    </div>
                    <p className="text-[12px] text-fg leading-relaxed whitespace-pre-wrap">{rule.dmMessage}</p>
                    {rule.publicReply && (
                      <div className="mt-2 pt-2 border-t border-line-subtle/50 text-[11px] text-fg-muted">
                        <span className="font-semibold text-fg-subtle">Resposta Pública:</span> {rule.publicReply}
                      </div>
                    )}
                  </div>
                </div>

                {/* Rodapé do Card */}
                <div className="flex items-center justify-between text-micro text-fg-subtle pt-2 border-t border-line-subtle">
                  <span>Disparos realizados: <strong className="text-fg">{rule.totalTriggered}</strong></span>
                  {rule.activeHoursStart && rule.activeHoursEnd ? (
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> {rule.activeHoursStart} às {rule.activeHoursEnd}
                    </span>
                  ) : (
                    <span>24h por dia</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conteúdo Tab 2: Histórico / Logs */}
      {activeTab === 'logs' && (
        <div className="card bg-surface-raised border border-line-subtle rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-line-subtle flex items-center justify-between">
            <span className="text-xs font-bold text-fg uppercase tracking-wider">
              Últimos Comentários & Disparos
            </span>
            <span className="text-micro text-fg-subtle">
              Atualizado automaticamente a cada comentário
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-line-subtle bg-surface-base text-fg-subtle uppercase text-[10px] tracking-wider">
                  <th className="p-3">Data / Hora</th>
                  <th className="p-3">Usuário</th>
                  <th className="p-3">Comentário</th>
                  <th className="p-3">Palavra Casada</th>
                  <th className="p-3">Regra</th>
                  <th className="p-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle/60 text-fg">
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-fg-subtle">
                      Nenhum disparo registrado ainda.
                    </td>
                  </tr>
                )}
                {logs.map(log => (
                  <tr key={log.id} className="hover:bg-surface-base/50 transition-colors">
                    <td className="p-3 text-fg-muted font-mono whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString('pt-BR')}
                    </td>
                    <td className="p-3 font-semibold text-fg whitespace-nowrap">
                      {log.commenterUsername ? `@${log.commenterUsername}` : `ID: ${log.commenterId.slice(-6)}`}
                    </td>
                    <td className="p-3 max-w-xs truncate text-fg-muted" title={log.commentText || ''}>
                      &quot;{log.commentText || '—'}&quot;
                    </td>
                    <td className="p-3 font-mono text-[11px] text-brand-ink">
                      {log.matchedKeyword || '—'}
                    </td>
                    <td className="p-3 text-fg-muted max-w-xs truncate">
                      {log.automationName || 'Geral'}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                          log.status === 'sent'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : log.status === 'failed'
                            ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                            : log.status === 'rate_limited'
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : 'bg-surface-inset text-fg-subtle border-line-subtle'
                        }`}
                        title={log.errorMessage || ''}
                      >
                        {log.status === 'sent' && <CheckCircle2 size={11} />}
                        {log.status === 'failed' && <AlertCircle size={11} />}
                        {log.status === 'sent'
                          ? 'DM Enviada'
                          : log.status === 'failed'
                          ? 'Falha'
                          : log.status === 'rate_limited'
                          ? 'Rate Limit'
                          : 'Ignorado'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal de Criação / Edição */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="card bg-surface-raised border border-line-subtle w-full max-w-2xl rounded-3xl shadow-2xl relative flex flex-col max-h-[92vh] sm:max-h-[88vh] overflow-hidden">
            <button
              onClick={() => setIsModalOpen(false)}
              className="absolute right-4 top-4 sm:right-5 sm:top-5 p-2 rounded-xl text-fg-muted hover:text-fg hover:bg-surface-base z-10"
            >
              <X size={18} />
            </button>

            <div className="px-5 pt-5 pb-3 sm:px-6 sm:pt-6 sm:pb-4 pr-12 border-b border-line-subtle shrink-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-micro font-bold text-pink-400 uppercase tracking-wider">
                  {editingRule ? 'Editar Automação' : 'Nova Automação'}
                </span>
              </div>
              <h2 className="text-h2 text-fg font-black">
                {editingRule ? 'Editar Regra de Comentário' : 'Criar Regra de Comentário → DM'}
              </h2>
              <p className="text-body text-fg-muted text-xs mt-0.5">
                Quando alguém comentar as palavras-chave no Instagram, o SAC responderá na DM instantaneamente.
              </p>
            </div>

            <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0">
              <div className="px-5 py-4 sm:px-6 sm:py-5 space-y-4 overflow-y-auto flex-1 overscroll-contain">
                {actionError && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
                    <AlertCircle size={15} />
                    <span>{actionError}</span>
                  </div>
                )}

              {/* Nome da Regra */}
              <div>
                <label className="block text-micro font-bold text-fg mb-1">Nome da Automação *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="Ex: Entrega E-book Grátis - Reels Tráfego"
                  required
                  className="w-full px-3.5 py-2.5 rounded-xl bg-surface-base border border-line-subtle text-fg text-xs focus:border-brand-solid outline-none"
                />
              </div>

              {/* Seletor de Post */}
              <div>
                <label className="block text-micro font-bold text-fg mb-1">Gatilho de Post/Reel</label>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => {
                      setFormPostType('all')
                      setSelectedMedia(null)
                    }}
                    className={`p-2.5 rounded-xl text-xs font-bold border transition-colors ${
                      formPostType === 'all'
                        ? 'bg-pink-500/10 text-pink-400 border-pink-500/30'
                        : 'bg-surface-base text-fg-muted border-line-subtle'
                    }`}
                  >
                    Qualquer Post / Reel da Conta
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormPostType('specific')}
                    className={`p-2.5 rounded-xl text-xs font-bold border transition-colors ${
                      formPostType === 'specific'
                        ? 'bg-pink-500/10 text-pink-400 border-pink-500/30'
                        : 'bg-surface-base text-fg-muted border-line-subtle'
                    }`}
                  >
                    Post / Reel Específico
                  </button>
                </div>

                {formPostType === 'specific' && (
                  <div className="mt-2 space-y-2">
                    {loadingMedia ? (
                      <div className="text-center py-4 text-xs text-fg-muted flex items-center justify-center gap-2">
                        <RefreshCw size={14} className="animate-spin" /> Carregando posts do Instagram...
                      </div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto border border-line-subtle rounded-xl p-2 bg-surface-base grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {recentMedia.length === 0 && (
                          <div className="col-span-2 text-center py-4 text-xs text-fg-muted">
                            Nenhum post recente encontrado na conta ou token ainda não configurado.
                          </div>
                        )}
                        {recentMedia.map(item => {
                          const isSelected = selectedMedia?.id === item.id
                          return (
                            <div
                              key={item.id}
                              onClick={() => setSelectedMedia(item)}
                              className={`p-2 rounded-lg border cursor-pointer flex items-center gap-2 transition-all ${
                                isSelected
                                  ? 'border-pink-500 bg-pink-500/10'
                                  : 'border-line-subtle hover:bg-surface-raised'
                              }`}
                            >
                              {item.thumbnail_url || item.media_url ? (
                                <img
                                  src={item.thumbnail_url || item.media_url}
                                  alt="Post"
                                  className="w-10 h-10 rounded object-cover shrink-0"
                                />
                              ) : (
                                <div className="w-10 h-10 rounded bg-surface-raised flex items-center justify-center shrink-0">
                                  <InstagramIcon size={16} className="text-fg-faint" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <p className="text-[11px] text-fg truncate font-medium">
                                  {item.caption || 'Sem legenda'}
                                </p>
                                <span className="text-[10px] text-fg-faint">ID: {item.id.slice(-6)}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Palavras-chave e Tipo de Match */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-micro font-bold text-fg">Palavras-chave de Acionamento</label>
                  <select
                    value={formMatchType}
                    onChange={e => setFormMatchType(e.target.value as any)}
                    className="px-2 py-1 rounded-lg bg-surface-base border border-line-subtle text-[11px] text-fg font-semibold outline-none"
                  >
                    <option value="contains">Contém a palavra (Recomendado)</option>
                    <option value="exact">Comentário exato</option>
                    <option value="any">Qualquer comentário (*)</option>
                  </select>
                </div>

                {formMatchType !== 'any' && (
                  <input
                    type="text"
                    value={formKeywords}
                    onChange={e => setFormKeywords(e.target.value)}
                    placeholder="Separe por vírgula: QUERO, LINK, PRECO, EU QUERO"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-surface-base border border-line-subtle text-fg text-xs focus:border-brand-solid outline-none"
                  />
                )}
                <span className="text-[10px] text-fg-subtle mt-1 block">
                  {formMatchType === 'any'
                    ? 'Disparará a DM para qualquer comentário recebido no post.'
                    : 'A busca não diferencia maiúsculas de minúsculas nem acentos (ex: "quero" aciona "QUERO").'}
                </span>
              </div>

              {/* Mensagem da DM */}
              <div>
                <label className="block text-micro font-bold text-fg mb-1">Mensagem enviada no Direct (DM) *</label>
                <textarea
                  value={formDmMessage}
                  onChange={e => setFormDmMessage(e.target.value)}
                  rows={3}
                  required
                  placeholder="Olá! Como prometido, aqui está o link oficial: https://..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-surface-base border border-line-subtle text-fg text-xs focus:border-brand-solid outline-none resize-none"
                />
              </div>

              {/* Opções Avançadas: Resposta Pública e Ocultar */}
              <div className="p-3.5 rounded-2xl bg-surface-base border border-line-subtle space-y-3">
                <span className="text-micro font-bold text-fg uppercase tracking-wider block">
                  Ações Complementares Opcionais
                </span>

                <div>
                  <label className="block text-micro font-medium text-fg-muted mb-1">
                    Resposta pública no comentário (opcional)
                  </label>
                  <input
                    type="text"
                    value={formPublicReply}
                    onChange={e => setFormPublicReply(e.target.value)}
                    placeholder="Ex: Acabei de te mandar no direct! Dá uma olhada 🚀"
                    className="w-full px-3 py-2 rounded-lg bg-surface-raised border border-line-subtle text-fg text-xs outline-none"
                  />
                </div>

                <div className="flex items-center justify-between pt-1">
                  <div>
                    <span className="text-xs font-semibold text-fg block">Ocultar comentário após responder</span>
                    <span className="text-[10px] text-fg-subtle">
                      Útil para manter a postagem limpa e evitar spam de concorrentes.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={formHideComment}
                    onChange={e => setFormHideComment(e.target.checked)}
                    className="w-4 h-4 rounded accent-brand-solid cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between pt-1 border-t border-line-subtle/60 mt-1">
                  <div className="pr-3">
                    <span className="text-xs font-semibold text-fg block">
                      Exigir que a pessoa siga a conta antes de liberar
                    </span>
                    <span className="text-[10px] text-fg-subtle">
                      Em vez da DM final, manda uma pergunta primeiro. Só libera o conteúdo depois de confirmar de verdade (Graph API) que a pessoa segue a conta.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={formRequireFollowCheck}
                    onChange={e => setFormRequireFollowCheck(e.target.checked)}
                    className="w-4 h-4 rounded accent-brand-solid cursor-pointer shrink-0"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <label className="block text-[11px] text-fg-subtle mb-0.5">Horário Inicial (Opcional)</label>
                    <input
                      type="text"
                      value={formHoursStart}
                      onChange={e => setFormHoursStart(e.target.value)}
                      placeholder="Ex: 08:00"
                      className="w-full px-3 py-1.5 rounded-lg bg-surface-raised border border-line-subtle text-fg text-xs outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-fg-subtle mb-0.5">Horário Final (Opcional)</label>
                    <input
                      type="text"
                      value={formHoursEnd}
                      onChange={e => setFormHoursEnd(e.target.value)}
                      placeholder="Ex: 22:00"
                      className="w-full px-3 py-1.5 rounded-lg bg-surface-raised border border-line-subtle text-fg text-xs outline-none"
                    />
                  </div>
                </div>
              </div>
              </div>

              {/* Ações */}
              <div className="flex items-center justify-end gap-3 px-5 py-3.5 sm:px-6 sm:py-4 border-t border-line-subtle shrink-0">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-fg-muted hover:text-fg hover:bg-surface-base"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn btn-primary px-6 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2"
                >
                  {submitting && <RefreshCw size={14} className="animate-spin" />}
                  {editingRule ? 'Salvar Alterações' : 'Criar Automação'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
