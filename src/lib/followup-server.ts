import 'server-only'
import { db } from '@/lib/db'
import { followupConfig, followupSent } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { getAgentsDb, queryAgentsDb } from '@/lib/db/agents-db'
import {
  FollowupConfig,
  FollowupStep,
  FollowupWindow,
  FollowupSpacing,
  FollowupSentStats,
  FOLLOWUP_DEFAULT_STEPS,
  FOLLOWUP_DEFAULT_WINDOW,
  FOLLOWUP_DEFAULT_SPACING,
  resolveAgentSlugForCompany,
  sanitizeSteps,
  validateStepsStrict,
  sanitizeWindow,
  sanitizeSpacing,
} from '@/lib/followup'

export async function getFollowupConfigReal(companySlug: string, companyId?: number): Promise<{
  config: FollowupConfig
  agentSlug: string | null
  isSharedDbConnected: boolean
}> {
  const agentSlug = resolveAgentSlugForCompany(companySlug)
  const fallback: FollowupConfig = {
    enabled: false,
    steps: FOLLOWUP_DEFAULT_STEPS,
    window: FOLLOWUP_DEFAULT_WINDOW,
    spacing: FOLLOWUP_DEFAULT_SPACING,
  }

  if (!agentSlug) {
    return { config: fallback, agentSlug: null, isSharedDbConnected: false }
  }

  try {
    const agentsSql = await getAgentsDb()
    if (agentsSql) {
      const rows = await queryAgentsDb<{
        enabled: boolean | null
        steps: unknown
        send_window: unknown
        spacing: unknown
        steps_by_origin: unknown
      }>(
        `SELECT enabled, steps, send_window, spacing, steps_by_origin
         FROM public.followup_config
         WHERE agent_slug = $1
         LIMIT 1`,
        [agentSlug],
      )

      if (rows && rows.length > 0) {
        const row = rows[0]
        const steps = sanitizeSteps(row.steps)
        const porOrigem = (row.steps_by_origin ?? {}) as { ad?: unknown }
        const stepsAd = sanitizeSteps(porOrigem.ad)

        return {
          config: {
            enabled: Boolean(row.enabled),
            steps: steps.length ? steps : FOLLOWUP_DEFAULT_STEPS,
            window: sanitizeWindow(row.send_window) ?? FOLLOWUP_DEFAULT_WINDOW,
            spacing: sanitizeSpacing(row.spacing) ?? FOLLOWUP_DEFAULT_SPACING,
            ...(stepsAd.length ? { stepsByOrigin: { ad: stepsAd } } : {}),
          },
          agentSlug,
          isSharedDbConnected: true,
        }
      }
    }
  } catch (err) {
    console.error('[getFollowupConfigReal shared DB error]', err)
  }

  if (companyId) {
    try {
      const [row] = await db
        .select()
        .from(followupConfig)
        .where(eq(followupConfig.companyId, companyId))
        .limit(1)

      if (row) {
        const steps = sanitizeSteps(row.steps)
        const porOrigem = (row.stepsByOrigin ?? {}) as { ad?: unknown }
        const stepsAd = sanitizeSteps(porOrigem.ad)

        return {
          config: {
            enabled: Boolean(row.enabled),
            steps: steps.length ? steps : FOLLOWUP_DEFAULT_STEPS,
            window: sanitizeWindow(row.sendWindow) ?? FOLLOWUP_DEFAULT_WINDOW,
            spacing: sanitizeSpacing(row.spacing) ?? FOLLOWUP_DEFAULT_SPACING,
            ...(stepsAd.length ? { stepsByOrigin: { ad: stepsAd } } : {}),
          },
          agentSlug,
          isSharedDbConnected: false,
        }
      }
    } catch (localErr) {
      console.error('[getFollowupConfigReal local DB error]', localErr)
    }
  }

  return { config: fallback, agentSlug, isSharedDbConnected: false }
}

export async function saveFollowupConfigReal(
  companySlug: string,
  companyId: number,
  input: {
    enabled: boolean
    steps: FollowupStep[]
    window?: FollowupWindow
    spacing?: FollowupSpacing
    stepsByOrigin?: { ad?: FollowupStep[] }
  },
): Promise<{ ok: boolean; message?: string }> {
  const agentSlug = resolveAgentSlugForCompany(companySlug)
  try {
    if (!agentSlug) {
      return { ok: false, message: 'Esta empresa não usa o follow-up do Hermes.' }
    }

    if (agentSlug === 'gramadoplazza' && input.enabled === true) {
      return {
        ok: false,
        message: 'Ativar o disparo do Gramado Plazza em produção exige autorização explícita e teste ao vivo do Gastão — ainda não está liberado.',
      }
    }

    let validatedSteps: FollowupStep[]
    let stepsAdClean: FollowupStep[] | undefined
    try {
      validatedSteps = validateStepsStrict(input.steps)
      stepsAdClean = input.stepsByOrigin?.ad ? validateStepsStrict(input.stepsByOrigin.ad, 'stepsByOrigin.ad') : undefined
    } catch (validationErr) {
      const message = validationErr instanceof Error ? validationErr.message : String(validationErr)
      return { ok: false, message }
    }

    if (validatedSteps.length === 0) {
      return { ok: false, message: 'É necessário pelo menos 1 degrau de tempo válido.' }
    }

    const windowClean = sanitizeWindow(input.window) ?? FOLLOWUP_DEFAULT_WINDOW
    const spacingClean = sanitizeSpacing(input.spacing) ?? FOLLOWUP_DEFAULT_SPACING

    const stepsByOriginClean = stepsAdClean && stepsAdClean.length > 0 ? { ad: stepsAdClean } : null

    // 1. Grava no banco compartilhado dos agentes (Supabase/Neon) onde o orchestrate.py lê
    let agentsSql: Awaited<ReturnType<typeof getAgentsDb>>
    try {
      agentsSql = await getAgentsDb()
    } catch (sharedErr) {
      console.error('[saveFollowupConfigReal shared DB error]', sharedErr)
      return { ok: false, message: 'Não consegui salvar no banco compartilhado dos agentes — a mudança real não foi aplicada.' }
    }

    if (!agentsSql) {
      return { ok: false, message: 'Não consegui salvar no banco compartilhado dos agentes — a mudança real não foi aplicada.' }
    }

    try {
      const sharedRows = await queryAgentsDb(
        `INSERT INTO public.followup_config (agent_slug, enabled, steps, send_window, spacing, steps_by_origin, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, now())
         ON CONFLICT (agent_slug) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           steps = EXCLUDED.steps,
           send_window = EXCLUDED.send_window,
           spacing = EXCLUDED.spacing,
           steps_by_origin = EXCLUDED.steps_by_origin,
           updated_at = now()`,
        [
          agentSlug,
          Boolean(input.enabled),
          JSON.stringify(validatedSteps),
          JSON.stringify(windowClean),
          JSON.stringify(spacingClean),
          stepsByOriginClean ? JSON.stringify(stepsByOriginClean) : null,
        ],
      )

      if (sharedRows === null) {
        return { ok: false, message: 'Não consegui salvar no banco compartilhado dos agentes — a mudança real não foi aplicada.' }
      }
    } catch (sharedErr) {
      console.error('[saveFollowupConfigReal shared DB error]', sharedErr)
      return { ok: false, message: 'Não consegui salvar no banco compartilhado dos agentes — a mudança real não foi aplicada.' }
    }

    // 2. Grava também no banco local do mvp_sac para redundância
    try {
      await db
        .insert(followupConfig)
        .values({
          companyId,
          enabled: Boolean(input.enabled),
          steps: validatedSteps,
          sendWindow: windowClean,
          spacing: spacingClean,
          stepsByOrigin: stepsByOriginClean,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: followupConfig.companyId,
          set: {
            enabled: Boolean(input.enabled),
            steps: validatedSteps,
            sendWindow: windowClean,
            spacing: spacingClean,
            stepsByOrigin: stepsByOriginClean,
            updatedAt: new Date(),
          },
        })
    } catch (localErr) {
      console.error('[saveFollowupConfigReal local DB error]', localErr)
    }

    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[saveFollowupConfigReal error]', msg)
    return { ok: false, message: 'Falha ao salvar configuração de follow-up.' }
  }
}

export async function getFollowupSentStatsReal(companySlug: string, companyId?: number): Promise<FollowupSentStats> {
  const agentSlug = resolveAgentSlugForCompany(companySlug)
  const fallback: FollowupSentStats = { sent24h: 0, sent7d: 0, lastSentAt: null }

  if (!agentSlug) {
    return fallback
  }

  try {
    const agentsSql = await getAgentsDb()
    if (agentsSql) {
      const rows = await queryAgentsDb<{
        sent_24h: number | string
        sent_7d: number | string
        last_sent_at: string | Date | null
      }>(
        `SELECT
           count(*) filter (where sent_at >= now() - interval '24 hours')::int as sent_24h,
           count(*) filter (where sent_at >= now() - interval '7 days')::int as sent_7d,
           max(sent_at) as last_sent_at
         FROM public.followup_sent
         WHERE agent_slug = $1`,
        [agentSlug],
      )

      if (rows && rows.length > 0) {
        const row = rows[0]
        return {
          sent24h: Number(row.sent_24h || 0),
          sent7d: Number(row.sent_7d || 0),
          lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
        }
      }
    }
  } catch (err) {
    console.error('[getFollowupSentStatsReal shared DB error]', err)
  }

  if (companyId) {
    try {
      const now = new Date()
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000)
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000)

      const [row24] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(followupSent)
        .where(and(eq(followupSent.companyId, companyId), sql`${followupSent.sentAt} >= ${dayAgo}`))

      const [row7d] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(followupSent)
        .where(and(eq(followupSent.companyId, companyId), sql`${followupSent.sentAt} >= ${weekAgo}`))

      const [lastRow] = await db
        .select({ sentAt: followupSent.sentAt })
        .from(followupSent)
        .where(eq(followupSent.companyId, companyId))
        .orderBy(sql`${followupSent.sentAt} desc`)
        .limit(1)

      return {
        sent24h: row24?.count ?? 0,
        sent7d: row7d?.count ?? 0,
        lastSentAt: lastRow?.sentAt ? new Date(lastRow.sentAt).toISOString() : null,
      }
    } catch (localErr) {
      console.error('[getFollowupSentStatsReal local DB error]', localErr)
    }
  }

  return fallback
}
