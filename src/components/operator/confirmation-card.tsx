'use client'
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ActionView } from '@/lib/operator/acoes/types'
export function ConfirmationCard({ actions, expiresAt, busy, onConfirm, onCancel }: {
  actions: ActionView[]; expiresAt: string; busy: boolean; onConfirm: (codigo: string) => void; onCancel: () => void
}) {
  const [codigo, setCodigo] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const field = useId()
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000))
  const first = actions.find(a => a.cartao)?.cartao
  if (!first) return null
  return <section aria-label="Confirmação de regras" className="space-y-3 rounded-lg border p-4">
    <p className="font-semibold">Confira antes de confirmar</p>
    {actions.filter(a => a.cartao).map(a => <div key={a.id} className="space-y-2 border-b pb-3">
      <p>{a.resumo}</p><p>{a.cartao!.alcance} {a.cartao!.correspondencia}: <strong>{a.cartao!.palavra}</strong>.</p>
      <p className="whitespace-pre-wrap break-words">{a.cartao!.mensagem}</p>
      {a.cartao!.dominios.map(domain => <p key={domain}>Domínio: <strong>{domain}</strong></p>)}
      {a.cartao!.avisos.map(warning => <p key={warning} className="font-medium">{warning}</p>)}
    </div>)}
    <p>{seconds ? `Prazo restante: ${Math.floor(seconds / 60)}min ${seconds % 60}s.` : 'O prazo de 15 minutos venceu. Faça um novo pedido.'}</p>
    <label htmlFor={field}>Digite <strong>{first.codigo}</strong> para confirmar todas as ações deste pedido.</label>
    <input id={field} className="w-full rounded border p-2" value={codigo} onChange={e => setCodigo(e.target.value)} disabled={busy || !seconds} autoComplete="off" maxLength={80} />
    <div className="flex gap-2"><Button type="button" disabled={busy || !seconds || !codigo.trim()} onClick={() => onConfirm(codigo)}>Confirmar</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancelar</Button></div>
  </section>
}
