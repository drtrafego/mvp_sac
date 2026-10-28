import { sql, and, desc, eq, isNull, lte, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, sacHealthChecks, sacHealthIncidents, settings } from '@/lib/db/schema'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { buildHealthFeatures, configurationStatus, type HealthFeature, type HealthSeverity, type HealthStatus } from './definitions'

const ALERT_COOLDOWN_MS = 30 * 60 * 1000
const ALERT_RETRY_MS = 5 * 60 * 1000
const HEALTH_TIMEOUT_MS = 3000

export type HealthCheckView = {
  id: number
  featureKey: string
  label: string
  description: string
  status: HealthStatus
  severity: HealthSeverity
  critical: boolean
  reason: string
  latencyMs: number | null
  statusCode: number | null
  checkedAt: string
  configured: boolean
}

export type HealthIncidentView = {
  id: number
  featureKey: string
  label: string
  severity: HealthSeverity
  reason: string
  startedAt: string
  lastSeenAt: string
  recoveredAt: string | null
  checkId: number | null
  isOpen: boolean
}

type NotifyResult = { ok: boolean; error?: string }
type Notify = (input: { phone: string; message: string; companyId: number }) => Promise<NotifyResult>

const defaultNotify: Notify = async ({ phone, message, companyId }) => {
  try {
    await sendWhatsAppMessage(phone, { type: 'text', content: message }, companyId)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function nowIso(date: Date) {
  return date.toISOString()
}

function severityFor(feature: HealthFeature, status: HealthStatus): HealthSeverity {
  return feature.critical && status === 'failing' ? 'critical' : 'warning'
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}

async function probeRemote(feature: HealthFeature): Promise<{ status: HealthStatus; reason: string; latencyMs: number; statusCode: number | null }> {
  const started = Date.now()
  if (!feature.configured || !feature.url) return { ...configurationStatus(feature), latencyMs: Date.now() - started, statusCode: null }
  try {
    const response = await fetch(feature.url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      cache: 'no-store',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - started
    // GET 401/403/405 still proves the configured endpoint is reachable. The
    // probe never sends a message or mutates the remote service.
    if (response.ok || [401, 403, 405].includes(response.status)) {
      return { status: 'active', reason: `Endpoint respondeu HTTP ${response.status} a uma leitura segura.`, latencyMs, statusCode: response.status }
    }
    return { status: response.status >= 500 ? 'failing' : 'degraded', reason: `Endpoint respondeu HTTP ${response.status}.`, latencyMs, statusCode: response.status }
  } catch (error) {
    return { status: 'failing', reason: `Falha ao alcançar o endpoint: ${safeError(error)}`, latencyMs: Date.now() - started, statusCode: null }
  }
}

async function localMetrics(companyId: number): Promise<{ queue: { pending: number; failed: number }; mining: number }> {
  const [queueResult, miningResult] = await Promise.all([
    db.execute<{ pending: number; failed: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE mj.status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE mj.status = 'failed')::int AS failed
      FROM message_jobs mj
      INNER JOIN recovery_leads rl ON rl.id = mj.lead_id
      WHERE rl.company_id = ${companyId}
    `),
    db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM recovery_leads
      WHERE company_id = ${companyId} AND lower(COALESCE(channel, '')) IN ('mineracao', 'mineração', 'mining')
    `),
  ])
  return {
    queue: { pending: Number(queueResult.rows[0]?.pending ?? 0), failed: Number(queueResult.rows[0]?.failed ?? 0) },
    mining: Number(miningResult.rows[0]?.count ?? 0),
  }
}

function localQueueResult(metrics: { pending: number; failed: number }): { status: HealthStatus; reason: string; latencyMs: number; statusCode: number } {
  if (metrics.failed > 0) return { status: 'degraded', reason: `${metrics.failed} item(ns) da fila estão em falha.`, latencyMs: 0, statusCode: 200 }
  if (metrics.pending > 100) return { status: 'degraded', reason: `${metrics.pending} item(ns) aguardando processamento.`, latencyMs: 0, statusCode: 200 }
  return { status: 'active', reason: metrics.pending ? `${metrics.pending} item(ns) aguardando processamento.` : 'Fila sem pendências.', latencyMs: 0, statusCode: 200 }
}

async function persistCheck(companyId: number, view: Omit<HealthCheckView, 'id' | 'checkedAt'>, checkedAt: Date): Promise<HealthCheckView> {
  const [saved] = await db
    .insert(sacHealthChecks)
    .values({
      companyId,
      featureKey: view.featureKey,
      label: view.label,
      description: view.description,
      status: view.status,
      severity: view.severity,
      critical: view.critical,
      configured: view.configured,
      reason: view.reason,
      latencyMs: view.latencyMs,
      statusCode: view.statusCode,
      checkedAt,
    })
    .onConflictDoUpdate({
      target: [sacHealthChecks.companyId, sacHealthChecks.featureKey],
      set: {
        label: view.label,
        description: view.description,
        status: view.status,
        severity: view.severity,
        critical: view.critical,
        configured: view.configured,
        reason: view.reason,
        latencyMs: view.latencyMs,
        statusCode: view.statusCode,
        checkedAt,
        updatedAt: checkedAt,
      },
    })
    .returning()
  return {
    ...view,
    id: saved.id,
    checkedAt: nowIso(saved.checkedAt ?? checkedAt),
  }
}

async function sendFailureAlert(
  companyId: number,
  companyName: string,
  phone: string | null | undefined,
  check: HealthCheckView,
  incidentId: number,
  notify: Notify,
) {
  if (!phone) return
  const message = [
    `🚨 SAC: falha crítica em ${companyName}`,
    `${check.label} · ${check.reason}`,
    `Início: ${check.checkedAt}`,
    `Severidade: ${check.severity}`,
    `Checagem #${check.id} · Incidente #${incidentId}`,
  ].join('\n')
  return notify({ phone, message, companyId })
}

async function sendRecoveryAlert(
  companyId: number,
  companyName: string,
  phone: string | null | undefined,
  check: HealthCheckView,
  incidentId: number,
  notify: Notify,
) {
  if (!phone) return
  const message = [
    `✅ SAC recuperado em ${companyName}`,
    `${check.label} voltou a responder.`,
    `Verificação: ${check.checkedAt}`,
    `Checagem #${check.id} · Incidente #${incidentId}`,
  ].join('\n')
  return notify({ phone, message, companyId })
}

async function reconcileIncident(
  company: { id: number; name: string },
  notificationPhone: string | null | undefined,
  check: HealthCheckView,
  notify: Notify,
) {
  const [open] = await db.select().from(sacHealthIncidents).where(and(
    eq(sacHealthIncidents.companyId, company.id),
    eq(sacHealthIncidents.featureKey, check.featureKey),
    eq(sacHealthIncidents.isOpen, true),
  )).limit(1)

  if (check.status === 'failing' && check.critical) {
    let incident = open
    if (!incident) {
      const [inserted] = await db.insert(sacHealthIncidents).values({
        companyId: company.id,
        featureKey: check.featureKey,
        label: check.label,
        severity: check.severity,
        reason: check.reason,
        isOpen: true,
        startedAt: new Date(check.checkedAt),
        lastSeenAt: new Date(check.checkedAt),
        lastCheckId: check.id,
        fingerprint: `${check.featureKey}:${check.reason}`.slice(0, 500),
      }).onConflictDoNothing().returning()
      incident = inserted
      if (!incident) {
        const [raced] = await db.select().from(sacHealthIncidents).where(and(
          eq(sacHealthIncidents.companyId, company.id),
          eq(sacHealthIncidents.featureKey, check.featureKey),
          eq(sacHealthIncidents.isOpen, true),
        )).limit(1)
        incident = raced
      }
    }
    if (!incident) return
    await db.update(sacHealthIncidents).set({
      label: check.label,
      severity: check.severity,
      reason: check.reason,
      lastSeenAt: new Date(check.checkedAt),
      lastCheckId: check.id,
      fingerprint: `${check.featureKey}:${check.reason}`.slice(0, 500),
    }).where(eq(sacHealthIncidents.id, incident.id))

    if (!notificationPhone) return
    const now = new Date()
    const [claim] = await db.update(sacHealthIncidents).set({
      nextAlertAt: new Date(now.getTime() + ALERT_COOLDOWN_MS),
    }).where(and(
      eq(sacHealthIncidents.id, incident.id),
      or(isNull(sacHealthIncidents.nextAlertAt), lte(sacHealthIncidents.nextAlertAt, now)),
    )).returning()
    if (!claim) return
    const result = await sendFailureAlert(company.id, company.name, notificationPhone, check, incident.id, notify)
    if (result?.ok) {
      await db.update(sacHealthIncidents).set({ alertSentAt: new Date() }).where(eq(sacHealthIncidents.id, incident.id))
    } else {
      await db.update(sacHealthIncidents).set({
        nextAlertAt: new Date(Date.now() + ALERT_RETRY_MS),
        lastAlertError: result?.error ?? 'Canal interno não configurado.',
      }).where(eq(sacHealthIncidents.id, incident.id))
    }
    return
  }

  if (open && open.isOpen && check.status !== 'failing') {
    const [closed] = await db.update(sacHealthIncidents).set({
      isOpen: false,
      recoveredAt: new Date(check.checkedAt),
      lastSeenAt: new Date(check.checkedAt),
      lastCheckId: check.id,
    }).where(and(eq(sacHealthIncidents.id, open.id), eq(sacHealthIncidents.isOpen, true))).returning()
    if (!closed || !notificationPhone || !open.alertSentAt) return
    const [claim] = await db.update(sacHealthIncidents).set({ recoveryAlertSentAt: new Date() }).where(and(
      eq(sacHealthIncidents.id, open.id),
      isNull(sacHealthIncidents.recoveryAlertSentAt),
    )).returning()
    if (claim) await sendRecoveryAlert(company.id, company.name, notificationPhone, check, open.id, notify)
  }
}

export async function runHealthChecks(
  companyId: number,
  options: { notify?: Notify; now?: Date } = {},
): Promise<{ checks: HealthCheckView[]; incidents: HealthIncidentView[] }> {
  const checkedAt = options.now ?? new Date()
  const notify = options.notify ?? defaultNotify
  const [[company], [companySettings]] = await Promise.all([
    db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1),
    db.select().from(settings).where(eq(settings.companyId, companyId)).limit(1),
  ])
  if (!company) throw new Error('Empresa não encontrada.')

  const metrics = await localMetrics(companyId)
  const features = buildHealthFeatures(companySettings, process.env, metrics.mining)
  const checks: HealthCheckView[] = []
  for (const feature of features) {
    let result: { status: HealthStatus; reason: string; latencyMs: number | null; statusCode: number | null }
    if (feature.key === 'database') {
      const started = Date.now()
      try {
        await db.execute(sql`SELECT 1`)
        result = { status: 'active', reason: 'Banco respondeu à consulta de leitura.', latencyMs: Date.now() - started, statusCode: 200 }
      } catch (error) {
        result = { status: 'failing', reason: `Falha na consulta do banco: ${safeError(error)}`, latencyMs: Date.now() - started, statusCode: null }
      }
    } else if (feature.key === 'queue-worker') {
      result = localQueueResult(metrics.queue)
      result.statusCode = 200
    } else if (feature.kind === 'remote') {
      result = await probeRemote(feature)
    } else if (feature.kind === 'configuration') {
      const started = Date.now()
      const configured = configurationStatus(feature)
      result = { ...configured, latencyMs: Date.now() - started, statusCode: null }
    } else {
      result = { status: 'active', reason: 'Sessão autenticada e rota do SAC em execução.', latencyMs: 0, statusCode: 200 }
    }
    const viewWithoutId = {
      featureKey: feature.key,
      label: feature.label,
      description: feature.description,
      status: result.status,
      severity: severityFor(feature, result.status),
      critical: feature.critical,
      reason: result.reason,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      configured: feature.configured,
    }
    const check = await persistCheck(companyId, viewWithoutId, checkedAt)
    checks.push(check)
    await reconcileIncident(company, companySettings?.notificationPhone, check, notify)
  }

  const incidents = await listHealthIncidents(companyId)
  return { checks, incidents }
}

export async function listHealthIncidents(companyId: number): Promise<HealthIncidentView[]> {
  const rows = await db.select().from(sacHealthIncidents)
    .where(eq(sacHealthIncidents.companyId, companyId))
    .orderBy(desc(sacHealthIncidents.startedAt))
    .limit(50)
  return rows.map(row => ({
    id: row.id,
    featureKey: row.featureKey,
    label: row.label,
    severity: row.severity as HealthSeverity,
    reason: row.reason,
    startedAt: nowIso(row.startedAt),
    lastSeenAt: nowIso(row.lastSeenAt),
    recoveredAt: row.recoveredAt ? nowIso(row.recoveredAt) : null,
    checkId: row.lastCheckId,
    isOpen: row.isOpen,
  }))
}
