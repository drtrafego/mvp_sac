'use client'

import { useEffect, useState } from 'react'
import { Bot, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Nome do bot (agentDisplayName). Extraído de configuracoes/page.tsx para viver
 * sozinho aqui: é usado pela aba Agente e mantém seu próprio fetch/save,
 * independente do form gigante de Configurações (que cuida só de integrações).
 */
export function AgentNameCard() {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => setName(data.agentDisplayName ?? ''))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave() {
    setSaving(true)
    setError('')
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentDisplayName: name }),
    })
    const json = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) {
      setError(json.error ?? 'Erro ao salvar o nome do bot.')
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <section className="panel p-[var(--space-card)] space-y-3">
      <div className="flex items-center gap-2">
        <Bot size={16} className="text-fg-subtle" />
        <h2 className="text-h2 text-fg">Nome do bot</h2>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="agent-display-name">Como o bot se apresenta</Label>
        <Input
          id="agent-display-name"
          value={name}
          disabled={loading}
          onChange={e => setName(e.target.value)}
          placeholder="Ex.: Clara"
          maxLength={80}
          className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
        />
        <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
          Este nome aparece nas conversas e, depois de salvo, tem precedência sobre o nome sincronizado
          automaticamente do bot nativo.
        </p>
        {error && <p className="text-micro text-st-negativo">{error}</p>}
      </div>
      <Button onClick={handleSave} disabled={saving || loading} className="focus-ring flex h-11 items-center gap-2 bg-brand-solid text-on-accent lg:h-9">
        <Save size={15} />
        {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar nome'}
      </Button>
    </section>
  )
}
