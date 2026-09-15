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

// Garante formato E.164 para números brasileiros (adiciona nono dígito se necessário)
export function formatBrazilianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''

  // Já tem DDI
  if (digits.startsWith('55')) {
    const local = digits.slice(2)
    if (local.length === 11) return digits                              // completo
    if (local.length === 10) return '55' + local.slice(0, 2) + '9' + local.slice(2) // falta nono dígito
    return digits
  }

  // DDI de outro país (não começa com 55): retorna como veio
  if (digits.length > 11) return digits

  // Número local brasileiro
  if (digits.length === 11) return '55' + digits                         // DDD+9+8
  if (digits.length === 10) return '55' + digits.slice(0, 2) + '9' + digits.slice(2) // DDD+8, adiciona 9
  return '55' + digits
}

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

    if (message.type === 'interactive_buttons' && message.buttons?.length) {
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
