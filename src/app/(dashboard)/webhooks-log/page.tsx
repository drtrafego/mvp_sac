export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { webhookReceived } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { RefreshButton } from './refresh-button'
import { MobileRowCard } from '@/components/ui/mobile-row-card'

const eventLabels: Record<string, string> = {
  PURCHASE_APPROVED: 'Compra aprovada',
  PURCHASE_COMPLETE: 'Compra concluída',
  BILLET_PRINTED: 'Boleto impresso',
  WAITING_PAYMENT: 'Aguardando pagamento',
  ABANDONED_CART: 'Carrinho abandonado',
  PURCHASE_REFUNDED: 'Reembolso',
  PURCHASE_CHARGEBACK: 'Chargeback',
  PURCHASE_PROTEST: 'Protesto',
  SUBSCRIPTION_CANCELLATION: 'Cancelamento assinatura',
  // Kiwify
  billet_created: 'Boleto gerado',
  pix_created: 'Pix gerado',
  order_approved: 'Compra aprovada',
  order_rejected: 'Compra recusada',
  order_refunded: 'Reembolso',
  chargeback: 'Chargeback',
  abandoned: 'Carrinho abandonado',
  subscription_canceled: 'Cancelamento assinatura',
  subscription_late: 'Assinatura atrasada',
  subscription_renewed: 'Assinatura renovada',
}

const SOURCE_LABELS: Record<string, string> = {
  hotmart: 'Hotmart',
  greenn: 'Greenn',
  zouti: 'Zouti',
  kiwify: 'Kiwify',
}

const SOURCE_VAR: Record<string, string> = {
  hotmart: 'var(--plat-hotmart)',
  greenn: 'var(--plat-greenn)',
  zouti: 'var(--plat-zouti)',
  kiwify: 'var(--plat-kiwify)',
}

const TH = 'px-3 h-10 text-left text-label uppercase text-fg-subtle whitespace-nowrap'

function fmtDate(d: Date | null): string {
  if (!d) return '-'
  return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
}

/** Erro tem precedência sobre descartado: os dois nascem de processed = false */
function statusOf(processed: boolean | null, errorMessage: string | null) {
  if (errorMessage) return { label: 'Erro', color: 'var(--st-negativo)' }
  if (processed) return { label: 'Processado', color: 'var(--st-positivo)' }
  return { label: 'Descartado', color: 'var(--st-atencao)' }
}

function StatusDot({ processed, errorMessage }: { processed: boolean | null; errorMessage: string | null }) {
  const status = statusOf(processed, errorMessage)
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-micro text-fg-muted">
      <span className="dot" style={{ color: status.color }} />
      {status.label}
    </span>
  )
}

function RawBlocks({ rawBody, headers }: { rawBody: unknown; headers: unknown }) {
  if (!rawBody && !headers) return <span className="text-fg-faint">-</span>
  return (
    <details>
      <summary className="cursor-pointer list-none text-micro text-fg-subtle transition-colors hover:text-fg">
        Ver payload
      </summary>
      <div className="mt-2 space-y-2">
        {rawBody ? (
          <div>
            <p className="text-label uppercase text-fg-faint mb-1">Payload</p>
            <pre className="num scroll-thin max-h-64 overflow-auto rounded-[var(--r-md)] bg-surface-inset p-3 text-micro whitespace-pre-wrap break-all text-fg-muted">
              {JSON.stringify(rawBody, null, 2)}
            </pre>
          </div>
        ) : null}
        {headers ? (
          <div>
            <p className="text-label uppercase text-fg-faint mb-1">Headers</p>
            <pre className="num scroll-thin max-h-48 overflow-auto rounded-[var(--r-md)] bg-surface-inset p-3 text-micro whitespace-pre-wrap break-all text-fg-muted">
              {JSON.stringify(headers, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  )
}

export default async function WebhooksLogPage() {
  const company = await requireCompany()

  const rows = await db
    .select()
    .from(webhookReceived)
    .where(eq(webhookReceived.companyId, company.id))
    .orderBy(desc(webhookReceived.receivedAt))
    .limit(50)

  const totalByEvent = rows.reduce<Record<string, { total: number; processed: number; skipped: number }>>((acc, r) => {
    const k = r.event ?? '(sem evento)'
    acc[k] = acc[k] ?? { total: 0, processed: 0, skipped: 0 }
    acc[k].total++
    if (r.processed) acc[k].processed++
    else acc[k].skipped++
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rise rise-1">
        <div>
          <h1 className="text-h1 text-fg">Webhooks recebidos</h1>
          <p className="text-body text-fg-muted mt-1 max-w-[70ch]">
            Últimos 50 webhooks recebidos de todas as plataformas para esta empresa. Útil para depurar quando algum evento não chega.
          </p>
        </div>
        <RefreshButton />
      </div>

      {Object.keys(totalByEvent).length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 rise rise-2">
          {Object.entries(totalByEvent).map(([event, stats]) => (
            <div key={event} className="card p-4">
              <p className="text-label uppercase text-fg-subtle truncate" title={eventLabels[event] ?? event}>
                {eventLabels[event] ?? event}
              </p>
              <p className="num text-metric-sm text-fg mt-2">{stats.total}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                  <span className="dot" style={{ color: 'var(--st-positivo)' }} />
                  <span className="num">{stats.processed}</span> ok
                </span>
                <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                  <span className="dot" style={{ color: 'var(--st-atencao)' }} />
                  <span className="num">{stats.skipped}</span> descartado
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card-section overflow-hidden rise rise-3">
        {/* Celular: uma linha da tabela vira um card */}
        <div className="space-y-2 p-3 md:hidden">
          {rows.length === 0 && (
            <p className="py-6 text-center text-body text-fg-subtle">Nenhum webhook recebido ainda.</p>
          )}
          {rows.map(r => (
            <MobileRowCard
              key={r.id}
              title={
                r.event
                  ? (eventLabels[r.event] ?? <span className="num">{r.event}</span>)
                  : <span className="text-fg-faint">(sem evento)</span>
              }
              subtitle={
                r.errorMessage
                  ? <span className="num text-st-negativo">{r.errorMessage}</span>
                  : (r.skipReason ?? '-')
              }
              meta={
                <>
                  <span className="num text-fg-subtle">{fmtDate(r.receivedAt)}</span>
                  <span className="num text-fg-faint">{r.leadId ? `#${r.leadId}` : 'sem lead'}</span>
                </>
              }
              badges={
                <>
                  {r.source && (
                    <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                      <span className="dot" style={{ color: SOURCE_VAR[r.source] ?? 'var(--fg-faint)' }} />
                      {SOURCE_LABELS[r.source] ?? r.source}
                    </span>
                  )}
                  <StatusDot processed={r.processed} errorMessage={r.errorMessage} />
                </>
              }
            >
              <div className="mt-3 border-t border-line-subtle pt-2">
                <RawBlocks rawBody={r.rawBody} headers={r.headers} />
              </div>
            </MobileRowCard>
          ))}
        </div>

        {/* Desktop: tabela com rolagem horizontal própria */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line-default">
                <th className={TH}>Data e hora</th>
                <th className={TH}>Origem</th>
                <th className={TH}>Evento</th>
                <th className={TH}>Status</th>
                <th className={TH}>Motivo ou erro</th>
                <th className={TH}>Lead</th>
                <th className={TH}>Payload</th>
                <th className="w-full" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-body text-fg-subtle">
                    Nenhum webhook recebido ainda.
                  </td>
                </tr>
              )}
              {rows.map(r => (
                <tr key={r.id} className="border-b border-line-subtle tr-hover align-top">
                  <td className="num h-12 whitespace-nowrap px-3 py-3 text-micro text-fg-muted">{fmtDate(r.receivedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    {r.source ? (
                      <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                        <span className="dot" style={{ color: SOURCE_VAR[r.source] ?? 'var(--fg-faint)' }} />
                        {SOURCE_LABELS[r.source] ?? r.source}
                      </span>
                    ) : (
                      <span className="text-fg-faint">-</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {r.event ? (
                      <span className="num text-micro text-fg">{r.event}</span>
                    ) : (
                      <span className="text-micro text-fg-faint">(sem evento)</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusDot processed={r.processed} errorMessage={r.errorMessage} />
                  </td>
                  <td className="num max-w-[260px] px-3 py-3 text-micro">
                    {r.errorMessage ? (
                      <span className="text-st-negativo">{r.errorMessage}</span>
                    ) : (
                      <span className="text-fg-muted">{r.skipReason ?? '-'}</span>
                    )}
                  </td>
                  <td className="num px-3 py-3 text-micro text-fg-muted">
                    {r.leadId ? `#${r.leadId}` : '-'}
                  </td>
                  <td className="min-w-[200px] max-w-[420px] px-3 py-3">
                    <RawBlocks rawBody={r.rawBody} headers={r.headers} />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
