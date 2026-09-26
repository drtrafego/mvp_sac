// Política de envio do executor da fila de messageJobs (src/app/api/cron/route.ts):
// (1) checagem da janela de 24h da Meta antes de mandar mensagem livre, e
// (2) limite conservador de mensagens por execução do cron, pra não estourar
// o tier de mensageria do número (WhatsApp Business API) nem o rate limit
// da Graph API. Extraído do executor pra ser testável sem banco/rede real.
//
// ⚠️ PENDÊNCIA (26/09/2026, revertido em emergência): checkMetaWindowForJob()
// continua aqui e testada, mas o route.ts PAROU de usar o resultado pra
// bloquear o envio (só loga aviso). Motivo: os 4 eventos de disparo frio da
// biblioteca padrão (carrinho_abandonado, boleto, pix, cartao_recusado em
// src/lib/biblioteca.ts) usam messageType: 'text' e são o PRIMEIRO contato
// com o lead (lastInboundAt quase sempre null) — bloquear aqui derruba o
// funil de recuperação inteiro, que é o motivo do produto existir. Plano
// correto, ainda não feito: migrar esses 4 eventos pra template aprovado da
// Meta (que passa a janela por definição) e só então voltar a bloquear texto
// livre fora da janela. Não reative o bloqueio no route.ts sem isso.

import { getMetaWindowInfo } from '@/lib/meta-window'

export const ERR_OUTSIDE_META_WINDOW = 'fora da janela de 24h, precisa de template aprovado'

// Quantos messageJobs 'pending' o executor processa por chamada do cron.
// Mantido em 50 (valor já em produção antes desta mudança) porque, combinado
// com o intervalo do cron em vercel.json (/api/cron a cada 5 min), dá um teto
// de 600 mensagens/hora — ver estimateMaxMessagesPerHour() abaixo.
export const MAX_JOBS_PER_RUN = 50

// Frequência do cron /api/cron em vercel.json. Mantida aqui como
// documentação viva: se um dos dois números mudar, atualize o outro e
// reconfira estimateMaxMessagesPerHour().
export const CRON_INTERVAL_MINUTES = 5

// Estimativa conservadora do teto de mensagens/hora do executor, assumindo
// pior caso (todo run bate o limite de MAX_JOBS_PER_RUN). Serve de checagem
// rápida contra o tier de mensageria da Meta (Tier 1 = 1.000 conversas
// únicas/24h) — o teto aqui é por MENSAGEM enviada, não por conversa única,
// então fica deliberadamente bem abaixo pra sobrar margem.
export function estimateMaxMessagesPerHour(
  maxJobsPerRun: number = MAX_JOBS_PER_RUN,
  cronIntervalMinutes: number = CRON_INTERVAL_MINUTES
): number {
  return maxJobsPerRun * (60 / cronIntervalMinutes)
}

export type MetaWindowCheck = { allowed: true } | { allowed: false; error: string }

// Decide se um job pode ser enviado como mensagem livre ou se está fora da
// janela de 24h (exige template aprovado). Job de template passa direto:
// a Meta aceita template fora da janela, é exatamente pra isso que ele existe.
export function checkMetaWindowForJob(params: {
  messageType?: string | null
  lastInboundAt: string | Date | null
}): MetaWindowCheck {
  const messageType = params.messageType ?? 'text'
  if (messageType === 'template') {
    return { allowed: true }
  }

  const lastInboundAt =
    params.lastInboundAt instanceof Date ? params.lastInboundAt.toISOString() : params.lastInboundAt

  const info = getMetaWindowInfo({ lastInboundAt })
  if (info.requiresTemplate) {
    return { allowed: false, error: ERR_OUTSIDE_META_WINDOW }
  }
  return { allowed: true }
}
