export type HealthStatus = 'active' | 'inactive' | 'degraded' | 'failing'
export type HealthSeverity = 'warning' | 'critical'

export type HealthFeature = {
  key: string
  label: string
  description: string
  critical: boolean
  kind: 'local' | 'remote' | 'configuration'
  configured: boolean
  disabled?: boolean
  required?: string[]
  configuredFields?: string[]
  url?: string
}

export type HealthSettings = {
  whatsappProvider?: string | null
  metaPhoneNumberId?: string | null
  metaAccessToken?: string | null
  uazapiBaseUrl?: string | null
  uazapiInstanceToken?: string | null
  instagramAccountId?: string | null
  instagramAccessToken?: string | null
  instagramPageId?: string | null
  brevoApiKey?: string | null
  brevoSenderEmail?: string | null
  hotmartEnabled?: boolean | null
  hotmartWebhookToken?: string | null
  hotmartClientId?: string | null
  hotmartClientSecret?: string | null
  greennEnabled?: boolean | null
  greennWebhookToken?: string | null
  greennPublicKey?: string | null
  greennApiKey?: string | null
  kiwifyEnabled?: boolean | null
  kiwifyWebhookToken?: string | null
  zoutiEnabled?: boolean | null
  zoutiWebhookToken?: string | null
  zoutiApiKey?: string | null
}

type Env = Record<string, string | undefined>

const value = (input: unknown) => typeof input === 'string' ? input.trim() : ''
const hasAny = (...inputs: unknown[]) => inputs.some(input => value(input).length > 0)
const hasAll = (...inputs: unknown[]) => inputs.every(input => value(input).length > 0)

function configuredDependency(
  key: string,
  label: string,
  description: string,
  critical: boolean,
  env: Env,
  urls: string[],
  tokens: string[],
): HealthFeature | null {
  const url = urls.map(name => value(env[name])).find(Boolean) || ''
  const hasToken = tokens.some(name => value(env[name]).length > 0)
  if (!url && !hasToken) return null
  return {
    key,
    label,
    description,
    critical,
    kind: 'remote',
    configured: Boolean(url && hasToken),
    configuredFields: [url ? 'URL' : '', hasToken ? 'credencial' : ''].filter(Boolean),
    required: ['URL', 'credencial'],
    url: url || undefined,
  }
}

export function buildHealthFeatures(
  settings: HealthSettings | null | undefined,
  env: Env = process.env,
  miningLeadCount = 0,
): HealthFeature[] {
  const current = settings ?? {}
  const features: HealthFeature[] = [
    {
      key: 'sac-session-api',
      label: 'Sessão e API do SAC',
      description: 'Sessão autenticada e endpoints do painel oficial.',
      critical: true,
      kind: 'local',
      configured: true,
    },
    {
      key: 'database',
      label: 'Banco de dados',
      description: 'Persistência tenant-bound do SAC.',
      critical: true,
      kind: 'local',
      configured: true,
    },
    {
      key: 'queue-worker',
      label: 'Fila e worker',
      description: 'Fila de saída e processamento assíncrono desta empresa.',
      critical: true,
      kind: 'local',
      configured: true,
    },
  ]

  const provider = value(current.whatsappProvider) || 'meta'
  if (provider === 'uazapi') {
    if (hasAny(current.uazapiBaseUrl, current.uazapiInstanceToken)) {
      features.push({
        key: 'channel-uazapi',
        label: 'WhatsApp via UazAPI',
        description: 'Transporte de mensagens WhatsApp configurado para esta empresa.',
        critical: true,
        kind: 'remote',
        configured: hasAll(current.uazapiBaseUrl, current.uazapiInstanceToken),
        configuredFields: [current.uazapiBaseUrl ? 'URL' : '', current.uazapiInstanceToken ? 'token' : ''].filter(Boolean),
        required: ['URL', 'token'],
        url: value(current.uazapiBaseUrl) || undefined,
      })
    }
  } else if (hasAny(current.metaPhoneNumberId, current.metaAccessToken)) {
    features.push({
      key: 'channel-whatsapp-official',
      label: 'API Oficial do WhatsApp',
      description: 'WhatsApp Cloud API da Meta, sem envio durante a checagem.',
      critical: true,
      kind: 'configuration',
      configured: hasAll(current.metaPhoneNumberId, current.metaAccessToken),
      configuredFields: [current.metaPhoneNumberId ? 'Phone Number ID' : '', current.metaAccessToken ? 'token' : ''].filter(Boolean),
      required: ['Phone Number ID', 'token'],
    })
  }

  if (hasAny(current.instagramAccountId, current.instagramAccessToken, current.instagramPageId)) {
    features.push({
      key: 'channel-instagram',
      label: 'Instagram',
      description: 'Instagram Direct e webhooks da conta configurada.',
      critical: true,
      kind: 'configuration',
      configured: hasAll(current.instagramAccountId, current.instagramAccessToken),
      configuredFields: [current.instagramAccountId ? 'Account ID' : '', current.instagramAccessToken ? 'token' : '', current.instagramPageId ? 'Page ID' : ''].filter(Boolean),
      required: ['Account ID', 'token'],
    })
  }

  const emailKey = hasAny(current.brevoApiKey, current.brevoSenderEmail, env.BREVO_API_KEY, env.EMAIL_SMTP_HOST)
  if (emailKey) {
    const usingBrevo = hasAny(current.brevoApiKey, env.BREVO_API_KEY)
    features.push({
      key: 'channel-email',
      label: 'E-mail',
      description: usingBrevo ? 'E-mail transacional pela Brevo.' : 'E-mail transacional configurado no ambiente.',
      critical: false,
      kind: 'configuration',
      configured: usingBrevo ? hasAll(current.brevoApiKey || env.BREVO_API_KEY, current.brevoSenderEmail || env.BREVO_FROM_EMAIL) : hasAll(env.EMAIL_SMTP_HOST, env.EMAIL_USERNAME, env.EMAIL_PASSWORD),
      configuredFields: [emailKey ? 'credenciais detectadas' : ''].filter(Boolean),
      required: usingBrevo ? ['API key', 'remetente'] : ['SMTP host', 'credenciais'],
    })
  }

  const checkouts: Array<{ key: string; label: string; enabled?: boolean | null; fields: unknown[]; required: unknown[] }> = [
    { key: 'checkout-hotmart', label: 'Hotmart', enabled: current.hotmartEnabled, fields: [current.hotmartWebhookToken, current.hotmartClientId, current.hotmartClientSecret], required: [current.hotmartWebhookToken] },
    { key: 'checkout-greenn', label: 'Greenn', enabled: current.greennEnabled, fields: [current.greennWebhookToken, current.greennPublicKey, current.greennApiKey], required: [current.greennWebhookToken] },
    { key: 'checkout-kiwify', label: 'Kiwify', enabled: current.kiwifyEnabled, fields: [current.kiwifyWebhookToken], required: [current.kiwifyWebhookToken] },
    { key: 'checkout-zouti', label: 'Zouti', enabled: current.zoutiEnabled, fields: [current.zoutiWebhookToken, current.zoutiApiKey], required: [current.zoutiWebhookToken] },
  ]
  for (const checkout of checkouts) {
    const explicitDisabled = checkout.enabled === false
    if (!explicitDisabled && !hasAny(...checkout.fields)) continue
    features.push({
      key: checkout.key,
      label: checkout.label,
      description: `Webhook e processamento de vendas ${checkout.label}.`,
      critical: true,
      kind: 'configuration',
      configured: !explicitDisabled && hasAll(...checkout.required),
      disabled: explicitDisabled,
      configuredFields: checkout.fields.map((field, index) => value(field) ? `credencial ${index + 1}` : '').filter(Boolean),
      required: ['token do webhook'],
    })
  }

  if (miningLeadCount > 0 || hasAny(env.MINING_API_URL, env.MINERACAO_API_URL)) {
    features.push({
      key: 'channel-mining',
      label: 'Mineração',
      description: 'Entrada de contatos da mineração usada por esta empresa.',
      critical: true,
      kind: 'configuration',
      configured: miningLeadCount > 0 || hasAny(env.MINING_API_URL, env.MINERACAO_API_URL),
      configuredFields: miningLeadCount > 0 ? [`${miningLeadCount} contato(s)`] : ['URL detectada'],
    })
  }

  const dependencyFeatures = [
    configuredDependency('whisper-local', 'Whisper local', 'Transcrição local de áudio, sem enviar mídia para terceiros.', true, env, ['WHISPER_URL', 'WHISPER_API_URL', 'TRANSCRIBER_URL'], ['WHISPER_TOKEN', 'TRANSCRIBER_TOKEN']),
    configuredDependency('deepseek-bridge', 'Ponte DeepSeek / IA', 'Ponte de IA configurada para o atendimento.', true, env, ['DEEPSEEK_URL', 'DEEPSEEK_API_URL', 'AI_BRIDGE_URL_DEEPSEEK', 'AI_BRIDGE_URL', 'AI_BRIDGE_URL_BELA'], ['DEEPSEEK_API_KEY', 'AI_BRIDGE_TOKEN_DEEPSEEK', 'AI_BRIDGE_TOKEN', 'AI_BRIDGE_TOKEN_BELA']),
    configuredDependency('codex-gateway', 'Gateway/orquestrador Codex', 'Gateway do orquestrador usado por esta instalação.', true, env, ['CODEX_GATEWAY_URL', 'CODEX_ORCHESTRATOR_URL', 'ORCHESTRATOR_URL'], ['CODEX_GATEWAY_TOKEN', 'CODEX_ORCHESTRATOR_TOKEN']),
    configuredDependency('results-callback', 'Callback de resultados', 'Retorno assíncrono de resultados para o SAC.', true, env, ['RESULT_CALLBACK_URL', 'SAC_CALLBACK_URL', 'CALLBACK_URL'], ['RESULT_CALLBACK_TOKEN', 'SAC_CALLBACK_TOKEN', 'CALLBACK_TOKEN']),
  ]
  features.push(...dependencyFeatures.filter((feature): feature is HealthFeature => feature !== null))

  return features
}

export function configurationStatus(feature: HealthFeature): { status: HealthStatus; reason: string } {
  if (feature.disabled) return { status: 'inactive', reason: 'Desativada nas configurações da empresa.' }
  if (feature.configured) return { status: 'active', reason: 'Configuração mínima encontrada.' }
  const found = feature.configuredFields?.join(', ')
  return {
    status: 'degraded',
    reason: found ? `Configuração incompleta. Encontrado: ${found}.` : 'Configuração ausente ou incompleta.',
  }
}

export type IncidentTransitionState = {
  isOpen: boolean
  nextAlertAt: Date | null
  alertSentAt: Date | null
}

export type IncidentTransition = 'opened' | 'reminded' | 'recovered' | 'unchanged'

/**
 * Regra pura usada como contrato do reconciliador persistente. Ela permite
 * simular uma falha e a recuperação sem tocar em banco, rede ou canal externo.
 */
export function healthIncidentTransition(
  state: IncidentTransitionState | null,
  input: { status: HealthStatus; critical: boolean },
  now: Date,
): IncidentTransition {
  if (input.status === 'failing' && input.critical) {
    if (!state || !state.isOpen) return 'opened'
    if (!state.nextAlertAt || state.nextAlertAt <= now) return 'reminded'
    return 'unchanged'
  }
  if (state?.isOpen) return 'recovered'
  return 'unchanged'
}
