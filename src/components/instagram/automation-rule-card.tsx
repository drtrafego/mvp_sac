'use client'
import { Pause, Play, Edit2, Trash2, EyeOff, Shield, Send, Clock } from 'lucide-react'
import { AutomationHistory, RuleMetrics, StoryBadge } from './automation-history'
import type { Totals, ReportPeriod, AutomationType } from '@/lib/instagram-automation-reporting'
export interface AutomationRule {
  id: number
  name: string
  mediaId: string | null
  mediaUrl: string | null
  mediaCaption: string | null
  keywords: string | null
  matchType: string
  triggerType: 'comment' | 'direct' | 'both'
  dmMessage: string
  publicReply: string | null
  hideCommentAfterReply: boolean
  activeHoursStart: string | null
  activeHoursEnd: string | null
  isActive: boolean
  requireFollowCheck: boolean
  autoTag: string | null
  totalTriggered: number
  createdAt: string
}

export function AutomationRuleCard({ rule, type, totals, period, onToggle, onEdit, onDelete, busy = false }: { rule: AutomationRule; type: AutomationType; totals?: Totals; period?: ReportPeriod; onToggle: () => void; onEdit: () => void; onDelete: () => void; busy?: boolean }) {
return (              <div
                data-automation-type={type}
                className={`card bg-surface-raised border p-5 rounded-2xl flex flex-col justify-between space-y-4 transition-all ${
                  type === 'story' ? 'border-st-info' : rule.isActive ? 'border-line-subtle' : 'border-line-subtle/50'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                            rule.isActive
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : 'bg-surface-inset text-fg-subtle border-line-subtle'
                          }`}
                        >
                          {rule.isActive ? 'Ativa' : 'Pausada'}
                        </span>
                        {type === 'story' ? <StoryBadge /> : (                        <span className="text-[9px] uppercase font-bold px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/20">
                          {rule.triggerType === 'direct' ? 'Direct' : rule.triggerType === 'both' ? 'Comentário + Direct' : 'Comentário'}
                        </span>)}
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
                        {type === 'story' ? (rule.mediaId ? 'Gatilho: Resposta a um Story específico' : 'Gatilho: Resposta a qualquer Story') : rule.triggerType === 'direct' ? 'Gatilho: Palavra no Direct' : rule.triggerType === 'both' ? `Gatilho: Comentário + Direct${rule.mediaId ? ', Post/Reel Específico' : ', Qualquer Post/Reel'}` : rule.mediaId ? 'Gatilho: Comentário, Post/Reel Específico' : 'Gatilho: Comentário, Qualquer Post/Reel'}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => onToggle()}
                        title={rule.isActive ? 'Pausar Automação' : 'Ativar Automação'}
                        role="switch" aria-checked={rule.isActive} aria-label={`Ativar ${rule.name}`}
                        disabled={busy}
                        className={`p-2 rounded-xl border transition-colors ${
                          rule.isActive
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                            : 'bg-surface-inset text-fg-muted border-line-subtle hover:text-fg'
                        }`}
                      >
                        {rule.isActive ? <Pause size={14} /> : <Play size={14} />}
                      </button>
                      <button
                        onClick={() => onEdit()}
                        title="Editar Regra" aria-label={`Editar ${rule.name}`} disabled={busy}
                        className="p-2 rounded-xl bg-surface-inset text-fg-muted hover:text-fg hover:bg-surface-base border border-line-subtle transition-colors"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => onDelete()}
                        title="Excluir Regra" aria-label={`Excluir ${rule.name}`} disabled={busy}
                        className="p-2 rounded-xl bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Palavras-chave */}
                  <div className="mt-3 pt-3 border-t border-line-subtle">
                    <span className="text-micro text-fg-subtle font-semibold block mb-1.5">
                      Palavras-chave ({rule.matchType === 'any' ? 'Qualquer resposta' : rule.matchType === 'exact' ? 'Exatamente igual' : 'Contém'}):
                    </span>
                    {rule.matchType === 'any' ? (
                      <span className="text-[11px] font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                        * (Qualquer texto ou emoji)
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {(rule.keywords || '')
                          .split(',')
                          .map(k => k.trim())
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

                <RuleMetrics totals={totals} />
                <AutomationHistory type={type} id={rule.id} period={period} />
                {/* Rodapé do Card */}
                <div className="flex items-center justify-between text-micro text-fg-subtle pt-2 border-t border-line-subtle">
                  <span>Horário de funcionamento</span>
                  {rule.activeHoursStart && rule.activeHoursEnd ? (
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> {rule.activeHoursStart} às {rule.activeHoursEnd}
                    </span>
                  ) : (
                    <span>24h por dia</span>
                  )}
                </div>
              </div>
)
}
