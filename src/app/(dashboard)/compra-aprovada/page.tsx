'use client'

import { useState, useEffect } from 'react'
import { Save } from 'lucide-react'
import { SequencePage } from '@/components/recovery/sequence-page'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

export default function CompraAprovadaPage() {
  const [upsellMessage, setUpsellMessage] = useState('')
  const [upsellDelay, setUpsellDelay] = useState(1440)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/sequences/compra_aprovada')
      .then((r) => r.json())
      .then((data) => {
        if (data.sequence) {
          setUpsellMessage(data.sequence.upsellMessage ?? '')
          setUpsellDelay(data.sequence.upsellDelayMinutes ?? 1440)
        }
      })
  }, [])

  async function saveUpsell() {
    setSaving(true)
    await fetch('/api/sequences/compra_aprovada', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upsellMessage, upsellDelayMinutes: upsellDelay }),
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <SequencePage
        eventType="compra_aprovada"
        title="Compra Aprovada"
        description="Sequência de mensagens de boas-vindas enviadas após compra aprovada"
      />

      <div className="panel space-y-4 p-[var(--space-card)]">
        <div>
          <h2 className="text-h2 text-fg">Oferta de Upsell</h2>
          <p className="text-body text-fg-muted mt-1">
            Mensagem de upsell enviada após as boas-vindas para oferecer produto complementar
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Mensagem de Upsell</Label>
          <Textarea
            value={upsellMessage}
            onChange={(e) => setUpsellMessage(e.target.value)}
            placeholder="Ex: Ei {nome}, já que você garantiu o curso X, temos uma oferta especial de Y por apenas R$..."
            className="focus-ring bg-surface-inset border-line-subtle min-h-[120px] max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle">Use {'{nome}'} para personalizar com o nome do comprador</p>
        </div>

        <div className="space-y-1.5">
          <Label>Enviar após quantos minutos da compra</Label>
          <Input
            type="number"
            min={0}
            value={upsellDelay}
            onChange={(e) => setUpsellDelay(parseInt(e.target.value) || 0)}
            className="focus-ring bg-surface-inset border-line-subtle w-40"
          />
          <p className="text-micro text-fg-subtle">Exemplos: 60 = 1 hora, 1440 = 24 horas</p>
        </div>

        <Button onClick={saveUpsell} disabled={saving} className="focus-ring flex h-11 items-center gap-2 bg-brand-solid text-on-accent lg:h-9">
          <Save size={15} />
          {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar Upsell'}
        </Button>
      </div>
    </div>
  )
}
