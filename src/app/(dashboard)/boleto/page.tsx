'use client'

import { SequencePage } from '@/components/recovery/sequence-page'

export default function BoletoPage() {
  return (
    <SequencePage
      eventType="boleto"
      title="Recuperação de Boleto"
      description="Sequência de mensagens enviadas quando um boleto é gerado e não pago"
    />
  )
}
