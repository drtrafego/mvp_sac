'use client'

import { SequencePage } from '@/components/recovery/sequence-page'

export default function PixPage() {
  return (
    <SequencePage
      eventType="pix"
      title="Recuperação de Pix"
      description="Sequência de mensagens enviadas quando um Pix é gerado e não pago"
    />
  )
}
