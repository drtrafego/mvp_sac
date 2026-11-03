import Link from 'next/link'
import { and, desc, eq, sql } from 'drizzle-orm'
import { Activity, AudioLines, CheckCircle2, ChevronRight, CircleAlert, Eye, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react'
import { db } from '@/lib/db'
import { sacAuditEvents } from '@/lib/db/schema'

export async function AiOperationsPanel({ companyId }: { companyId: number }) {
  const [recentEvents, [interpreted], [blocked], [audio]] = await Promise.all([
    db.select({ id: sacAuditEvents.id, type: sacAuditEvents.type, payload: sacAuditEvents.payload, occurredAt: sacAuditEvents.occurredAt, leadId: sacAuditEvents.leadId })
      .from(sacAuditEvents)
      .where(and(eq(sacAuditEvents.companyId, companyId), sql`${sacAuditEvents.type} like 'ai_%'`))
      .orderBy(desc(sacAuditEvents.occurredAt))
      .limit(6),
    db.select({ total: sql<number>`cast(count(*) as int)` }).from(sacAuditEvents).where(and(eq(sacAuditEvents.companyId, companyId), eq(sacAuditEvents.type, 'ai_conversation_interpreted'))),
    db.select({ total: sql<number>`cast(count(*) as int)` }).from(sacAuditEvents).where(and(eq(sacAuditEvents.companyId, companyId), sql`${sacAuditEvents.type} like '%blocked'`)),
    db.select({ total: sql<number>`cast(count(*) as int)` }).from(sacAuditEvents).where(and(eq(sacAuditEvents.companyId, companyId), eq(sacAuditEvents.type, 'ai_audio_transcription_blocked'))),
  ])
  const bridgeConfigured = Boolean(process.env.AI_BRIDGE_URL?.trim() && process.env.AI_BRIDGE_TOKEN?.trim())
  const transcriberConfigured = Boolean(process.env.HERMES_TRANSCRIBE_URL?.trim() && process.env.HERMES_TRANSCRIBE_SHARED_DIR?.trim())
  const eventLabel = (type: string) => type === 'ai_conversation_interpreted' ? 'interpretação registrada' : type === 'ai_audio_transcription_blocked' ? 'transcrição bloqueada' : 'ação/IA bloqueada'
  const eventIntent = (payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'estado registrado'
    const intent = (payload as Record<string, unknown>).intent
    return typeof intent === 'string' ? intent : 'estado registrado'
  }
  return (
    <section className="overflow-hidden rounded-[var(--r-md)] border border-brand-solid/35 bg-gradient-to-br from-brand-solid/10 via-surface-panel to-surface-panel shadow-sm">
      <div className="border-b border-brand-solid/15 px-[var(--space-card)] py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-solid text-on-accent shadow-sm"><Sparkles size={20} /></div>
            <div><p className="text-micro font-bold uppercase tracking-[0.14em] text-brand-ink">Camada principal do SAC</p><h2 className="mt-1 text-[22px] font-bold tracking-tight text-fg">Inteligência do atendimento</h2><p className="mt-1 max-w-2xl text-body text-fg-muted">Interpretação visível por conversa, áudio preservado, proposta de ação e auditoria. Follow-up automático permanece em uma área separada.</p></div>
          </div>
          <Link href="/inbox" className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-brand-solid/30 bg-brand-glow px-3 py-2 text-micro font-bold text-brand-ink hover:bg-brand-solid/15">Abrir uma conversa <ChevronRight size={14} /></Link>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <div className="rounded-xl border border-line-subtle bg-surface-panel/80 p-3"><p className="text-xl font-bold text-fg num">{interpreted?.total ?? 0}</p><p className="text-micro text-fg-muted">Interpretações auditadas</p></div>
          <div className="rounded-xl border border-line-subtle bg-surface-panel/80 p-3"><p className="text-xl font-bold text-fg num">{blocked?.total ?? 0}</p><p className="text-micro text-fg-muted">Bloqueios explicados</p></div>
          <div className="rounded-xl border border-line-subtle bg-surface-panel/80 p-3"><p className="text-xl font-bold text-fg num">{audio?.total ?? 0}</p><p className="text-micro text-fg-muted">Falhas de transcrição</p></div>
          <div className="rounded-xl border border-line-subtle bg-surface-panel/80 p-3"><p className="text-xl font-bold text-fg">{bridgeConfigured ? 'Ativa' : 'Bloqueada'}</p><p className="text-micro text-fg-muted">Ponte de IA no servidor</p></div>
        </div>
      </div>
      <div className="grid gap-4 p-[var(--space-card)] lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-3">
          <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-brand-ink" /><h3 className="text-body font-bold text-fg">O que a IA pode fazer</h3></div>
          <div className="space-y-2 text-micro">
            <div className="flex gap-2 rounded-lg border border-line-subtle bg-surface-inset p-2.5"><Eye size={14} className="mt-0.5 shrink-0 text-brand-ink" /><div><strong className="text-fg">Interpretar texto e áudio</strong><p className="text-fg-muted">Intenção, evidências, estado e confiança declarada pela ponte.</p></div></div>
            <div className="flex gap-2 rounded-lg border border-line-subtle bg-surface-inset p-2.5"><Activity size={14} className="mt-0.5 shrink-0 text-brand-ink" /><div><strong className="text-fg">Propor ações autorizadas</strong><p className="text-fg-muted">Comentário/DM do Instagram, checagem de seguir, gatilho Luana e templates aprovados.</p></div></div>
            <div className="flex gap-2 rounded-lg border border-line-subtle bg-surface-inset p-2.5"><LockKeyhole size={14} className="mt-0.5 shrink-0 text-amber-500" /><div><strong className="text-fg">Executar com gates</strong><p className="text-fg-muted">Consentimento, revisão humana, lock, idempotência e auditoria impedem efeitos silenciosos.</p></div></div>
            <div className="flex gap-2 rounded-lg border border-line-subtle bg-surface-inset p-2.5"><AudioLines size={14} className="mt-0.5 shrink-0 text-brand-ink" /><div><strong className="text-fg">Receber áudio do navegador</strong><p className="text-fg-muted">Gravação explícita HTTPS ou upload, pré-escuta, preservação e transcrição Hermes.</p></div></div>
          </div>
          <div className="flex flex-wrap gap-2 text-[10px] font-semibold"><span className={`rounded-full border px-2 py-1 ${bridgeConfigured ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{bridgeConfigured ? 'AI bridge configurada' : 'AI bridge bloqueada: configuração ausente'}</span><span className={`rounded-full border px-2 py-1 ${transcriberConfigured ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{transcriberConfigured ? 'Hermes transcriber configurado' : 'Transcrição bloqueada: configuração ausente'}</span></div>
        </div>
        <div className="space-y-3"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><CheckCircle2 size={16} className="text-brand-ink" /><h3 className="text-body font-bold text-fg">Auditoria recente</h3></div><span className="text-micro text-fg-faint">sem conteúdo sensível</span></div>{recentEvents.length === 0 ? <div className="rounded-xl border border-dashed border-line-subtle p-4 text-micro text-fg-muted">Ainda não há interpretação registrada. Abra uma conversa e use a aba IA para gerar a primeira leitura.</div> : <div className="space-y-2">{recentEvents.map(event => <div key={event.id} className="flex items-start justify-between gap-3 rounded-lg border border-line-subtle bg-surface-inset p-2.5 text-micro"><div className="flex items-start gap-2">{event.type.endsWith('blocked') ? <CircleAlert size={14} className="mt-0.5 text-amber-500" /> : <CheckCircle2 size={14} className="mt-0.5 text-emerald-500" />}<div><p className="font-semibold text-fg">{eventLabel(event.type)}</p><p className="text-fg-muted">Atendimento {event.leadId ? `#${event.leadId}` : 'geral'} · {eventIntent(event.payload)}</p></div></div><time className="shrink-0 text-[10px] text-fg-faint">{event.occurredAt ? new Date(event.occurredAt).toLocaleDateString('pt-BR') : ''}</time></div>)}</div>}</div>
      </div>
    </section>
  )
}
