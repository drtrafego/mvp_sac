'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, CircleOff, Clock3, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Status = 'active' | 'inactive' | 'degraded' | 'failing'
type Check = {
  id: number
  featureKey: string
  label: string
  description: string
  status: Status
  severity: 'warning' | 'critical'
  critical: boolean
  reason: string
  latencyMs: number | null
  statusCode: number | null
  checkedAt: string
  configured: boolean
}
type Incident = {
  id: number
  featureKey: string
  label: string
  severity: 'warning' | 'critical'
  reason: string
  startedAt: string
  lastSeenAt: string
  recoveredAt: string | null
  checkId: number | null
  isOpen: boolean
}

const statusCopy: Record<Status, string> = {
  active: 'Ativa',
  inactive: 'Inativa',
  degraded: 'Degradada',
  failing: 'Falhando',
}

const statusClasses: Record<Status, string> = {
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  inactive: 'bg-surface-inset text-fg-subtle border-line-subtle',
  degraded: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  failing: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'active') return <CheckCircle2 size={15} />
  if (status === 'inactive') return <CircleOff size={15} />
  if (status === 'degraded') return <AlertTriangle size={15} />
  return <XCircle size={15} />
}

function dateText(value: string | null) {
  if (!value) return 'Ainda não'
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value))
}

export function HealthFeaturesSection() {
  const [checks, setChecks] = useState<Check[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openIncident, setOpenIncident] = useState<number | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    setError(null)
    try {
      const response = await fetch('/api/saude', { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Falha ao carregar a saúde do SAC.')
      setChecks(payload.checks ?? [])
      setIncidents(payload.incidents ?? [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar a saúde do SAC.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => void load(), 60_000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
    }
  }, [load])

  const summary = useMemo(() => ({
    active: checks.filter(check => check.status === 'active').length,
    degraded: checks.filter(check => check.status === 'degraded').length,
    failing: checks.filter(check => check.status === 'failing').length,
    inactive: checks.filter(check => check.status === 'inactive').length,
  }), [checks])

  return (
    <section className="space-y-4">
      <div className="panel p-[var(--space-card)] border border-line-subtle bg-surface-panel rounded-[var(--r-lg)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Activity size={18} className="text-brand-ink" />
              <h2 className="text-h2 text-fg">Saúde e funcionalidades</h2>
            </div>
            <p className="text-micro text-fg-subtle mt-1 max-w-2xl">
              Verificações leves por empresa. Integrações sem configuração não aparecem e nenhuma checagem envia mensagem a cliente.
            </p>
          </div>
          <Button onClick={() => void load(true)} disabled={loading || refreshing} variant="outline" className="h-9 gap-2">
            {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Verificar agora
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ['active', 'Ativas', 'text-emerald-400'],
            ['degraded', 'Degradadas', 'text-amber-400'],
            ['failing', 'Falhando', 'text-rose-400'],
            ['inactive', 'Inativas', 'text-fg-subtle'],
          ] as const).map(([key, label, color]) => (
            <div key={key} className="rounded-[var(--r-md)] border border-line-subtle bg-surface-inset p-3">
              <span className="text-label uppercase text-fg-subtle">{label}</span>
              <strong className={`num mt-1 block text-h2 ${color}`}>{summary[key]}</strong>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="rounded-[var(--r-md)] border border-rose-500/20 bg-rose-500/10 p-3 text-micro text-rose-300">{error}</div>}

      <div className="space-y-2">
        {loading && checks.length === 0 ? (
          <div className="panel flex items-center gap-2 p-5 text-micro text-fg-subtle"><Loader2 size={15} className="animate-spin" /> Verificando dependências configuradas...</div>
        ) : checks.map(check => (
          <div key={check.featureKey} className="panel border border-line-subtle bg-surface-panel rounded-[var(--r-lg)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--r-md)] ${statusClasses[check.status].split(' ').slice(0, 1).join(' ')}`}>
                  <StatusIcon status={check.status} />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-body font-semibold text-fg">{check.label}</h3>
                    {check.critical && <span className="text-[10px] uppercase tracking-wide text-fg-faint">crítica</span>}
                  </div>
                  <p className="mt-0.5 text-micro text-fg-subtle">{check.description}</p>
                </div>
              </div>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusClasses[check.status]}`}>
                <StatusIcon status={check.status} /> {statusCopy[check.status]}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 border-t border-line-subtle pt-3 text-micro text-fg-subtle sm:grid-cols-3">
              <span><strong className="text-fg-muted">Motivo:</strong> {check.reason}</span>
              <span className="flex items-center gap-1"><Clock3 size={12} /> {check.latencyMs ?? '—'} ms · HTTP {check.statusCode ?? '—'}</span>
              <span>Última verificação: {dateText(check.checkedAt)} · #{check.id}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="panel border border-line-subtle bg-surface-panel rounded-[var(--r-lg)] p-[var(--space-card)]">
        <div className="flex items-center gap-2">
          <ShieldAlert size={17} className="text-brand-ink" />
          <h2 className="text-h2 text-fg">Histórico mínimo de incidentes</h2>
        </div>
        <p className="mt-1 text-micro text-fg-subtle">Falhas críticas são deduplicadas por funcionalidade, têm cooldown de alerta e registram a recuperação.</p>
        <div className="mt-4 space-y-2">
          {incidents.length === 0 ? <p className="rounded-[var(--r-md)] bg-surface-inset p-4 text-center text-micro text-fg-subtle">Nenhum incidente registrado.</p> : incidents.map(incident => (
            <div key={incident.id} className="rounded-[var(--r-md)] border border-line-subtle bg-surface-inset">
              <button type="button" onClick={() => setOpenIncident(openIncident === incident.id ? null : incident.id)} className="focus-ring flex w-full items-center justify-between gap-3 p-3 text-left">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${incident.isOpen ? 'bg-rose-400' : 'bg-emerald-400'}`} />
                  <span className="truncate text-body font-semibold text-fg">{incident.label}</span>
                  <span className="text-[10px] uppercase text-fg-faint">#{incident.id}</span>
                </span>
                <span className="flex items-center gap-2 text-micro text-fg-subtle">{incident.isOpen ? 'Aberto' : 'Recuperado'} <ChevronDown size={14} className={openIncident === incident.id ? 'rotate-180' : ''} /></span>
              </button>
              {openIncident === incident.id && <div className="space-y-1 border-t border-line-subtle px-3 pb-3 pt-2 text-micro text-fg-subtle">
                <p><strong className="text-fg-muted">Motivo:</strong> {incident.reason}</p>
                <p><strong className="text-fg-muted">Início:</strong> {dateText(incident.startedAt)} · <strong className="text-fg-muted">Última ocorrência:</strong> {dateText(incident.lastSeenAt)}</p>
                <p><strong className="text-fg-muted">Recuperação:</strong> {dateText(incident.recoveredAt)} · <strong className="text-fg-muted">Checagem:</strong> #{incident.checkId ?? '—'}</p>
              </div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
