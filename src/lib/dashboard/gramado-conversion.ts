import { sql, type SQL } from 'drizzle-orm'
import { gramadoReservations, recoveryLeads, whatsappMessages } from '../db/schema'

export const gramadoFirstInboundAtSql = sql`(
  select min(${whatsappMessages.createdAt})
  from ${whatsappMessages}
  where ${whatsappMessages.companyId} = ${recoveryLeads.companyId}
    and ${whatsappMessages.leadId} = ${recoveryLeads.id}
    and ${whatsappMessages.direction} = 'inbound'
)`

export const gramadoMessageCountSql = sql`(
  select count(*)
  from ${whatsappMessages}
  where ${whatsappMessages.companyId} = ${recoveryLeads.companyId}
    and ${whatsappMessages.leadId} = ${recoveryLeads.id}
)`

/**
 * `created_at` is a timestamp without time zone, but the SAC stores its
 * values in UTC. Convert the BRT boundary to a UTC timestamp without time
 * zone explicitly so the comparison does not depend on the database session
 * timezone.
 */
export function gramadoUtcTimestampSql(iso: string): SQL {
  return sql`(${iso}::timestamptz at time zone 'UTC')`
}

/**
 * A reservation is attributed to a conversation by lead_id. The phone
 * fallback keeps old mirrored rows usable when the sync could not resolve a
 * lead yet. EXISTS deliberately makes repeated reservation rows idempotent.
 */
export function gramadoReservationInPeriodSql(from: string, to: string): SQL {
  const normalizedPhone = sql`regexp_replace(coalesce(${recoveryLeads.phone}, ''), '[^0-9]', '', 'g')`
  return sql`exists (
    select 1
    from ${gramadoReservations} gr
    where gr.company_id = ${recoveryLeads.companyId}
      and (
        gr.lead_id = ${recoveryLeads.id}
        or (
          gr.lead_id is null
          and gr.phone_norm is not null
          and gr.phone_norm = ${normalizedPhone}
        )
      )
      and gr.data >= ${from}::date
      and gr.data <= ${to}::date
      and lower(trim(gr.status)) = 'compareceu'
  )`
}

export function dateKeyForAnalytics(value: Date, requestedValue?: string | null): string {
  // Date-only and timezone-bearing inputs carry the user's calendar date.
  // resolveAnalyticsPeriod normalizes them to Date objects, which can move a
  // date-only value across midnight in UTC; preserve the requested calendar
  // date when it is available.
  if (requestedValue && /^\d{4}-\d{2}-\d{2}/.test(requestedValue)) {
    return requestedValue.slice(0, 10)
  }

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}
