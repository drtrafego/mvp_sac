'use client'

import * as React from 'react'
import {
  Clock3,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Save,
  Megaphone,
  MoonStar,
  Shuffle,
  Activity,
  Database,
  Lock,
} from 'lucide-react'
import {
  isDelayStep,
  FOLLOWUP_DEFAULT_WINDOW,
  FOLLOWUP_DEFAULT_SPACING,
  type FollowupConfig,
  type FollowupStep,
  type FollowupWindow,
  type FollowupSpacing,
  type FollowupSentStats,
} from '@/lib/followup'

const PRESETS = [15, 30, 60, 120, 240, 480, 720, 1440]

function labelMin(min: number): string {
  if (min < 60) return `${min} min`
  if (min % 60 === 0) return `${min / 60}h`
  return `${Math.floor(min / 60)}h${min % 60}`
}

function delayDe(s: FollowupStep): number {
  return isDelayStep(s) ? s.delayMinutes : 0
}

function LinhaTempo({
  step,
  i,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  step: FollowupStep
  i: number
  total: number
  onChange: (s: FollowupStep) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const noDiaSeguinte = !isDelayStep(step)
  const min = delayDe(step)
  const isPreset = PRESETS.includes(min)

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-subtle bg-surface-raised p-2.5">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand-soft text-[11px] font-semibold text-brand-ink">
        {i + 1}
      </span>

      <select
        value={noDiaSeguinte ? 'dia' : 'apos'}
        onChange={(e) =>
          onChange(
            e.target.value === 'dia'
              ? { nextDayAtHour: 14 }
              : { delayMinutes: 60 },
          )
        }
        className="appearance-none rounded-lg border border-line-subtle bg-surface px-2.5 py-1.5 text-xs text-fg outline-none focus:border-brand cursor-pointer"
      >
        <option value="apos">Após</option>
        <option value="dia">No dia seguinte, às</option>
      </select>

      {noDiaSeguinte ? (
        <span className="inline-flex items-center gap-1">
          <select
            value={String((step as { nextDayAtHour: number }).nextDayAtHour)}
            onChange={(e) => onChange({ nextDayAtHour: Number(e.target.value) })}
            className="appearance-none rounded-lg border border-line-subtle bg-surface px-2.5 py-1.5 text-xs text-fg outline-none focus:border-brand cursor-pointer"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
          <span className="text-[11px] text-fg-faint">
            (só para quem não fechou no dia anterior)
          </span>
        </span>
      ) : (
        <>
          <select
            value={isPreset ? String(min) : 'custom'}
            onChange={(e) => {
              const v = e.target.value
              onChange({ delayMinutes: v !== 'custom' ? Number(v) : min })
            }}
            className="appearance-none rounded-lg border border-line-subtle bg-surface px-2.5 py-1.5 text-xs text-fg outline-none focus:border-brand cursor-pointer"
          >
            {PRESETS.map((m) => (
              <option key={m} value={m}>
                {labelMin(m)}
              </option>
            ))}
            <option value="custom">Personalizado…</option>
          </select>
          {!isPreset ? (
            <span className="inline-flex items-center gap-1">
              <input
                type="number"
                min={1}
                value={min}
                onChange={(e) =>
                  onChange({
                    delayMinutes: Math.max(
                      1,
                      Math.round(Number(e.target.value) || 0),
                    ),
                  })
                }
                className="w-20 rounded-lg border border-line-subtle bg-surface px-2.5 py-1.5 text-xs text-fg outline-none focus:border-brand"
              />
              <span className="text-[11px] text-fg-faint">min</span>
            </span>
          ) : null}
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={i === 0}
          aria-label="Subir"
          className="grid size-7 place-items-center rounded-md text-fg-subtle hover:text-fg disabled:opacity-30 cursor-pointer"
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={i === total - 1}
          aria-label="Descer"
          className="grid size-7 place-items-center rounded-md text-fg-subtle hover:text-fg disabled:opacity-30 cursor-pointer"
        >
          <ArrowDown size={14} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remover"
          className="grid size-7 place-items-center rounded-md text-fg-subtle hover:bg-st-erro-subtle hover:text-st-erro cursor-pointer"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

export function FollowupCard({
  initialConfig,
  initialStats,
  initialAgentSlug,
  initialIsSharedDbConnected,
}: {
  initialConfig?: FollowupConfig
  initialStats?: FollowupSentStats
  initialAgentSlug?: string
  initialIsSharedDbConnected?: boolean
}) {
  const [loadingConfig, setLoadingConfig] = React.useState(!initialConfig)
  const [config, setConfig] = React.useState<FollowupConfig>(
    initialConfig || {
      enabled: false,
      steps: [
        { delayMinutes: 30 },
        { delayMinutes: 120 },
        { delayMinutes: 240 },
        { delayMinutes: 720 },
      ],
      window: FOLLOWUP_DEFAULT_WINDOW,
      spacing: FOLLOWUP_DEFAULT_SPACING,
    },
  )

  const [stats, setStats] = React.useState<FollowupSentStats>(
    initialStats || { sent24h: 0, sent7d: 0, lastSentAt: null },
  )
  const [agentSlug, setAgentSlug] = React.useState<string>(initialAgentSlug || '')
  const [isSharedDbConnected, setIsSharedDbConnected] = React.useState<boolean>(
    Boolean(initialIsSharedDbConnected),
  )

  const [enabled, setEnabled] = React.useState(config.enabled)
  const [steps, setSteps] = React.useState<FollowupStep[]>(config.steps)
  const [janela, setJanela] = React.useState<FollowupWindow>(
    config.window ?? FOLLOWUP_DEFAULT_WINDOW,
  )
  const [ritmo, setRitmo] = React.useState<FollowupSpacing>(
    config.spacing ?? FOLLOWUP_DEFAULT_SPACING,
  )
  const [stepsAd, setStepsAd] = React.useState<FollowupStep[]>(
    config.stepsByOrigin?.ad ?? [],
  )
  const [usaAd, setUsaAd] = React.useState(
    (config.stepsByOrigin?.ad?.length ?? 0) > 0,
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [okMsg, setOkMsg] = React.useState<string | null>(null)
  const [dirty, setDirty] = React.useState(false)

  React.useEffect(() => {
    if (!initialConfig) {
      fetch('/api/followup/config')
        .then((res) => res.json())
        .then((data) => {
          if (data.ok && data.config) {
            setConfig(data.config)
            setEnabled(data.config.enabled)
            setSteps(data.config.steps)
            if (data.config.window) setJanela(data.config.window)
            if (data.config.spacing) setRitmo(data.config.spacing)
            if (data.config.stepsByOrigin?.ad) {
              setStepsAd(data.config.stepsByOrigin.ad)
              setUsaAd(data.config.stepsByOrigin.ad.length > 0)
            }
            if (data.stats) setStats(data.stats)
            if (data.agentSlug) setAgentSlug(data.agentSlug)
            if (data.isSharedDbConnected !== undefined) setIsSharedDbConnected(data.isSharedDbConnected)
          }
        })
        .catch((err) => console.error('Erro ao buscar config de followup', err))
        .finally(() => setLoadingConfig(false))
    }
  }, [initialConfig])

  function touch() {
    setDirty(true)
    setOkMsg(null)
    setError(null)
  }

  function mexer(
    lista: FollowupStep[],
    set: (v: FollowupStep[]) => void,
    acao: (prev: FollowupStep[]) => FollowupStep[],
  ) {
    set(acao(lista))
    touch()
  }

  async function save(nextEnabled = enabled) {
    if (saving) return
    setSaving(true)
    setError(null)
    setOkMsg(null)

    try {
      const res = await fetch('/api/followup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: nextEnabled,
          steps,
          window: janela,
          spacing: ritmo,
          ...(usaAd && stepsAd.length ? { stepsByOrigin: { ad: stepsAd } } : {}),
        }),
      })
      const data = await res.json()
      setSaving(false)

      if (data.ok) {
        setDirty(false)
        setOkMsg('Salvo no banco de dados compartilhado.')
        setTimeout(() => setOkMsg(null), 3000)
      } else {
        setError(data.error || 'Falha ao salvar.')
        setEnabled(enabled)
      }
    } catch (err) {
      setSaving(false)
      setError('Erro de rede ao salvar.')
      setEnabled(enabled)
    }
  }

  function toggle() {
    if (saving) return

    if (agentSlug === 'gramadoplazza' && !enabled) {
      const confirmGramado = window.confirm(
        'ATENÇÃO: A ativação do motor de follow-up do Gramado Plazza (container remoto da Gabi) requer autorização explícita do Gastão. Deseja prosseguir com o agendamento de alteração?'
      )
      if (!confirmGramado) return
    }

    const next = !enabled
    setEnabled(next)
    void save(next)
  }

  const rotuloHora = (h: number) => `${String(h).padStart(2, '0')}:00`

  if (loadingConfig) {
    return (
      <div className="card p-6 flex items-center justify-center gap-2 text-fg-subtle">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-xs">Carregando configuração de follow-up real do agente...</span>
      </div>
    )
  }

  return (
    <div className="card p-6 border border-line-subtle rounded-xl bg-surface-raised space-y-6">
      {/* HEADER */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand text-brand-ink">
            <Clock3 size={20} />
          </span>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-fg">Follow-up Automático do Agente IA</h3>
              {agentSlug ? (
                <span className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-surface-inset border border-line-subtle text-brand-ink">
                  slug: {agentSlug}
                </span>
              ) : null}
              {isSharedDbConnected ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-st-positivo/10 text-st-positivo border border-st-positivo/20">
                  <Database size={10} /> Banco Supabase Ativo
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-xl text-xs text-fg-subtle">
              O motor `orchestrate.py` lê esta tabela (`public.followup_config`) e executa os envios em background dentro do container da empresa. Altere os <strong>tempos</strong> de silêncio, a <strong>janela de horário</strong> e o <strong>intervalo randômico</strong>.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={toggle}
          disabled={saving}
          aria-pressed={enabled}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer ${
            enabled ? 'bg-brand' : 'bg-surface border border-line-subtle'
          }`}
        >
          <span
            className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* PAINEL DE METRICAS READ-ONLY DE DISPAROS REALIZADOS (followup_sent) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-line-subtle bg-surface p-3.5 flex items-center justify-between">
          <div>
            <p className="text-micro text-fg-subtle uppercase font-semibold">Disparos (últimas 24h)</p>
            <p className="num text-h2 font-bold text-fg mt-0.5">{stats.sent24h}</p>
          </div>
          <Activity size={18} className="text-brand-ink opacity-70" />
        </div>
        <div className="rounded-xl border border-line-subtle bg-surface p-3.5 flex items-center justify-between">
          <div>
            <p className="text-micro text-fg-subtle uppercase font-semibold">Disparos (últimos 7 dias)</p>
            <p className="num text-h2 font-bold text-fg mt-0.5">{stats.sent7d}</p>
          </div>
          <Clock3 size={18} className="text-fg-subtle opacity-70" />
        </div>
        <div className="rounded-xl border border-line-subtle bg-surface p-3.5 flex items-center justify-between">
          <div>
            <p className="text-micro text-fg-subtle uppercase font-semibold">Último disparo realizado</p>
            <p className="text-xs font-semibold text-fg mt-1">
              {stats.lastSentAt ? new Date(stats.lastSentAt).toLocaleString('pt-BR') : 'Nenhum envio recente'}
            </p>
          </div>
          <CheckCircle2 size={18} className="text-st-positivo opacity-70" />
        </div>
      </div>

      {agentSlug === 'gramadoplazza' ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
          <Lock size={16} className="shrink-0 text-amber-400 mt-0.5" />
          <div>
            <strong className="block font-semibold text-amber-300">Trava de Segurança — Gramado Plazza (Gabi)</strong>
            O container do Gramado Plazza roda remotamente na Hetzner (46.62.144.210). A ativação em produção (`enabled=true`) e a sincronização do motor de disparo remoto estão bloqueadas até autorização explícita e teste ao vivo do Gastão.
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-brand-soft bg-brand-soft/20 px-3 py-2 text-xs text-brand-ink font-medium">
          <Sparkles size={14} className="shrink-0" />
          O texto de cada lembrete é escrito dinamicamente pelo LLM do agente com base no contexto do chat.
        </div>

        {/* LISTA DE DEGRAUS */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-fg block">Sequência de Degraus (Geral)</label>
          {steps.map((step, i) => (
            <LinhaTempo
              key={i}
              step={step}
              i={i}
              total={steps.length}
              onChange={(s) =>
                mexer(steps, setSteps, (prev) =>
                  prev.map((x, idx) => (idx === i ? s : x)),
                )
              }
              onMove={(dir) =>
                mexer(steps, setSteps, (prev) => {
                  const j = i + dir
                  if (j < 0 || j >= prev.length) return prev
                  const next = [...prev]
                  ;[next[i], next[j]] = [next[j], next[i]]
                  return next
                })
              }
              onRemove={() =>
                mexer(steps, setSteps, (prev) => prev.filter((_, idx) => idx !== i))
              }
            />
          ))}

          <button
            type="button"
            onClick={() =>
              mexer(steps, setSteps, (prev) => [...prev, { delayMinutes: 60 }])
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line-subtle px-3 py-2 text-xs font-medium text-fg-subtle hover:border-brand hover:text-fg transition-colors cursor-pointer"
          >
            <Plus size={14} />
            Adicionar Degrau de Tempo
          </button>
        </div>

        {/* JANELA DE ENVIO */}
        <div className="rounded-xl border border-line-subtle bg-surface p-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <MoonStar size={16} className="text-fg-faint shrink-0" />
            <span className="text-xs font-medium text-fg">Janela de Envio Permitida</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-subtle">Disparar apenas entre</span>
            <select
              value={String(janela.startHour)}
              onChange={(e) => {
                setJanela({ ...janela, startHour: Number(e.target.value) })
                touch()
              }}
              className="appearance-none rounded-lg border border-line-subtle bg-surface-raised px-2.5 py-1 text-xs text-fg outline-none focus:border-brand cursor-pointer"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {rotuloHora(h)}
                </option>
              ))}
            </select>
            <span className="text-xs text-fg-subtle">e</span>
            <select
              value={String(janela.endHour)}
              onChange={(e) => {
                setJanela({ ...janela, endHour: Number(e.target.value) })
                touch()
              }}
              className="appearance-none rounded-lg border border-line-subtle bg-surface-raised px-2.5 py-1 text-xs text-fg outline-none focus:border-brand cursor-pointer"
            >
              {Array.from({ length: 25 }, (_, h) => (
                <option key={h} value={h}>
                  {h === 24 ? '24:00 (meia-noite)' : rotuloHora(h)}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-fg-faint">
            Mensagens agendadas para fora deste horário aguardam a reabertura da janela sem acumular disparos em massa.
          </p>
        </div>

        {/* ESPAÇAMENTO RANDÔMICO */}
        <div className="rounded-xl border border-line-subtle bg-surface p-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <Shuffle size={16} className="text-fg-faint shrink-0" />
            <span className="text-xs font-medium text-fg">Cadência Anti-Bloqueio (Variação Randômica)</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
            <span>Intervalo randômico entre</span>
            <input
              type="number"
              min={5}
              max={3600}
              value={ritmo.minSeconds}
              onChange={(e) => {
                setRitmo({
                  ...ritmo,
                  minSeconds: Math.max(5, Number(e.target.value) || 5),
                })
                touch()
              }}
              className="w-16 rounded-lg border border-line-subtle bg-surface-raised px-2 py-1 text-xs text-fg text-center outline-none focus:border-brand"
            />
            <span>e</span>
            <input
              type="number"
              min={5}
              max={3600}
              value={ritmo.maxSeconds}
              onChange={(e) => {
                setRitmo({
                  ...ritmo,
                  maxSeconds: Math.min(3600, Number(e.target.value) || 170),
                })
                touch()
              }}
              className="w-16 rounded-lg border border-line-subtle bg-surface-raised px-2 py-1 text-xs text-fg text-center outline-none focus:border-brand"
            />
            <span>segundos</span>
          </div>
          <p className="text-[11px] text-fg-faint">
            Protege o número contra bloqueios do WhatsApp variando o intervalo exato entre requisições.
          </p>
        </div>

        {/* RÉGUA SEPARADA PARA ANÚNCIOS (AD) */}
        <div className="rounded-xl border border-line-subtle bg-surface p-3.5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Megaphone size={16} className="text-brand-ink shrink-0" />
              <span className="text-xs font-medium text-fg">Régua Específica para Anúncios (Click to WhatsApp)</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setUsaAd(!usaAd)
                touch()
              }}
              className={`text-xs font-semibold px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                usaAd
                  ? 'bg-brand-soft text-brand-ink'
                  : 'bg-surface-raised text-fg-subtle border border-line-subtle'
              }`}
            >
              {usaAd ? 'Ativada' : 'Ativar Régua de Ads'}
            </button>
          </div>

          {usaAd ? (
            <div className="space-y-2 pt-1 border-t border-line-subtle">
              <p className="text-[11px] text-fg-faint">
                Leads de anúncios possuem janela gratuita de 72h na Meta (CTWA) e aceitam uma sequência mais longa de reengajamento.
              </p>
              {stepsAd.map((step, i) => (
                <LinhaTempo
                  key={i}
                  step={step}
                  i={i}
                  total={stepsAd.length}
                  onChange={(s) =>
                    mexer(stepsAd, setStepsAd, (prev) =>
                      prev.map((x, idx) => (idx === i ? s : x)),
                    )
                  }
                  onMove={(dir) =>
                    mexer(stepsAd, setStepsAd, (prev) => {
                      const j = i + dir
                      if (j < 0 || j >= prev.length) return prev
                      const next = [...prev]
                      ;[next[i], next[j]] = [next[j], next[i]]
                      return next
                    })
                  }
                  onRemove={() =>
                    mexer(stepsAd, setStepsAd, (prev) => prev.filter((_, idx) => idx !== i))
                  }
                />
              ))}

              <button
                type="button"
                onClick={() =>
                  mexer(stepsAd, setStepsAd, (prev) => [...prev, { delayMinutes: 60 }])
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line-subtle px-3 py-1.5 text-xs font-medium text-fg-subtle hover:border-brand hover:text-fg transition-colors cursor-pointer"
              >
                <Plus size={14} />
                Adicionar Degrau de Ads
              </button>
            </div>
          ) : null}
        </div>

        {/* FEEDBACKS & BOTAO SALVAR */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div>
            {okMsg && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-st-positivo">
                <CheckCircle2 size={14} />
                {okMsg}
              </span>
            )}
            {error && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-st-erro">
                <AlertTriangle size={14} />
                {error}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || (!dirty && !error)}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-brand-ink transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Salvar no Banco do Agente ({agentSlug})
          </button>
        </div>
      </div>
    </div>
  )
}
