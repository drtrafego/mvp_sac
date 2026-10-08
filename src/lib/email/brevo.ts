import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export interface SendEmailOptions {
  to: { email: string; name?: string }[]
  subject: string
  htmlContent: string
  textContent?: string
  replyTo?: { email: string; name?: string }
  companyId?: number
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
  companyId,
}: SendEmailOptions): Promise<{ ok: boolean; data?: { messageId?: string }; error?: string; uncertain?: boolean; isTimeout?: boolean }> {
  let apiKey = process.env.BREVO_API_KEY
  let senderEmail = process.env.BREVO_FROM_EMAIL || 'contato@casaldotrafego.com.br'
  let senderName = process.env.BREVO_FROM_NAME || 'SAC Casal do Tráfego'

  if (companyId) {
    const [companySetting] = await db
      .select({
        brevoApiKey: settings.brevoApiKey,
        brevoSenderEmail: settings.brevoSenderEmail,
        brevoSenderName: settings.brevoSenderName,
      })
      .from(settings)
      .where(eq(settings.companyId, companyId))

    if (companySetting?.brevoApiKey) apiKey = companySetting.brevoApiKey
    if (companySetting?.brevoSenderEmail) senderEmail = companySetting.brevoSenderEmail
    if (companySetting?.brevoSenderName) senderName = companySetting.brevoSenderName
  }

  if (!apiKey) {
    console.warn('[Brevo] Chave de API da Brevo não configurada')
    return { ok: false, error: 'BREVO_API_KEY_NOT_CONFIGURED' }
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
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
      const message = errorPayload && typeof errorPayload.message === 'string' ? errorPayload.message : `Brevo HTTP ${res.status}`
      return { ok: false, error: message }
    }

    const data = await res.json()
    return { ok: true, data }
  } catch (error) {
    const value = error as { name?: string }
    return { ok: false, error: error instanceof Error ? error.message : String(error), uncertain: true, isTimeout: value?.name === 'TimeoutError' || value?.name === 'AbortError' }
  }
}
