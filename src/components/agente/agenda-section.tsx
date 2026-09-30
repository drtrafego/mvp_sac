'use client'

import { useEffect, useState } from 'react'
import { CalendarOff, Clock, Plus, RefreshCw, Save, Trash2, AlertCircle, LockKeyhole, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  AGENDA_DAYS,
  AGENDA_DAY_LABELS,
  DEFAULT_AVAILABILITY_SCHEDULE,
  type AgendaDay,
  type AvailabilitySchedule,
  type DayRange,
} from '@/lib/agenda-schedule'

type BlockedDateSource = 'manual' | 'google_calendar' | 'bot_bloqueios' | 'google_calendar+bot_bloqueios'

interface BlockedDate {
  id: number
  date: string
  reason: string | null
  source: BlockedDateSource
  externalRef: string | null
  syncedAt: string | null
  createdAt: string
}

const SOURCE_LABELS: Record<BlockedDateSource, string> = {
  manual: 'Manual',
  google_calendar: 'Google Calendar',
  bot_bloqueios: 'Bloqueio do bot (WhatsApp)',
  'google_calendar+bot_bloqueios': 'Google Calendar + Bot',
}

function sourceLabel(source: BlockedDateSource | undefined | null): string {
  if (!source) return SOURCE_LABELS.manual
  return SOURCE_LABELS[source] ?? SOURCE_LABELS.manual
}

function formatDateBr(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

/**
 * Bloqueios de agenda + horário de atendimento (espelho fiel do bot nativo).
 * Extraído de configuracoes/agenda/page.tsx (rota antiga, hoje redireciona
 * pra /agente) pra viver dentro da aba Agente sem duplicar o fetch/lógica.
 */
export function AgendaSection() {
  const [companySlug, setCompanySlug] = useState('')
  const [loading, setLoading] = useState(true)

  const [blockedDates, setBlockedDates] = useState<BlockedDate[]>([])
  const [newDate, setNewDate] = useState('')
  const [newReason, setNewReason] = useState('')
  const [blockError, setBlockError] = useState('')
  const [blocking, setBlocking] = useState(false)
  const [syncingCalendar, setSyncingCalendar] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')

  const [schedule, setSchedule] = useState<AvailabilitySchedule | null>(null)
  const [scheduleReadOnly, setScheduleReadOnly] = useState(false)
  const [scheduleSourceLabel, setScheduleSourceLabel] = useState('')
  const [scheduleSyncedAt, setScheduleSyncedAt] = useState('')
  const [scheduleCheckedAt, setScheduleCheckedAt] = useState(0)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [scheduleSaved, setScheduleSaved] = useState(false)
  const [scheduleError, setScheduleError] = useState('')

  useEffect(() => {
    async function load() {
      const settingsRes = await fetch('/api/settings').then(r => r.json())
      const slug = settingsRes.companySlug ?? ''
      setCompanySlug(slug)
      if (!slug) {
        setLoading(false)
        return
      }

      const [blockedRes, scheduleRes] = await Promise.all([
        fetch(`/api/v1/companies/${slug}/agenda/blocked-dates`).then(r => r.json()),
        fetch(`/api/v1/companies/${slug}/agenda/schedule`).then(r => r.json()),
      ])

      if (blockedRes.ok) setBlockedDates(blockedRes.blockedDates)
      setScheduleReadOnly(Boolean(scheduleRes.readOnly))
      setScheduleSourceLabel(scheduleRes.sourceLabel ?? '')
      setScheduleSyncedAt(scheduleRes.syncedAt ?? '')
      setScheduleCheckedAt(Date.now())
      if (scheduleRes.ok && scheduleRes.schedule) {
        setSchedule(scheduleRes.schedule)
      } else if (scheduleRes.readOnly) {
        setSchedule(null)
        setScheduleError(scheduleRes.error ?? 'O horário real do bot ainda não foi sincronizado.')
      } else {
        setSchedule(DEFAULT_AVAILABILITY_SCHEDULE)
      }
      setLoading(false)
    }
    load()
  }, [])

  async function handleAddBlock() {
    setBlockError('')
    if (!newDate) {
      setBlockError('Escolha uma data.')
      return
    }
    setBlocking(true)
    const res = await fetch(`/api/v1/companies/${companySlug}/agenda/blocked-dates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: newDate, reason: newReason.trim() || undefined }),
    })
    const json = await res.json()
    setBlocking(false)

    if (!res.ok) {
      setBlockError(json.error ?? 'Erro ao bloquear data.')
      return
    }

    setBlockedDates(prev => [...prev, json.blockedDate].sort((a, b) => a.date.localeCompare(b.date)))
    setNewDate('')
    setNewReason('')
  }

  async function handleSyncCalendar() {
    setSyncMessage('')
    setSyncingCalendar(true)
    try {
      const res = await fetch(`/api/v1/companies/${companySlug}/agenda/sync?backfill=0`)
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setSyncMessage(json.error ?? 'Erro ao atualizar do Google Calendar.')
      } else if (json.skipped) {
        setSyncMessage(
          json.reason === 'not_drlucas'
            ? 'Sincronização com Google Calendar não se aplica a esta empresa.'
            : 'Google Calendar ainda não configurado (falta a Service Account).',
        )
      } else {
        setSyncMessage(`Atualizado: ${json.created ?? 0} novo(s), ${json.updated ?? 0} atualizado(s).`)
        const blockedRes = await fetch(`/api/v1/companies/${companySlug}/agenda/blocked-dates`).then(r => r.json())
        if (blockedRes.ok) setBlockedDates(blockedRes.blockedDates)
      }
    } catch {
      setSyncMessage('Erro ao atualizar do Google Calendar.')
    }
    setSyncingCalendar(false)
    setTimeout(() => setSyncMessage(''), 5000)
  }

  async function handleRemoveBlock(date: string) {
    if (!confirm(`Remover o bloqueio de ${formatDateBr(date)}?`)) return
    const res = await fetch(`/api/v1/companies/${companySlug}/agenda/blocked-dates/${date}`, { method: 'DELETE' })
    if (res.ok) {
      setBlockedDates(prev => prev.filter(b => b.date !== date))
    }
  }

  function setDayRanges(day: AgendaDay, ranges: DayRange[] | null) {
    if (scheduleReadOnly) return
    setSchedule(s => s ? ({ ...s, [day]: ranges && ranges.length > 0 ? ranges : null }) : s)
  }

  function addDayRange(day: AgendaDay) {
    if (scheduleReadOnly) return
    setSchedule(s => {
      if (!s) return s
      const ranges = s[day] ?? []
      return { ...s, [day]: [...ranges, { inicio: '08:00', fim: '18:00' }] }
    })
  }

  function removeDayRange(day: AgendaDay, index: number) {
    if (scheduleReadOnly) return
    setSchedule(s => {
      if (!s) return s
      const ranges = (s[day] ?? []).filter((_, i) => i !== index)
      return { ...s, [day]: ranges.length > 0 ? ranges : null }
    })
  }

  function updateDayRange(day: AgendaDay, index: number, field: keyof DayRange, value: string) {
    if (scheduleReadOnly) return
    setSchedule(s => {
      if (!s) return s
      const ranges = s[day]
      if (!ranges) return s
      return {
        ...s,
        [day]: ranges.map((range, i) => i === index ? { ...range, [field]: value } : range),
      }
    })
  }

  async function handleSaveSchedule() {
    if (!schedule || scheduleReadOnly) return
    setScheduleError('')
    setSavingSchedule(true)
    const res = await fetch(`/api/v1/companies/${companySlug}/agenda/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schedule),
    })
    const json = await res.json()
    setSavingSchedule(false)

    if (!res.ok) {
      setScheduleError(json.error ?? 'Erro ao salvar a grade de horários.')
      return
    }

    setSchedule(json.schedule)
    setScheduleSaved(true)
    setTimeout(() => setScheduleSaved(false), 2000)
  }

  if (loading) {
    return (
      <div className="panel p-[var(--space-card)]">
        <p className="text-body text-fg-muted">Carregando agenda...</p>
      </div>
    )
  }

  const scheduleSyncIsStale = scheduleReadOnly && scheduleSyncedAt
    ? scheduleCheckedAt - new Date(scheduleSyncedAt).getTime() > 30 * 60_000
    : false

  return (
    <>
      {/* Bloqueios de agenda */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarOff size={16} className="text-fg-subtle" />
            <h2 className="text-h2 text-fg">Datas bloqueadas</h2>
          </div>
          <Button
            onClick={handleSyncCalendar}
            disabled={syncingCalendar || !companySlug}
            variant="outline"
            className="focus-ring h-9 gap-1.5 border-line-subtle text-fg-subtle"
          >
            <RefreshCw size={13} className={syncingCalendar ? 'animate-spin' : ''} />
            {syncingCalendar ? 'Atualizando...' : 'Atualizar agora'}
          </Button>
        </div>
        <Separator className="bg-line-subtle" />
        <p className="text-body text-fg-muted">
          Datas em que não deve ser oferecido nenhum horário de atendimento (ex.: férias, congresso, feriado
          fechado). Inclui tanto o bloqueio manual quanto o que vem do Google Calendar real e do bot no WhatsApp.
        </p>
        {syncMessage && <p className="text-micro text-fg-subtle">{syncMessage}</p>}

        <div className="space-y-2">
          {blockedDates.length === 0 && (
            <p className="text-micro text-fg-faint italic">Nenhuma data bloqueada no momento.</p>
          )}
          {blockedDates.map(b => (
            <div
              key={b.id}
              className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle px-4 py-3 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-h3 text-fg num">{formatDateBr(b.date)}</p>
                  <span className="text-micro rounded-full bg-surface-overlay border border-line-subtle px-2 py-0.5 text-fg-subtle shrink-0">
                    {sourceLabel(b.source)}
                  </span>
                </div>
                {b.reason && <p className="text-micro text-fg-subtle truncate">{b.reason}</p>}
              </div>
              <button
                onClick={() => handleRemoveBlock(b.date)}
                className="focus-ring text-fg-subtle hover:text-st-negativo transition-colors p-3 lg:p-1 shrink-0"
                title="Remover bloqueio"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-4 space-y-3">
          <p className="text-label uppercase text-fg-subtle flex items-center gap-1.5">
            <Plus size={13} />
            Bloquear nova data
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="date"
              value={newDate}
              onChange={e => setNewDate(e.target.value)}
              className="bg-surface-overlay border-line-subtle h-11 lg:h-9 w-full sm:w-44"
            />
            <Input
              value={newReason}
              onChange={e => setNewReason(e.target.value)}
              placeholder="Motivo (opcional): férias, congresso..."
              className="bg-surface-overlay border-line-subtle h-11 lg:h-9 w-full sm:flex-1"
              onKeyDown={e => e.key === 'Enter' && handleAddBlock()}
            />
            <Button onClick={handleAddBlock} disabled={blocking || !newDate} className="focus-ring h-11 lg:h-9 bg-brand-solid text-on-accent shrink-0">
              {blocking ? 'Bloqueando...' : 'Bloquear'}
            </Button>
          </div>
          {blockError && (
            <p className="text-micro text-st-negativo flex items-center gap-1">
              <AlertCircle size={13} />
              {blockError}
            </p>
          )}
        </div>
      </section>

      {/* Grade de horário de atendimento */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <div className="flex items-center gap-2">
          <Clock size={16} className="text-fg-subtle" />
          <h2 className="text-h2 text-fg">{scheduleReadOnly ? 'Horário real do bot' : 'Horário de atendimento'}</h2>
        </div>
        <Separator className="bg-line-subtle" />
        {scheduleReadOnly ? (
          <div className="rounded-[var(--r-md)] border border-brand-solid/30 bg-brand-solid/5 p-4 space-y-2">
            <p className="text-body text-fg flex items-center gap-2 font-medium">
              <LockKeyhole size={15} className="text-brand-solid" />
              Somente leitura
            </p>
            <p className="text-body text-fg-muted">
              Este é o horário que o bot usa de verdade. O SAC apenas sincroniza e exibe essa fonte.
            </p>
            {scheduleSourceLabel && (
              <p className={`text-micro flex items-center gap-1.5 ${scheduleSyncIsStale ? 'text-st-negativo' : 'text-fg-subtle'}`}>
                <Database size={13} /> Fonte: {scheduleSourceLabel}
                {scheduleSyncedAt ? ` · sincronizado em ${new Date(scheduleSyncedAt).toLocaleString('pt-BR')}` : ''}
              </p>
            )}
            {scheduleSyncIsStale && (
              <p className="text-micro text-st-negativo flex items-center gap-1.5">
                <AlertCircle size={13} /> Sincronização atrasada. Confirme a fonte nativa antes de usar este horário.
              </p>
            )}
            <p className="text-micro text-fg-subtle">
              Para mudar o horário, altere a configuração nativa do bot. A próxima sincronização atualizará este espelho.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-body text-fg-muted">
              Grade semanal de horário em que a agenda e o follow-up podem atuar. Desmarque um dia para fechá-lo por
              completo.
            </p>
            {scheduleSourceLabel && (
              <p className={`text-micro flex items-center gap-1.5 ${scheduleSyncIsStale ? 'text-st-negativo' : 'text-fg-subtle'}`}>
                <Database size={13} /> Fonte importada: {scheduleSourceLabel}
                {scheduleSyncedAt ? ` · sincronizado em ${new Date(scheduleSyncedAt).toLocaleString('pt-BR')}` : ''}
              </p>
            )}
          </div>
        )}

        {schedule && <div className="space-y-2">
          {AGENDA_DAYS.map(day => {
            const ranges = schedule[day]
            const open = ranges !== null && ranges.length > 0
            return (
              <div
                key={day}
                className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3"
              >
                <label className={`flex items-center gap-2 sm:w-40 shrink-0 ${scheduleReadOnly ? 'cursor-default' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={open}
                    disabled={scheduleReadOnly}
                    onChange={e =>
                      setDayRanges(day, e.target.checked ? [{ inicio: '08:00', fim: '18:00' }] : null)
                    }
                    className="h-4 w-4 rounded border-line-default text-brand-solid focus:ring-brand-solid"
                  />
                  <span className="text-body text-fg text-sm font-medium">{AGENDA_DAY_LABELS[day]}</span>
                </label>

                {open ? (
                  <div className="flex flex-1 flex-col gap-2">
                    {ranges.map((range, index) => (
                      <div key={index} className="flex flex-wrap items-center gap-2">
                        <Input
                          type="time"
                          value={range.inicio}
                          disabled={scheduleReadOnly}
                          onChange={e => updateDayRange(day, index, 'inicio', e.target.value)}
                          className="bg-surface-overlay border-line-subtle h-10 lg:h-8 w-28"
                        />
                        <span className="text-micro text-fg-subtle">até</span>
                        <Input
                          type="time"
                          value={range.fim}
                          disabled={scheduleReadOnly}
                          onChange={e => updateDayRange(day, index, 'fim', e.target.value)}
                          className="bg-surface-overlay border-line-subtle h-10 lg:h-8 w-28"
                        />
                        {!scheduleReadOnly && (
                          <button
                            type="button"
                            onClick={() => removeDayRange(day, index)}
                            className="focus-ring text-fg-subtle hover:text-st-negativo transition-colors p-3 lg:p-1 shrink-0"
                            title="Remover intervalo"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                    {!scheduleReadOnly && (
                      <Button
                        type="button"
                        onClick={() => addDayRange(day)}
                        variant="outline"
                        className="focus-ring h-9 w-fit gap-1.5 border-line-subtle text-fg-subtle"
                      >
                        <Plus size={13} />
                        Adicionar intervalo
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className="text-micro text-fg-faint italic">Fechado</span>
                )}
              </div>
            )
          })}
        </div>}

        {schedule && <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div className="space-y-1.5">
            <Label>Fuso horário</Label>
            <Input
              value={schedule.timezone}
              disabled={scheduleReadOnly}
              onChange={e => setSchedule(s => s ? ({ ...s, timezone: e.target.value }) : s)}
              placeholder="America/Sao_Paulo"
              className="bg-surface-inset border-line-subtle h-11 lg:h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Duração do slot (minutos)</Label>
            <Input
              type="number"
              min={10}
              max={60}
              step={5}
              value={schedule.duracaoSlotMinutos}
              disabled={scheduleReadOnly}
              onChange={e => setSchedule(s => s ? ({ ...s, duracaoSlotMinutos: Number(e.target.value) }) : s)}
              className="bg-surface-inset border-line-subtle h-11 lg:h-9"
            />
          </div>
        </div>}

        {scheduleError && (
          <p className="text-micro text-st-negativo flex items-center gap-1">
            <AlertCircle size={13} />
            {scheduleError}
          </p>
        )}

        {!scheduleReadOnly && schedule && <div className="pt-1">
          <Button onClick={handleSaveSchedule} disabled={savingSchedule} className="focus-ring flex h-11 items-center gap-2 bg-brand-solid text-on-accent lg:h-9">
            <Save size={15} />
            {savingSchedule ? 'Salvando...' : scheduleSaved ? 'Salvo!' : 'Salvar horário de atendimento'}
          </Button>
        </div>}
      </section>
    </>
  )
}
