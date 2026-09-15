interface UazApiConfig {
  baseUrl: string
  instanceToken: string
}

export interface ButtonOption {
  id: string
  label: string
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

function base(config: UazApiConfig): string {
  return config.baseUrl.replace(/\/$/, '')
}

export async function sendUazApiText(config: UazApiConfig, phone: string, text: string): Promise<void> {
  const res = await fetch(`${base(config)}/message/sendText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: config.instanceToken },
    body: JSON.stringify({ number: normalizePhone(phone), text }),
  })
  if (!res.ok) throw new Error(`UazAPI sendText erro ${res.status}`)
}

export async function sendUazApiMedia(
  config: UazApiConfig,
  phone: string,
  mediaUrl: string,
  mediaType: string,
  caption?: string
): Promise<void> {
  const res = await fetch(`${base(config)}/message/sendMedia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: config.instanceToken },
    body: JSON.stringify({ number: normalizePhone(phone), mediaUrl, mediaType, caption }),
  })
  if (!res.ok) throw new Error(`UazAPI sendMedia erro ${res.status}`)
}

export async function sendUazApiButtons(
  config: UazApiConfig,
  phone: string,
  text: string,
  buttons: ButtonOption[]
): Promise<void> {
  const res = await fetch(`${base(config)}/message/sendButtons`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: config.instanceToken },
    body: JSON.stringify({
      number: normalizePhone(phone),
      text,
      buttons: buttons.slice(0, 3).map(btn => ({ id: btn.id, text: btn.label })),
    }),
  })
  if (!res.ok) throw new Error(`UazAPI sendButtons erro ${res.status}`)
}
