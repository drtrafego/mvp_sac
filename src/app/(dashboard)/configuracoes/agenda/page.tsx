'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CalendarOff, Clock, Plus, Save, Trash2, AlertCircle } from 'lucide-react'
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

interface BlockedDate {
  id: number
  date: string
  reason: string | null
  createdAt: string
}

function formatDateBr(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export default function AgendaConfigPage() {
  const [companySlug, setCompanySlug] = useState('')
  const [loading, setLoading] = useState(true)

  const [blockedDates, setBlockedDates] = useState<BlockedDate[]>([])
  const [newDate, setNewDate] = useState('')
  const [newReason, setNewReason] = useState('')
  const [blockError, setBlockError] = useState('')
  const [blocking, setBlocking] = useState(false)

  const [schedule, setSchedule] = useState<AvailabilitySchedule>(DEFAULT_AVAILABILITY_SCHEDULE)
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
      if (scheduleRes.ok) setSchedule(scheduleRes.schedule)
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

  async function handleRemoveBlock(date: string) {
    if (!confirm(`Remover o bloqueio de ${formatDateBr(date)}?`)) return
    const res = await fetch(`/api/v1/companies/${companySlug}/agenda/blocked-dates/${date}`, { method: 'DELETE' })
    if (res.ok) {
      setBlockedDates(prev => prev.filter(b => b.date !== date))
    }
  }

  function setDayRange(day: AgendaDay, range: DayRange | null) {
    setSchedule(s => ({ ...s, [day]: range }))
  }

  async function handleSaveSchedule() {
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
      <div className="max-w-[880px] flex flex-col gap-[var(--space-section)]">
        <p className="text-body text-fg-muted">Carregando...</p>
      </div>
    )
  }

  return (
    <div className="max-w-[880px] flex flex-col gap-[var(--space-section)]">
      <div>
        <Link
          href="/configuracoes"
          className="focus-ring inline-flex items-center gap-1.5 text-micro text-fg-subtle hover:text-fg transition-colors mb-2"
        >
          <ArrowLeft size={14} />
          Voltar para Configurações
        </Link>
        <h1 className="text-h1 text-fg">Agenda</h1>
        <p className="text-body text-fg-muted mt-1">
          Bloqueie datas (férias, congresso, feriado) e defina o horário de atendimento semanal. Esta configuração
          fica salva aqui no SAC, pronta para ser consumida pelo bot de agendamento quando a integração for feita.
        </p>
      </div>

      {/* Bloqueios de agenda */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <div className="flex items-center gap-2">
          <CalendarOff size={16} className="text-fg-subtle" />
          <h2 className="text-h2 text-fg">Datas bloqueadas</h2>
        </div>
        <Separator className="bg-line-subtle" />
        <p className="text-body text-fg-muted">
          Datas em que não deve ser oferecido nenhum horário de atendimento (ex.: férias, congresso, feriado
          fechado).
        </p>

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
                <p className="text-h3 text-fg num">{formatDateBr(b.date)}</p>
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
          <h2 className="text-h2 text-fg">Horário de atendimento</h2>
        </div>
        <Separator className="bg-line-subtle" />
        <p className="text-body text-fg-muted">
          Grade semanal de horário em que a agenda pode oferecer atendimento. Desmarque um dia para fechá-lo por
          completo.
        </p>

        <div className="space-y-2">
          {AGENDA_DAYS.map(day => {
            const range = schedule[day]
            const open = range !== null
            return (
              <div
                key={day}
                className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
              >
                <label className="flex items-center gap-2 sm:w-40 shrink-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={open}
                    onChange={e =>
                      setDayRange(day, e.target.checked ? { inicio: '08:00', fim: '18:00' } : null)
                    }
                    className="h-4 w-4 rounded border-line-default text-brand-solid focus:ring-brand-solid"
                  />
                  <span className="text-body text-fg text-sm font-medium">{AGENDA_DAY_LABELS[day]}</span>
                </label>

                {open ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      value={range.inicio}
                      onChange={e => setDayRange(day, { inicio: e.target.value, fim: range.fim })}
                      className="bg-surface-overlay border-line-subtle h-10 lg:h-8 w-28"
                    />
                    <span className="text-micro text-fg-subtle">até</span>
                    <Input
                      type="time"
                      value={range.fim}
                      onChange={e => setDayRange(day, { inicio: range.inicio, fim: e.target.value })}
                      className="bg-surface-overlay border-line-subtle h-10 lg:h-8 w-28"
                    />
                  </div>
                ) : (
                  <span className="text-micro text-fg-faint italic">Fechado</span>
                )}
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div className="space-y-1.5">
            <Label>Fuso horário</Label>
            <Input
              value={schedule.timezone}
              onChange={e => setSchedule(s => ({ ...s, timezone: e.target.value }))}
              placeholder="America/Sao_Paulo"
              className="bg-surface-inset border-line-subtle h-11 lg:h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Duração do slot (minutos)</Label>
            <Input
              type="number"
              min={5}
              max={480}
              value={schedule.duracaoSlotMinutos}
              onChange={e => setSchedule(s => ({ ...s, duracaoSlotMinutos: Number(e.target.value) }))}
              className="bg-surface-inset border-line-subtle h-11 lg:h-9"
            />
          </div>
        </div>

        {scheduleError && (
          <p className="text-micro text-st-negativo flex items-center gap-1">
            <AlertCircle size={13} />
            {scheduleError}
          </p>
        )}

        <div className="pt-1">
          <Button onClick={handleSaveSchedule} disabled={savingSchedule} className="focus-ring flex h-11 items-center gap-2 bg-brand-solid text-on-accent lg:h-9">
            <Save size={15} />
            {savingSchedule ? 'Salvando...' : scheduleSaved ? 'Salvo!' : 'Salvar horário de atendimento'}
          </Button>
        </div>
      </section>
    </div>
  )
}
