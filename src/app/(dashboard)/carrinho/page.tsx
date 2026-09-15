'use client'

import { SequencePage } from '@/components/recovery/sequence-page'

export default function CarrinhoPage() {
  return (
    <SequencePage
      eventType="carrinho_abandonado"
      title="Carrinho Abandonado"
      description="Sequência de mensagens enviadas quando um cliente abandona o carrinho"
    />
  )
}
