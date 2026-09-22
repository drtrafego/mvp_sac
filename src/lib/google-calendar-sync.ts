// Sync de agenda_blocked_dates com o Google Calendar REAL do Dr. Lucas
// (company_id=3, slug 'drlucas'), 22/09/2026. Plano fechado com o Gastão:
// Service Account nova só leitura, os dois calendários dele juntos (o
// principal e o do iClinic), incluindo o bloqueio manual/bot já existente.
//
// GUARD EXPLÍCITO (isDrLucasCompany): as credenciais da Service Account
// (GOOGLE_SA_CLIENT_EMAIL/GOOGLE_SA_PRIVATE_KEY) são env vars GLOBAIS, não
// por empresa, e os 2 calendarId abaixo são FIXOS do Dr. Lucas. Se um dia
// outro cliente ganhar esse recurso, ISTO PRECISA GENERALIZAR (calendar ids
// por empresa, guardados em settings ou tabela própria) — não deixar outra
// empresa cair nesta função e sincronizar com os calendários de outra
// pessoa. Enquanto isso não acontece, o guard abaixo garante que a sync só
// roda de verdade para o Dr. Lucas; qualquer outra empresa recebe
// { skipped: true, reason: 'not_drlucas' } sem tocar em nada.
//
// Eventos de DIA INTEIRO (start.date presente, start.dateTime ausente) são
// o sinal de "dia bloqueado" (bloqueio de agenda, viagem, congresso). Uma
// consulta normal de 15-30min tem start.dateTime, não start.date — por isso
// aqui não se usa freebusy.query, que não distingue as duas coisas.
//
// ⚠️ FIX DE QA (bug ALTO, 22/09/2026, 2ª rodada): reason não é mais
// concatenado direto, é campo calculado a partir de botReason/googleReason
// (ver comentário em src/lib/db/schema.ts e o bloco de upsert abaixo). O
// script do lado Hermes (/opt/gastaomatos/hermes/bloqueios-sync/
// sync_bloqueios_sac.py e /opt/data/sync_bloqueios_sac.py, roda via cron a
// cada 5min no host/container do Dr. Lucas) foi atualizado junto: agora
// grava o motivo do bot direto em `bot_reason`, cru, sem concatenar nada do
// Google. O fallback de compatibilidade que existia aqui (herdar `reason`
// pra `botReason` na 1ª vez que tocasse a linha) foi REMOVIDO: ele herdava
// texto já misturado com o motivo do Google e duplicava a informação na
// tela. Se `botReason` estiver null é só porque o Hermes ainda não rodou
// pra essa data depois do deploy, nunca um sinal de dado errado.
//
// ⚠️ FIX bug de produção (ALTO, 22/09/2026): os dois calendários eram lidos
// com Promise.all, então o 404 do calendário principal (nunca compartilhado
// com a Service Account) derrubava a rota inteira com google_api_error, e o
// iClinic (compartilhado, 100% acessível, é o que o Gastão usa de verdade)
// não sincronizava nada mesmo funcionando. Agora cada calendário é lido de
// forma isolada (fetchCalendarSafe, nunca lança): um calendário falho vira
// "sem eventos dessa fonte" e é reportado em `calendars`, o(s) que
// funcionar(em) alimentam a sync normalmente. Só retorna erro geral
// (google_api_error) se os DOIS falharem.

import { google } from 'googleapis'
import { and, desc, eq, like } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agendaBlockedDates } from '@/lib/db/schema'
import { isUniqueViolation } from '@/lib/webhook-dedup'

const DRLUCAS_SLUG = 'drlucas'
const DRLUCAS_COMPANY_ID = 3

const ICLINIC_CALENDAR_ID =
  'c1be5614432cc356e375f91f01c5515f95be5d1bcfa3d7b7218882a68215e510@group.calendar.google.com'

const DEFAULT_PRIMARY_CALENDAR_ID = 'drlucasfernandesdermato@gmail.com'

const WINDOW_PAST_DAYS = 90
const WINDOW_FUTURE_DAYS = 365

export const GOOGLE_CALENDAR_SYNC_STALE_MS = 5 * 60 * 1000 // 5 minutos

export type GoogleSyncSkipReason = 'not_drlucas' | 'google_sync_not_configured'

// Status de leitura de UM calendário nesta rodada. Ver bug de produção de
// 22/09/2026: o calendário do iClinic foi compartilhado com a Service
// Account e funciona; o principal nunca foi compartilhado (404). Antes,
// Promise.all derrubava a sincronização inteira quando só UM dos dois
// falhava. Agora cada calendário é lido de forma isolada e reportado aqui,
// pra diagnóstico futuro não precisar de investigação manual como a de hoje.
export interface GoogleCalendarStatus {
  id: string
  ok: boolean
  eventsFound?: number
  error?: string
}

export interface GoogleSyncResult {
  ok: boolean
  skipped: boolean
  reason?: GoogleSyncSkipReason | 'google_api_error'
  errorMessage?: string
  eventsFound?: number
  created?: number
  updated?: number
  skippedManual?: number
  calendars?: GoogleCalendarStatus[]
}

interface AllDayEvent {
  id: string
  summary: string
  date: string
}

// Só o Dr. Lucas tem os 2 calendários fixos abaixo hardcoded neste módulo.
// Ver comentário de cabeçalho: generalizar (calendar id por empresa) é
// trabalho futuro, se algum dia outro cliente ganhar este recurso.
export function isDrLucasCompany(company: { id: number; slug: string }): boolean {
  return company.slug === DRLUCAS_SLUG || company.id === DRLUCAS_COMPANY_ID
}

function getPrimaryCalendarId(): string {
  return process.env.DRLUCAS_GOOGLE_CALENDAR_PRIMARY_ID?.trim() || DEFAULT_PRIMARY_CALENDAR_ID
}

function getServiceAccountCredentials(): { clientEmail: string; privateKey: string } | null {
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL?.trim()
  const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY
  if (!clientEmail || !rawKey) return null
  const privateKey = rawKey.replace(/\\n/g, '\n')
  if (!privateKey.trim()) return null
  return { clientEmail, privateKey }
}

async function fetchAllDayEvents(
  calendarId: string,
  auth: InstanceType<typeof google.auth.JWT>,
  timeMin: string,
  timeMax: string,
): Promise<AllDayEvent[]> {
  const calendar = google.calendar({ version: 'v3', auth })
  const events: AllDayEvent[] = []
  let pageToken: string | undefined

  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    })

    for (const ev of res.data.items ?? []) {
      // Dia inteiro de verdade: start.date presente e start.dateTime ausente.
      // Consulta normal tem dateTime (hora marcada) e nunca entra aqui.
      if (ev.id && ev.start?.date && !ev.start?.dateTime) {
        events.push({ id: ev.id, summary: (ev.summary || '').trim(), date: ev.start.date })
      }
    }

    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  return events
}

interface CalendarFetchResult {
  calendarId: string
  ok: boolean
  events: AllDayEvent[]
  error?: string
}

// Nunca lança: cada calendário é isolado do outro. Um 404/403 num calendário
// (ex.: nunca compartilhado com a Service Account) não pode derrubar a
// leitura de outro calendário que está funcionando.
async function fetchCalendarSafe(
  calendarId: string,
  auth: InstanceType<typeof google.auth.JWT>,
  timeMin: string,
  timeMax: string,
): Promise<CalendarFetchResult> {
  try {
    const events = await fetchAllDayEvents(calendarId, auth, timeMin, timeMax)
    return { calendarId, ok: true, events }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[google-calendar-sync] falha ao ler o calendário ${calendarId}:`, error)
    return { calendarId, ok: false, events: [], error }
  }
}

// Roda a sync de verdade: lê os 2 calendários do Dr. Lucas e faz upsert em
// agendaBlockedDates. Chamada tanto pela rota GET /agenda/sync (manual,
// inclusive com ?backfill=1) quanto pelo auto-refresh das rotas
// schedule/blocked-dates (ver maybeRefreshGoogleCalendarSync abaixo).
export async function syncGoogleCalendarBlockedDates(company: {
  id: number
  slug: string
}): Promise<GoogleSyncResult> {
  if (!isDrLucasCompany(company)) {
    return { ok: true, skipped: true, reason: 'not_drlucas' }
  }

  const creds = getServiceAccountCredentials()
  if (!creds) {
    return { ok: false, skipped: true, reason: 'google_sync_not_configured' }
  }

  const auth = new google.auth.JWT({
    email: creds.clientEmail,
    key: creds.privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  })

  const now = new Date()
  const timeMin = new Date(now.getTime() - WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const timeMax = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Cada calendário é lido de forma isolada (nunca um Promise.all que
  // derruba tudo se só um falhar): o iClinic pode estar 100% acessível
  // mesmo com o principal ainda não compartilhado com a Service Account.
  const fetchResults = await Promise.all([
    fetchCalendarSafe(getPrimaryCalendarId(), auth, timeMin, timeMax),
    fetchCalendarSafe(ICLINIC_CALENDAR_ID, auth, timeMin, timeMax),
  ])

  const calendars: GoogleCalendarStatus[] = fetchResults.map(r => ({
    id: r.calendarId,
    ok: r.ok,
    eventsFound: r.ok ? r.events.length : undefined,
    error: r.ok ? undefined : r.error,
  }))

  const okResults = fetchResults.filter(r => r.ok)
  if (okResults.length === 0) {
    const errorMessage = fetchResults.map(r => `${r.calendarId}: ${r.error}`).join(' | ')
    return { ok: false, skipped: false, reason: 'google_api_error', errorMessage, calendars }
  }

  const events: AllDayEvent[] = okResults.flatMap(r => r.events)

  // Agrupa por data: os dois calendários podem ter, cada um, um evento de
  // dia inteiro na mesma data (ex.: bloqueio manual no principal + evento
  // espelhado no iClinic).
  const byDate = new Map<string, { reasons: string[]; eventIds: string[] }>()
  for (const ev of events) {
    const entry = byDate.get(ev.date) ?? { reasons: [], eventIds: [] }
    entry.reasons.push(ev.summary || 'Bloqueio Google Calendar')
    entry.eventIds.push(ev.id)
    byDate.set(ev.date, entry)
  }

  let created = 0
  let updated = 0
  let skippedManual = 0

  for (const [date, { reasons, eventIds }] of byDate) {
    // googleReasonText é SÓ o texto vindo do Google nesta rodada; nunca
    // concatenado com o que já existia no banco (isso é o que causava o bug
    // ALTO do QA: reason era uma string irreversível, cada rodada perdia a
    // parte que não veio dela). reason final é sempre recalculado abaixo a
    // partir de botReason + googleReason.
    const googleReasonText = reasons.filter(Boolean).join('; ') || 'Bloqueio Google Calendar'
    const externalRef = eventIds.join(',')

    const [existing] = await db
      .select()
      .from(agendaBlockedDates)
      .where(and(eq(agendaBlockedDates.companyId, company.id), eq(agendaBlockedDates.date, date)))

    if (!existing) {
      try {
        await db.insert(agendaBlockedDates).values({
          companyId: company.id,
          date,
          reason: googleReasonText,
          botReason: null,
          googleReason: googleReasonText,
          source: 'google_calendar',
          externalRef,
          syncedAt: new Date(),
        })
        created++
      } catch (err) {
        // Corrida com outra chamada de sync concorrente (auto-refresh de
        // duas rotas GET ao mesmo tempo, por exemplo): a próxima rodada de
        // sync corrige sozinha, não é erro fatal.
        if (!isUniqueViolation(err)) throw err
      }
      continue
    }

    if (existing.source === 'manual') {
      // Bloqueio manual sempre vence: não sobrescreve, só registra e segue.
      skippedManual++
      console.log(
        `[google-calendar-sync] data ${date} (empresa ${company.id}) já bloqueada manualmente, evento do Google ignorado`,
      )
      continue
    }

    // Linha já tem (ao menos em parte) origem do bot: 'bot_bloqueios' ou já
    // combinada 'google_calendar+bot_bloqueios'.
    //
    // botReason vem SÓ do que já está gravado na coluna bot_reason (o
    // Hermes, do lado dele, agora escreve direto ali - ver
    // /opt/gastaomatos/hermes/bloqueios-sync/sync_bloqueios_sac.py, fix de
    // QA de 22/09/2026). Nunca mais herdado de `reason`: o fallback de
    // compatibilidade que fazia essa herança foi removido porque o Hermes
    // gravava `reason` já concatenado com o texto do Google, e herdar aquilo
    // pra `botReason` duplicava o motivo do Google na tela e travava a
    // coluna pra sempre no texto contaminado (bug ALTO do QA). Se
    // `botReason` ainda está null aqui, é porque o Hermes ainda não rodou
    // pra essa data depois do deploy - fica null até o próximo bloqueio real
    // dele, não é um erro.
    const sourceHasBot = existing.source === 'bot_bloqueios' || existing.source === 'google_calendar+bot_bloqueios'
    const botReason = existing.botReason ?? null
    const newSource = sourceHasBot ? 'google_calendar+bot_bloqueios' : existing.source
    const combinedReason = [botReason, googleReasonText].filter(Boolean).join('; ')

    await db
      .update(agendaBlockedDates)
      .set({
        source: newSource,
        reason: combinedReason,
        botReason,
        googleReason: googleReasonText,
        externalRef,
        syncedAt: new Date(),
      })
      .where(eq(agendaBlockedDates.id, existing.id))
    updated++
  }

  return { ok: true, skipped: false, eventsFound: events.length, created, updated, skippedManual, calendars }
}

// A linha mais recente de origem Google (source contém 'google_calendar')
// pra essa empresa: se não existe ou o syncedAt é mais velho que 5 minutos,
// a sync está "velha" e vale rodar de novo antes de responder a tela.
async function isGoogleCalendarSyncStale(companyId: number): Promise<boolean> {
  const [latest] = await db
    .select({ syncedAt: agendaBlockedDates.syncedAt })
    .from(agendaBlockedDates)
    .where(
      and(
        eq(agendaBlockedDates.companyId, companyId),
        like(agendaBlockedDates.source, '%google_calendar%'),
      ),
    )
    .orderBy(desc(agendaBlockedDates.syncedAt))
    .limit(1)

  if (!latest || !latest.syncedAt) return true
  return Date.now() - new Date(latest.syncedAt).getTime() > GOOGLE_CALENDAR_SYNC_STALE_MS
}

// Chamado no início das rotas GET de schedule/blocked-dates (item 3 da
// tarefa). Nunca lança: falha de rede/credencial ainda não configurada é
// não-fatal, a tela sempre continua servindo o que já está no banco.
export async function maybeRefreshGoogleCalendarSync(company: { id: number; slug: string }): Promise<void> {
  if (!isDrLucasCompany(company)) return
  try {
    const stale = await isGoogleCalendarSyncStale(company.id)
    if (!stale) return
    const result = await syncGoogleCalendarBlockedDates(company)
    if (!result.ok && result.reason && result.reason !== 'google_sync_not_configured') {
      console.error('[google-calendar-sync] auto-refresh não concluído:', result.reason, result.errorMessage)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[google-calendar-sync] auto-refresh falhou (não fatal, tela segue servindo o que já tem):', message)
  }
}

// Reexport só pra teste/uso pontual não precisar duplicar a constante.
export const DR_LUCAS_ICLINIC_CALENDAR_ID = ICLINIC_CALENDAR_ID
