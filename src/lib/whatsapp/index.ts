import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { sendMetaText, sendMetaMedia, sendMetaInteractiveButtons, sendMetaTemplate } from './meta'
import { sendUazApiText, sendUazApiMedia, sendUazApiButtons } from './uazapi'

export interface ButtonOption {
  id: string
  label: string
}

interface MessagePayload {
  type: string
  content?: string
  mediaUrl?: string
  caption?: string
  buttons?: ButtonOption[]
  // template fields
  templateName?: string
  templateLanguage?: string
  templateVariableValues?: string[]  // valores interpolados em ordem posicional
}

import { formatBrazilianPhone } from '@/lib/phone'
export { formatBrazilianPhone }

// Retorna o WAMID (apenas Meta retorna; UazAPI retorna null)
export async function sendWhatsAppMessage(
  phone: string,
  message: MessagePayload,
  companyId: number
): Promise<string | null> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  if (!config) throw new Error('WhatsApp não configurado para esta empresa')

  const normalized = formatBrazilianPhone(phone)
  const provider = config.whatsappProvider ?? 'meta'

  if (provider === 'meta') {
    if (!config.metaPhoneNumberId || !config.metaAccessToken) {
      throw new Error('Meta Cloud API não configurada')
    }
    const metaConfig = { phoneNumberId: config.metaPhoneNumberId, accessToken: config.metaAccessToken }

    if (message.type === 'template' && !message.templateName?.trim()) {
      throw new Error('Template Meta sem nome aprovado')
    }

    if (message.type === 'template' && message.templateName) {
      return sendMetaTemplate(
        metaConfig,
        normalized,
        message.templateName,
        message.templateLanguage ?? 'pt_BR',
        message.templateVariableValues ?? []
      )
    } else if (message.type === 'interactive_buttons' && message.buttons?.length) {
      return sendMetaInteractiveButtons(metaConfig, normalized, message.content ?? '', message.buttons)
    } else if (message.type === 'text' && message.content) {
      return sendMetaText(metaConfig, normalized, message.content)
    } else if (message.mediaUrl) {
      return sendMetaMedia(metaConfig, normalized, message.type, message.mediaUrl, message.caption)
    }
    return null

  } else if (provider === 'uazapi') {
    if (!config.uazapiBaseUrl || !config.uazapiInstanceToken) {
      throw new Error('UazAPI não configurada')
    }
    const uazConfig = { baseUrl: config.uazapiBaseUrl, instanceToken: config.uazapiInstanceToken }

    if (message.type === 'template') {
      throw new Error('Templates Meta não são suportados pelo provedor UazAPI')
    } else if (message.type === 'interactive_buttons' && message.buttons?.length) {
      await sendUazApiButtons(uazConfig, normalized, message.content ?? '', message.buttons)
    } else if (message.type === 'text' && message.content) {
      await sendUazApiText(uazConfig, normalized, message.content)
    } else if (message.mediaUrl) {
      await sendUazApiMedia(uazConfig, normalized, message.mediaUrl, message.type, message.caption)
    }
    return null

  } else {
    throw new Error(`Provedor desconhecido: ${provider}`)
  }
}
