'use client'

import { SequencePage } from '@/components/recovery/sequence-page'

export default function CartaoRecusadoPage() {
  return (
    <SequencePage
      eventType="cartao_recusado"
      title="Cartão Recusado"
      description="Sequência de mensagens enviadas quando o cartão de crédito é recusado"
    />
  )
}
