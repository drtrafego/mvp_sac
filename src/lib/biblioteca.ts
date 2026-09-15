// Biblioteca de sequências prontas por nicho

export interface PresetMessage {
  order: number
  delayMinutes: number
  messageType: string
  content: string
}

export interface PresetSequence {
  id: string
  nicho?: string
  eventType: string
  name: string
  description: string
  messages: PresetMessage[]
}

export const BIBLIOTECA: PresetSequence[] = [
  // ─── INFOPRODUTOS ─────────────────────────────────────────────────────────────
  {
    id: 'info_boleto_3msg',
    nicho: 'Infoprodutos',
    eventType: 'boleto',
    name: 'Boleto, 3 mensagens (infoproduto)',
    description: 'Sequência clássica: lembrete imediato, urgência no dia 2 e última chance.',
    messages: [
      {
        order: 1,
        delayMinutes: 60,
        messageType: 'text',
        content: 'Oi {primeiro_nome}, tudo bem? Aqui é da equipe de suporte do {produto}.\n\nVi que você gerou o boleto mas ainda não pagou. Quer que eu te envie o código de barras para você pagar agora pelo app do banco?\n\nO boleto vence em breve!',
      },
      {
        order: 2,
        delayMinutes: 1440,
        messageType: 'text',
        content: 'Oi {primeiro_nome}! Passando para avisar que seu boleto do {produto} vence HOJE.\n\nSe precisar do código de barras é só responder aqui e eu te mando na hora.\n\nNão perca essa oportunidade! 🎯',
      },
      {
        order: 3,
        delayMinutes: 2880,
        messageType: 'text',
        content: '{primeiro_nome}, última chamada!\n\nSeu boleto do {produto} expirou, mas podemos gerar um novo para você.\n\nQuer garantir sua vaga? Me responde aqui que eu te ajudo agora mesmo.',
      },
    ],
  },
  {
    id: 'info_pix_3msg',
    nicho: 'Infoprodutos',
    eventType: 'pix',
    name: 'Pix, 3 mensagens (infoproduto)',
    description: 'Recupera Pix gerado e não pago: lembrete imediato, urgência e última chance.',
    messages: [
      {
        order: 1,
        delayMinutes: 30,
        messageType: 'text',
        content: 'Oi {primeiro_nome}, tudo bem? Aqui é da equipe de suporte do {produto}.\n\nVi que você gerou o Pix mas o pagamento ainda não caiu. O código Pix expira rápido! Quer que eu te reenvie o copia e cola para você pagar agora pelo app do banco?',
      },
      {
        order: 2,
        delayMinutes: 120,
        messageType: 'text',
        content: '{primeiro_nome}, seu Pix do {produto} está prestes a expirar!\n\nO Pix cai na hora e libera seu acesso na mesma hora. Se precisar do código é só responder aqui que eu te mando agora mesmo. 🎯',
      },
      {
        order: 3,
        delayMinutes: 1440,
        messageType: 'text',
        content: '{primeiro_nome}, última chamada!\n\nSeu Pix do {produto} expirou, mas posso gerar um novo agora mesmo para você garantir sua vaga.\n\nQuer que eu gere? Só me responder aqui.',
      },
    ],
  },
  {
    id: 'info_carrinho_2msg',
    nicho: 'Infoprodutos',
    eventType: 'carrinho_abandonado',
    name: 'Carrinho Abandonado, 2 mensagens (infoproduto)',
    description: 'Recupera quem deixou o carrinho com curiosidade e prova social.',
    messages: [
      {
        order: 1,
        delayMinutes: 30,
        messageType: 'text',
        content: 'Oi {primeiro_nome}! Vi que você estava quase adquirindo o {produto} mas não finalizou.\n\nTeve alguma dúvida? Posso te ajudar agora mesmo! Só me contar o que ficou te impedindo.',
      },
      {
        order: 2,
        delayMinutes: 1440,
        messageType: 'text',
        content: '{primeiro_nome}, só um lembrete: o {produto} está com vagas abertas.\n\nMuita gente que estava na mesma dúvida que você já entrou e está vendo resultados. Quer que eu te envie o link para garantir sua vaga?',
      },
    ],
  },
  {
    id: 'info_cartao_3msg',
    nicho: 'Infoprodutos',
    eventType: 'cartao_recusado',
    name: 'Cartão Recusado, 3 mensagens (infoproduto)',
    description: 'Ajuda quem teve cartão recusado a concluir pelo boleto ou outro cartão.',
    messages: [
      {
        order: 1,
        delayMinutes: 30,
        messageType: 'text',
        content: 'Oi {primeiro_nome}! Parece que houve um problema com o pagamento do {produto}.\n\nIsso acontece bastante, pode ser limite ou alguma verificação do banco. Posso te enviar um boleto para você pagar sem problema nenhum?',
      },
      {
        order: 2,
        delayMinutes: 360,
        messageType: 'text',
        content: '{primeiro_nome}, ainda consigo garantir sua vaga no {produto}!\n\nSe quiser, posso gerar um PIX ou boleto para você. É muito mais simples e aprova na hora. Me fala qual prefere!',
      },
      {
        order: 3,
        delayMinutes: 1440,
        messageType: 'text',
        content: 'Ultima tentativa, {primeiro_nome}.\n\nSua vaga no {produto} ainda está reservada. Posso ajudar com boleto, PIX ou outro cartão. Qual prefere?\n\nSó me responder aqui que resolvo agora.',
      },
    ],
  },
  // ─── E-COMMERCE ──────────────────────────────────────────────────────────────
  {
    id: 'ecomm_boleto_2msg',
    nicho: 'E-commerce',
    eventType: 'boleto',
    name: 'Boleto, 2 mensagens (e-commerce)',
    description: 'Recupera boletos de e-commerce com foco no produto e na entrega.',
    messages: [
      {
        order: 1,
        delayMinutes: 120,
        messageType: 'text',
        content: 'Oi {primeiro_nome}! Seu pedido do {produto} está aguardando pagamento.\n\nO boleto foi gerado mas ainda não foi pago. Segue o código: {boleto_codigo}\n\nSe preferir, pode pagar pelo app do seu banco escaneando o QR Code.',
      },
      {
        order: 2,
        delayMinutes: 1440,
        messageType: 'text',
        content: '{primeiro_nome}, seu pedido vai ser cancelado em breve!\n\nO boleto do {produto} (R$ {valor}) vence hoje. Pague agora e garantimos a entrega.\n\nCódigo: {boleto_codigo}',
      },
    ],
  },
  // ─── SERVIÇOS ─────────────────────────────────────────────────────────────────
  {
    id: 'servicos_carrinho_2msg',
    nicho: 'Servicos',
    eventType: 'carrinho_abandonado',
    name: 'Carrinho Abandonado, 2 mensagens (serviços)',
    description: 'Para agências, consultores e prestadores de serviços.',
    messages: [
      {
        order: 1,
        delayMinutes: 30,
        messageType: 'text',
        content: 'Oi {primeiro_nome}! Notei que você iniciou a contratação do {produto} mas não concluiu.\n\nPodemos marcar uma chamada rápida de 15 minutos para esclarecer qualquer dúvida? É só me dizer qual horário fica melhor para você.',
      },
      {
        order: 2,
        delayMinutes: 2880,
        messageType: 'text',
        content: '{primeiro_nome}, minha agenda está quase cheia para este mês.\n\nSe quiser garantir uma vaga para o {produto}, é o momento. Posso reservar para você agora, basta confirmar aqui.',
      },
    ],
  },
]
