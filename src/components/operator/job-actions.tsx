'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { mensagemErro } from '@/lib/operator/acoes/error-messages'
import type { ActionView } from '@/lib/operator/acoes/types'
import { ClarificationPicker } from './clarification-picker'
export function OperatorJobActions({ job, onChange }: { job: { id: string; status: string; updatedAt?: string; resultJson?: { acoes?: boolean } | null }; onChange: () => Promise<void> }) {
  const [actions, setActions] = useState<ActionView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const enabled = job.resultJson?.acoes === true
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetch(`/api/operator/jobs/${job.id}/acoes`, { cache: 'no-store', signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Não foi possível carregar as ações.'); if (!controller.signal.aborted) { setActions(data.acoes ?? []); setError(null) } })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Falha ao carregar ações.') })
    return () => controller.abort()
  }, [job.id, job.status, job.updatedAt, enabled, revision])
  if (!enabled) return null
  async function mutate(path: string, body: object) {
    setBusy(true); setError(null)
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Não foi possível concluir a operação.')
      setRevision(r => r + 1)
      await onChange()
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha na operação.') }
    finally { setBusy(false) }
  }
  return <div className="space-y-3" aria-busy={busy}>
    {actions.map(a => <div key={a.id} className="space-y-2">
      <p>{a.resumo}{a.desfeita ? ' (desfeita)' : ''}</p>
      {a.erro && <p className="text-destructive">Não aplicado: {mensagemErro(a.erro)}</p>}
      {a.erroDesfazer && <p className="text-destructive">{a.erroDesfazer === 'CONFLICT' ? 'Mudou depois, não desfeito.' : mensagemErro(a.erroDesfazer)}</p>}
      {a.esclarecimento && <ClarificationPicker key={`${a.id}:${a.esclarecimento.tipo}`} value={a.esclarecimento} busy={busy}
        onChoose={choice => void mutate(`/api/operator/jobs/${job.id}/clarify`, { actionId: a.id, ...choice })}
        onCancel={() => void mutate(`/api/operator/jobs/${job.id}/cancel`, {})} />}
      {a.podeDesfazer && <Button type="button" variant="outline" disabled={busy} onClick={() => { if (window.confirm(`Tem certeza que deseja desfazer? ${a.resumo}`)) void mutate(`/api/operator/actions/${a.id}/undo`, {}) }}>Desfazer</Button>}
    </div>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>
}
