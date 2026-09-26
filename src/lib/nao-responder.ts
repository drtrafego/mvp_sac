/**
 * Notificador de pausa/despausa externa da Nina (Ponte AutonomIA).
 * Quando a tag "pessoa" é aplicada ou removida de um lead, este módulo notifica
 * a ponte externa para sincronizar o bloqueio/liberação do bot de IA.
 */

export interface NotifyNaoResponderParams {
  phone: string
  action: 'pause' | 'unpause'
  reason?: string
  companySlug?: string
  channel?: string
}

export async function notifyNaoResponder(params: NotifyNaoResponderParams): Promise<boolean> {
  const url = process.env.NAO_RESPONDER_URL || process.env.NINA_BRIDGE_URL
  const token = process.env.NAO_RESPONDER_TOKEN || process.env.NINA_BRIDGE_TOKEN

  if (!url) {
    console.log(`[nao-responder] NAO_RESPONDER_URL não configurado. Notificação ignorada para ${params.phone} (action=${params.action}).`)
    return false
  }

  try {
    const payload = {
      phone: params.phone,
      action: params.action,
      reason: params.reason || `Tag pessoa ${params.action === 'pause' ? 'adicionada' : 'removida'}`,
      companySlug: params.companySlug || 'autonomia',
      channel: params.channel || 'whatsapp',
      timestamp: new Date().toISOString(),
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      console.warn(`[nao-responder] Ponte externa respondeu com status ${res.status} para ${params.phone}`)
      return false
    }

    console.log(`[nao-responder] Ponte externa notificada com sucesso: ${params.phone} (${params.action})`)
    return true
  } catch (err) {
    console.error(`[nao-responder] Erro ao notificar ponte externa para ${params.phone}:`, err)
    return false
  }
}
