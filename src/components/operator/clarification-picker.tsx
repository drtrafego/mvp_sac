'use client'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Esclarecimento } from '@/lib/operator/acoes/types'
export function ClarificationPicker({ value, busy, onChoose, onCancel }: { value: Esclarecimento; busy: boolean; onChoose: (choice: { leadId?: number; ruleId?: number; etapaId?: string; lembrarApelido?: boolean }) => void; onCancel: () => void }) {
  const group = useId()
  const [selected, setSelected] = useState('')
  const [remember, setRemember] = useState(false)
  const options = value.tipo === 'lead' ? value.candidatos.map(c => ({ id: String(c.leadId), label: `${c.rotulo}${c.telefoneFinal ? `, final ${c.telefoneFinal}` : ''}, ${c.etapa}` })) : value.opcoes
  return <fieldset disabled={busy} className="space-y-3 rounded-lg border p-3">
    <legend className="px-1 font-medium">{value.tipo === 'lead' ? 'Qual lead você quer alterar?' : value.tipo === 'regra' ? 'Qual regra você quer alterar?' : `Qual etapa corresponde a “${value.termo}”?`}</legend>
    {options.map(o => <label key={o.id} className="flex items-center gap-2"><input type="radio" name={group} checked={selected === o.id} onChange={() => setSelected(o.id)} />{o.label}</label>)}
    {value.tipo === 'etapa' && <label className="flex items-center gap-2"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Lembrar esta escolha para a empresa</label>}
    <div className="flex gap-2"><Button type="button" disabled={!selected || busy} onClick={() => onChoose(value.tipo === 'lead' ? { leadId: Number(selected) } : value.tipo === 'regra' ? { ruleId: Number(selected) } : { etapaId: selected, lembrarApelido: remember })}>Escolher</Button><Button type="button" variant="outline" onClick={onCancel}>Cancelar</Button></div>
  </fieldset>
}
