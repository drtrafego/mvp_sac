export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { AlertCircle, FileCheck } from 'lucide-react'
import { loadApprovedMetaTemplates } from '@/lib/meta-templates'

export default async function ApiModelosPage() {
  const company = await requireCompany()

  const [companySettings] = await db.select().from(settings).where(eq(settings.companyId, company.id))
  const metaTemplates = await loadApprovedMetaTemplates(companySettings)

  const hasMeta = metaTemplates.kind === 'ready' || metaTemplates.kind === 'empty'

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <FileCheck size={12} />
            Empresa: {company.name} · Meta HSM Templates
          </span>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
            hasMeta
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
          }`}>
            {hasMeta ? 'Meta WABA Conectada' : 'Pendente de WABA ID'}
          </span>
        </div>
        <h1 className="text-h1 text-fg">Mensagens Aprovadas (Meta Cloud API)</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Templates de mensagens homologados pela Meta para disparo de notificações e recuperação via WhatsApp Oficial para a empresa <strong>{company.name}</strong>.
        </p>
      </div>

      {metaTemplates.kind !== 'ready' && (
        <div className={`rise rise-2 rounded-[var(--r-lg)] border p-4 flex items-start gap-3 ${
          metaTemplates.kind === 'error'
            ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
            : 'bg-amber-500/10 border-amber-500/20 text-amber-300'
        }`}>
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="text-label font-semibold">
              {metaTemplates.kind === 'empty' ? 'Nenhum template aprovado retornado' : 'Templates Meta indisponíveis'}
            </p>
            <p className="text-body text-fg-muted mt-1">{metaTemplates.message}</p>
          </div>
        </div>
      )}

      <div className="rise rise-3 grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
        {metaTemplates.templates.map((m) => (
          <div key={`${m.nome}:${m.idioma}`} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-micro font-mono font-bold text-brand-ink">{m.nome}</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {m.status}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-fg-faint mt-1">
                <span>Categoria: {m.categoria}</span>
                <span>•</span>
                <span>Idioma: {m.idioma}</span>
              </div>
            </div>

            {/* Prévia do Balão WhatsApp */}
            <div className="bg-[#0b141a] border border-[#1f2c34] p-3.5 rounded-xl text-body text-[#e9edef] space-y-2">
              <p className="text-micro leading-relaxed">{m.corpo || 'Template aprovado sem prévia de corpo retornada pela Meta.'}</p>
              <div className="flex items-center justify-end text-[10px] text-[#8696a0] gap-1">
                <span>12:00</span>
                <span className="text-brand-ink">✓✓</span>
              </div>
            </div>

            <div className="pt-3 border-t border-line-subtle">
              <span className="text-[10px] uppercase font-bold text-fg-faint block mb-1.5">Variáveis do Template:</span>
              <div className="flex flex-wrap gap-1.5">
                {m.variaveis.length === 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded bg-surface-inset text-fg-subtle border border-line-subtle">
                    Sem variáveis no corpo
                  </span>
                )}
                {m.variaveis.map((v, i) => (
                  <span key={v} className="text-[11px] font-mono px-2 py-0.5 rounded bg-surface-inset text-fg-subtle border border-line-subtle">
                    {`{{${i + 1}}}`} = {v}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
