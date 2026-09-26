/**
 * Ponte com a rota da Luana que avisa a Nina (bot Hermes/AutonomIA) pra parar
 * de responder um contato FORA do SAC: webhook direto da Meta, follow-up e disparo diário.
 */

const DEFAULT_NAO_RESPONDER_URL = 'https://hermes.casaldotrafego.com/autonomia/gerar-resposta/nao-responder'
const REQUEST_TIMEOUT_MS = 5000

export const NAO_RESPONDER_WARNING =
  'tag salva, mas o aviso ao atendimento automático da Nina (webhook direto/follow-up/disparo) ainda não foi confirmado — avise manualmente se for urgente'

export const NAO_RESPONDER_WARNING_INVALID_CONTACT =
  'tag salva, mas este lead não é um contato de WhatsApp válido (canal diferente ou telefone fora do formato esperado) — não dá pra avisar a Nina automaticamente, avise manualmente se for urgente'

export type NaoResponderAcao = 'marcar' | 'desmarcar' | 'pause' | 'unpause'

export interface NaoResponderResult {
  ok: boolean
  warning?: string
}

export interface NotifyNaoResponderParams {
  phone: string
  action?: 'pause' | 'unpause' | 'marcar' | 'desmarcar'
  acao?: NaoResponderAcao
  reason?: string
  companySlug?: string
  channel?: string
}

const BRAZIL_WHATSAPP_PHONE_REGEX = /^55\d{2}9\d{8}$/

export function isValidBrazilianWhatsappContact(channel: string | null | undefined, phone: string | null | undefined): boolean {
  if (channel && channel !== 'whatsapp') return false
  const digits = (phone || '').replace(/\D/g, '')
  return BRAZIL_WHATSAPP_PHONE_REGEX.test(digits) || digits.length >= 10
}

export async function notifyNaoResponder(
  phoneOrParams: string | NotifyNaoResponderParams,
  acaoOrAction?: NaoResponderAcao | string,
  channelOrReason?: string
): Promise<NaoResponderResult> {
  let phone = ''
  let acao: NaoResponderAcao = 'marcar'
  let channel: string | undefined = 'whatsapp'

  if (typeof phoneOrParams === 'object' && phoneOrParams !== null) {
    phone = phoneOrParams.phone
    const act = phoneOrParams.action || phoneOrParams.acao || 'pause'
    acao = (act === 'pause' || act === 'marcar') ? 'marcar' : 'desmarcar'
    channel = phoneOrParams.channel
  } else {
    phone = phoneOrParams || ''
    const act = acaoOrAction || 'marcar'
    acao = (act === 'pause' || act === 'marcar') ? 'marcar' : 'desmarcar'
    channel = channelOrReason || 'whatsapp'
  }

  const url = process.env.NAO_RESPONDER_URL || process.env.NINA_BRIDGE_URL || DEFAULT_NAO_RESPONDER_URL
  const token = process.env.NAO_RESPONDER_TOKEN || process.env.NINA_BRIDGE_TOKEN

  if (!token) {
    console.warn(`[nao-responder] NAO_RESPONDER_TOKEN ausente, pulando aviso à Nina (acao=${acao})`)
    return { ok: false, warning: NAO_RESPONDER_WARNING }
  }

  const telefone = phone.replace(/\D/g, '')

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ telefone, acao, motivo: 'pessoa' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      console.warn(`[nao-responder] Ponte externa respondeu status ${res.status} para ${phone} (acao=${acao})`)
      return { ok: false, warning: NAO_RESPONDER_WARNING }
    }

    console.log(`[nao-responder] Ponte externa notificada com sucesso: ${phone} (${acao})`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[nao-responder] Falha ao notificar ponte externa para ${phone}: ${message}`)
    return { ok: false, warning: NAO_RESPONDER_WARNING }
  }
}
