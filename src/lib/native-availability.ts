import { eq, lte } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, nativeAvailabilitySchedules } from '@/lib/db/schema'
import {
  NATIVE_AVAILABILITY_SOURCE_LABELS,
  isNativeAvailabilityCompany,
  validateAvailabilitySchedule,
  type AvailabilitySchedule,
  type NativeAvailabilityCompanySlug,
} from '@/lib/agenda-schedule'

export interface NativeAvailabilitySnapshot {
  schedule: AvailabilitySchedule
  source: 'bot_file' | 'reservations_api'
  sourceLabel: string
  sourceCursor: string
  capturedAt: Date
  syncedAt: Date
}

const EXPECTED_SOURCE: Record<NativeAvailabilityCompanySlug, NativeAvailabilitySnapshot['source']> = {
  drlucas: 'bot_file',
  'gramado-plaza': 'reservations_api',
}

export function parseNativeAvailabilityPayload(slug: string, body: unknown):
  | { ok: true; value: Omit<NativeAvailabilitySnapshot, 'sourceLabel' | 'syncedAt'> }
  | { ok: false; error: string } {
  if (!isNativeAvailabilityCompany(slug)) return { ok: false, error: 'Empresa sem fonte nativa de horário.' }
  if (!body || typeof body !== 'object') return { ok: false, error: 'Payload inválido.' }
  const input = body as Record<string, unknown>
  const rawSchedule = input.schedule
  if (!rawSchedule || typeof rawSchedule !== 'object') return { ok: false, error: 'schedule inválido.' }
  const scheduleKeys = rawSchedule as Record<string, unknown>
  const requiredKeys = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo', 'timezone', 'duracaoSlotMinutos']
  if (requiredKeys.some(key => !(key in scheduleKeys))) {
    return { ok: false, error: 'Snapshot nativo incompleto.' }
  }
  const validated = validateAvailabilitySchedule(rawSchedule)
  if (!validated.ok) return { ok: false, error: validated.error }
  const source = input.source
  if (source !== 'bot_file' && source !== 'reservations_api') {
    return { ok: false, error: 'Fonte inválida.' }
  }
  if (source !== EXPECTED_SOURCE[slug]) return { ok: false, error: 'Fonte incompatível com a empresa.' }
  const sourceCursor = typeof input.cursor === 'string' ? input.cursor.trim() : ''
  if (!sourceCursor || sourceCursor.length > 200) return { ok: false, error: 'Cursor inválido.' }
  const capturedAt = typeof input.capturedAt === 'string' ? new Date(input.capturedAt) : new Date(NaN)
  if (Number.isNaN(capturedAt.getTime())) return { ok: false, error: 'capturedAt inválido.' }
  if (capturedAt.getTime() > Date.now() + 5 * 60_000) return { ok: false, error: 'capturedAt está no futuro.' }
  return {
    ok: true,
    value: { schedule: validated.schedule, source, sourceCursor, capturedAt },
  }
}

export async function upsertNativeAvailabilitySnapshot(
  slug: NativeAvailabilityCompanySlug,
  snapshot: Omit<NativeAvailabilitySnapshot, 'sourceLabel' | 'syncedAt'>,
): Promise<NativeAvailabilitySnapshot> {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, slug)).limit(1)
  if (!company) throw new Error('Empresa não encontrada')

  const now = new Date()
  const sourceLabel = NATIVE_AVAILABILITY_SOURCE_LABELS[slug]
  const [row] = await db
    .insert(nativeAvailabilitySchedules)
    .values({
      companyId: company.id,
      schedule: snapshot.schedule,
      source: snapshot.source,
      sourceLabel,
      sourceCursor: snapshot.sourceCursor,
      capturedAt: snapshot.capturedAt,
      syncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: nativeAvailabilitySchedules.companyId,
      set: {
        schedule: snapshot.schedule,
        source: snapshot.source,
        sourceLabel,
        sourceCursor: snapshot.sourceCursor,
        capturedAt: snapshot.capturedAt,
        syncedAt: now,
        updatedAt: now,
      },
      // Um passe atrasado não pode sobrescrever um retrato mais recente. A
      // igualdade é aceita para retry idempotente da mesma coleta.
      setWhere: lte(nativeAvailabilitySchedules.capturedAt, snapshot.capturedAt),
    })
    .returning()

  if (!row) {
    const existing = await getNativeAvailabilitySnapshot(company.id)
    if (!existing) throw new Error('Snapshot concorrente não encontrado')
    return existing
  }

  return {
    schedule: row.schedule as AvailabilitySchedule,
    source: row.source as NativeAvailabilitySnapshot['source'],
    sourceLabel: row.sourceLabel,
    sourceCursor: row.sourceCursor,
    capturedAt: row.capturedAt,
    syncedAt: row.syncedAt,
  }
}

export async function getNativeAvailabilitySnapshot(companyId: number): Promise<NativeAvailabilitySnapshot | null> {
  const [row] = await db
    .select()
    .from(nativeAvailabilitySchedules)
    .where(eq(nativeAvailabilitySchedules.companyId, companyId))
    .limit(1)
  if (!row) return null
  return {
    schedule: row.schedule as AvailabilitySchedule,
    source: row.source as NativeAvailabilitySnapshot['source'],
    sourceLabel: row.sourceLabel,
    sourceCursor: row.sourceCursor,
    capturedAt: row.capturedAt,
    syncedAt: row.syncedAt,
  }
}
