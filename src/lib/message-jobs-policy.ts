// Política de envio do executor de messageJobs (src/app/api/cron/route.ts).
// A janela de atendimento continua controlando texto livre: fora dela, a Meta
// aceita somente um template aprovado. Template aprovado pode ser entregue a
// qualquer hora, mas continua sujeito à cobrança e às regras de qualidade da
// Meta. O limite de jobs por execução é uma proteção técnica separada.

import { getMetaWindowInfo } from '@/lib/meta-window'

export const ERR_OUTSIDE_META_WINDOW = 'fora da janela de 24h, precisa de template aprovado'
export const ERR_TEMPLATE_NAME_REQUIRED = 'mensagem marcada como template sem nome de template aprovado'

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

// Um template só passa sem janela quando tem nome. Sem nome, o adaptador pode
// acabar enviando texto livre ou considerar o job enviado sem chamar a Meta.
export function checkMetaWindowForJob(params: {
  messageType?: string | null
  templateName?: string | null
  lastInboundAt: string | Date | null
}): MetaWindowCheck {
  const messageType = params.messageType ?? 'text'
  if (messageType === 'template') {
    return params.templateName?.trim()
      ? { allowed: true }
      : { allowed: false, error: ERR_TEMPLATE_NAME_REQUIRED }
  }

  const lastInboundAt =
    params.lastInboundAt instanceof Date ? params.lastInboundAt.toISOString() : params.lastInboundAt

  const info = getMetaWindowInfo({ lastInboundAt })
  if (info.requiresTemplate) {
    return { allowed: false, error: ERR_OUTSIDE_META_WINDOW }
  }
  return { allowed: true }
}

// Espaçamento padrão por segundo entre disparos consecutivos dentro da mesma rodada do cron.
// Evita rajadas de dezenas de mensagens no mesmo segundo para a Graph API da Meta.
export const DEFAULT_DISPATCH_SPACING = {
  minSeconds: 1,
  maxSeconds: 2,
}

export function calculateDispatchSpacingMs(
  spacing: { minSeconds: number; maxSeconds: number } = DEFAULT_DISPATCH_SPACING,
  randomFn: () => number = Math.random,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): number {
  if (env.NODE_ENV === 'test' || env.SKIP_DISPATCH_SPACING === '1') {
    return 0
  }
  const min = Math.max(0, spacing.minSeconds)
  const max = Math.max(min, spacing.maxSeconds)
  const seconds = min + randomFn() * (max - min)
  return Math.round(seconds * 1000)
}
