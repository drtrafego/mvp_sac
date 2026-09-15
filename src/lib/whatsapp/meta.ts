interface MetaConfig {
  phoneNumberId: string
  accessToken: string
}

export interface ButtonOption {
  id: string
  label: string
}

export interface MetaTemplate {
  name: string
  status: string
  language: string
  category: string
  components: unknown[]
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

async function metaPost(config: MetaConfig, body: unknown): Promise<string | null> {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Meta API erro ${res.status}: ${err}`)
  }
  const data = await res.json() as { messages?: { id: string }[] }
  return data.messages?.[0]?.id ?? null
}

export async function sendMetaText(config: MetaConfig, phone: string, text: string): Promise<string | null> {
  return metaPost(config, {
    messaging_product: 'whatsapp',
    to: normalizePhone(phone),
    type: 'text',
    text: { body: text },
  })
}

export async function sendMetaMedia(
  config: MetaConfig,
  phone: string,
  mediaType: string,
  mediaUrl: string,
  caption?: string
): Promise<string | null> {
  const typeKey = mediaType === 'image' ? 'image'
    : mediaType === 'video' ? 'video'
    : mediaType === 'audio' ? 'audio'
    : 'document'

  return metaPost(config, {
    messaging_product: 'whatsapp',
    to: normalizePhone(phone),
    type: typeKey,
    [typeKey]: { link: mediaUrl, ...(caption ? { caption } : {}) },
  })
}

export async function sendMetaInteractiveButtons(
  config: MetaConfig,
  phone: string,
  bodyText: string,
  buttons: ButtonOption[]
): Promise<string | null> {
  return metaPost(config, {
    messaging_product: 'whatsapp',
    to: normalizePhone(phone),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map(btn => ({
          type: 'reply',
          reply: { id: btn.id.slice(0, 256), title: btn.label.slice(0, 20) },
        })),
      },
    },
  })
}

// Envia template aprovado pela Meta (necessário para contatos frios / fora da janela 24h)
export async function sendMetaTemplate(
  config: MetaConfig,
  phone: string,
  templateName: string,
  languageCode: string,
  variableValues: string[]  // valores interpolados em ordem: [valor_{{1}}, valor_{{2}}, ...]
): Promise<string | null> {
  const parameters = variableValues.map(v => ({ type: 'text', text: v }))
  const components = parameters.length > 0
    ? [{ type: 'body', parameters }]
    : []

  return metaPost(config, {
    messaging_product: 'whatsapp',
    to: normalizePhone(phone),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'pt_BR' },
      ...(components.length > 0 ? { components } : {}),
    },
  })
}

// Lista templates aprovados do WABA
export async function listMetaTemplates(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=name,status,language,category,components&limit=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Meta API erro ${res.status}: ${err}`)
  }
  const data = await res.json() as { data?: MetaTemplate[] }
  return (data.data ?? []).filter(t => t.status === 'APPROVED')
}
