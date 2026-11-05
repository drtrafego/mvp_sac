'use client'

import { Megaphone } from 'lucide-react'
import { buildLeadAttributionRows, type LeadAttributionInput } from './lead-attribution'

export function LeadAttributionCard({ lead }: { lead: LeadAttributionInput }) {
  const rows = buildLeadAttributionRows(lead)

  return (
    <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2" data-testid="lead-attribution-card">
      <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-fg-subtle">
        <Megaphone size={13} /> Origem da aquisição
      </h4>
      <dl className="space-y-1.5 text-micro">
        {rows.map(row => (
          <div key={row.key} className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-fg-faint">{row.label}</dt>
            <dd
              className="min-w-0 text-right font-semibold text-fg break-words"
              data-testid={`lead-attribution-${row.key}`}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[10px] text-fg-faint">
        Campos ausentes aparecem como “Não informado”; origem não é inferida a partir do canal.
      </p>
    </div>
  )
}
