export interface SendEmailOptions {
  to: { email: string; name?: string }[]
  subject: string
  htmlContent: string
  textContent?: string
  replyTo?: { email: string; name?: string }
}

/**
 * Envia e-mails transacionais utilizando a API oficial da Brevo (Sendinblue).
 */
export async function sendBrevoEmail({
  to,
  subject,
  htmlContent,
  textContent,
  replyTo,
}: SendEmailOptions) {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey) {
    console.warn('[Brevo] BREVO_API_KEY não configurada nas variáveis de ambiente')
    return { ok: false, error: 'BREVO_API_KEY_NOT_CONFIGURED' }
  }

  const senderEmail = process.env.BREVO_FROM_EMAIL || 'contato@casaldotrafego.com'
  const senderName = process.env.BREVO_FROM_NAME || 'SAC Casal do Tráfego'

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to,
        subject,
        htmlContent,
        ...(textContent ? { textContent } : {}),
        ...(replyTo ? { replyTo } : {}),
      }),
    })

    if (!res.ok) {
      const errorPayload = await res.json().catch(() => null)
      console.error('[Brevo Error]:', errorPayload)
      return { ok: false, error: errorPayload }
    }

    const data = await res.json()
    return { ok: true, data }
  } catch (error) {
    console.error('[Brevo Exception]:', error)
    return { ok: false, error }
  }
}
