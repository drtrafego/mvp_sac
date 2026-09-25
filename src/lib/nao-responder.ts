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

export type NaoResponderAcao = 'marcar' | 'desmarcar'

export interface NaoResponderResult {
  ok: boolean
  warning?: string
}

/** Só dígitos, com DDI 55 na frente (mesmo formato documentado no contrato
 * do webhook de conversão do Hermes, src/app/api/webhooks/hermes/[slug]/conversion/route.ts,
 * e confirmado por um lead real em produção no comentário de
 * src/lib/inbox-channel-filter.ts:434). Retorna null se sobrarem poucos
 * dígitos pra ser um telefone válido (não vale a pena nem tentar a chamada). */
export function normalizePhoneWithCountryCode(phone: string | null | undefined): string | null {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return null
  const comDdi = digits.startsWith('55') ? digits : `55${digits}`
  if (comDdi.length < 12 || comDdi.length > 13) return null
  return comDdi
}

export async function notifyNaoResponder(phone: string | null | undefined, acao: NaoResponderAcao): Promise<NaoResponderResult> {
  const telefone = normalizePhoneWithCountryCode(phone)
  if (!telefone) {
    console.error(`[nao-responder] telefone inválido pra normalizar (acao=${acao}), pulando aviso à Nina`)
    return { ok: false, warning: NAO_RESPONDER_WARNING }
  }

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
