/**
 * Ponte com a rota da Luana que avisa a Nina (bot Hermes/AutonomIA) pra parar
 * de responder um contato FORA do SAC: webhook direto da Meta (Nina responde
 * sem passar pelo SAC), follow-up (followup_nina.py) e disparo diário
 * (minerador_dispatch.py). recoveryLeads.botPaused já cobre 100% do fluxo
 * síncrono via SAC (ver generateAndSendAiReply em src/lib/ai-reply.ts), mas
 * não alcança esses três caminhos.
 *
 * Endpoint ainda em QA do lado da Luana no momento em que isto foi escrito
 * (25/09/2026) — pode não estar no ar. Por isso esta função NUNCA lança:
 * qualquer falha (rede, timeout, token ausente, status != 200) só loga com
 * contexto e devolve { ok: false, warning }, pro chamador (a rota de tags)
 * salvar a tag/pausa mesmo assim e devolver o aviso pro operador no painel.
 *
 * NUNCA logar o token.
 */

const NAO_RESPONDER_URL = 'https://hermes.casaldotrafego.com/autonomia/gerar-resposta/nao-responder'
const REQUEST_TIMEOUT_MS = 5000

export const NAO_RESPONDER_WARNING =
  'tag salva, mas o aviso ao atendimento automático da Nina (webhook direto/follow-up/disparo) ainda não foi confirmado — avise manualmente se for urgente'

export const NAO_RESPONDER_WARNING_INVALID_CONTACT =
  'tag salva, mas este lead não é um contato de WhatsApp válido (canal diferente ou telefone fora do formato esperado) — não dá pra avisar a Nina automaticamente, avise manualmente se for urgente'

export type NaoResponderAcao = 'marcar' | 'desmarcar'

export interface NaoResponderResult {
  ok: boolean
  warning?: string
}

/**
 * Formato EXATO que formatBrazilianPhone()/formatPhone() produzem para um
 * WhatsApp brasileiro legítimo (src/lib/whatsapp/index.ts e
 * src/app/api/webhooks/hotmart/[slug]/route.ts): 55 + DDD (2) + 9 + 8
 * dígitos = 13 dígitos.
 *
 * ‼️ QA (25/09/2026, CRÍTICO): a validação antiga só contava dígitos
 * (12 ou 13) e concatenava "55" na frente cegamente quando não começava com
 * 55. Isso fabricava telefone BRASILEIRO FALSO pra qualquer DDI de 1 dígito
 * + 10 dígitos locais (ex.: EUA/Canadá, DDI "1"), mandando um contato errado
 * pra rota da Luana sem nenhum aviso. Também não distinguia canal: leads de
 * Instagram gravam phone = `ig_<id>` (não é telefone) e só não quebravam
 * antes por coincidência de tamanho. Correção: exigir channel === 'whatsapp'
 * E o formato exato acima, nunca inferir DDI por contagem de dígitos.
 */
const BRAZIL_WHATSAPP_PHONE_REGEX = /^55\d{2}9\d{8}$/

/** true só quando dá pra confiar que é um WhatsApp brasileiro legítimo
 * (mesmo formato que formatBrazilianPhone()/formatPhone() produzem). */
export function isValidBrazilianWhatsappContact(channel: string | null | undefined, phone: string | null | undefined): boolean {
  if (channel !== 'whatsapp') return false
  const digits = (phone || '').replace(/\D/g, '')
  return BRAZIL_WHATSAPP_PHONE_REGEX.test(digits)
}

export async function notifyNaoResponder(
  phone: string | null | undefined,
  acao: NaoResponderAcao,
  channel: string | null | undefined,
): Promise<NaoResponderResult> {
  if (!isValidBrazilianWhatsappContact(channel, phone)) {
    console.error(
      `[nao-responder] canal=${channel ?? 'desconhecido'} telefone fora do formato esperado de WhatsApp BR, ` +
        `pulando aviso à Nina (acao=${acao})`,
    )
    return { ok: false, warning: NAO_RESPONDER_WARNING_INVALID_CONTACT }
  }
  const telefone = (phone || '').replace(/\D/g, '')

  const token = process.env.NAO_RESPONDER_TOKEN
  if (!token) {
    console.error(`[nao-responder] NAO_RESPONDER_TOKEN ausente, pulando aviso à Nina (acao=${acao})`)
    return { ok: false, warning: NAO_RESPONDER_WARNING }
  }

  try {
    const res = await fetch(NAO_RESPONDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ telefone, acao, motivo: 'pessoa' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[nao-responder] rota da Luana respondeu ${res.status} (acao=${acao})`)
      return { ok: false, warning: NAO_RESPONDER_WARNING }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[nao-responder] falha ao chamar a rota da Luana (acao=${acao}): ${message}`)
    return { ok: false, warning: NAO_RESPONDER_WARNING }
  }
}
