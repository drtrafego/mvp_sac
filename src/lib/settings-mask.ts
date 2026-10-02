/**
 * Mascara valor de segredo (token/API key) para resposta GET, mostrando só
 * os 4 últimos caracteres. Usado tanto no painel humano
 * (src/app/api/settings/route.ts) quanto na API de agentes
 * (src/app/api/v1/companies/[idOrSlug]/settings/route.ts), pra nenhuma rota
 * devolver segredo em texto plano.
 */
export function mask(val: string | null | undefined): string {
  if (!val) return ''
  if (val.length <= 4) return '****'
  return '****' + val.slice(-4)
}

/**
 * Lista única dos campos de settings que são credencial (token/senha/chave/
 * connection string), nunca conteúdo público (ID, nome, config). Toda rota
 * que serializa uma linha de `settings` como resposta JSON passa por
 * `maskSettingsRow()` abaixo, pra nenhum campo novo nascer exposto por
 * esquecimento de alguém copiar a lista manualmente numa rota nova.
 *
 * Achado de auditoria (26/09/2026): supabaseDatabaseUrl, agentBiaApiKey,
 * agentLuanaApiKey, agentRenatoApiKey e agentPublicadorApiKey vazavam em claro
 * no GET humano e no GET/PATCH v1 porque essas rotas espalhavam `...row` inteiro e só
 * sobrescreviam uma lista manual de campos (que nunca incluía esses 4).
 * instagramAppSecret vazava só na rota v1 pelo mesmo motivo.
 *
 * `metaVerifyToken` e `instagramVerifyToken` ficam de FORA desta lista de
 * propósito: são valores de challenge-response do handshake de assinatura
 * de webhook (a Meta ecoa de volta pra confirmar posse do endpoint), não
 * dão acesso de leitura/escrita a nenhuma API sozinhos, e o cliente
 * costuma precisar reler o próprio valor pra conferir contra o que
 * cadastrou na Meta. Revisado por QA em 26/09/2026, risco considerado
 * bem menor que os campos acima; não é esquecimento.
 */
const SETTINGS_SECRET_FIELDS = [
  'hotmartWebhookToken',
  'hotmartClientSecret',
  'greennWebhookToken',
  'greennApiKey',
  'zoutiWebhookToken',
  'zoutiApiKey',
  'kiwifyWebhookToken',
  'metaAccessToken',
  'metaAppSecret',
  'metaAdsAccessToken',
  'uazapiInstanceToken',
  'brevoApiKey',
  'instagramAccessToken',
  'instagramAppSecret',
  'supabaseDatabaseUrl',
  'agentBiaApiKey',
  'agentLuanaApiKey',
  'agentRenatoApiKey',
  'agentPublicadorApiKey',
] as const

/**
 * Devolve uma cópia da linha de `settings` com todo campo de credencial
 * mascarado (só os 4 últimos caracteres, ou '' se vazio). Mantém os demais
 * campos (IDs públicos, config, timestamps) intactos. Usar em toda resposta
 * JSON que carregar uma linha de `settings`, seja GET, PUT ou PATCH: o campo
 * mascarado continua GRAVÁVEL normalmente (a máscara só entra na LEITURA de
 * volta, nunca na escrita).
 */
export function maskSettingsRow<T extends Record<string, unknown>>(row: T): T {
  const masked = { ...row }
  for (const field of SETTINGS_SECRET_FIELDS) {
    if (field in masked) {
      ;(masked as Record<string, unknown>)[field] = mask(masked[field] as string | null | undefined)
    }
  }
  return masked
}

const SETTINGS_SECRET_FIELD_SET: ReadonlySet<string> = new Set(SETTINGS_SECRET_FIELDS)

function isMaskedPlaceholderOrEmpty(val: unknown): boolean {
  return typeof val !== 'string' || val.length === 0 || val.startsWith('****')
}

/**
 * Decide se um campo vindo do body de um PUT/PATCH deve realmente ser
 * gravado, pra uma rota que monta o update varrendo uma allowlist de chaves
 * (ex.: PATCH v1) não precisar de um resolveSecret() campo a campo manual.
 *
 * Achado de QA (26/09/2026): ao mascarar o GET de
 * src/app/api/v1/companies/[idOrSlug]/settings/route.ts, um caller que faz
 * round-trip GET -> PATCH sem filtrar os campos mascarados passou a gravar
 * o placeholder "****xxxx" por cima da credencial real (regressão de
 * escrita introduzida pelo próprio fix de vazamento de leitura). Vale pra
 * TODO campo que é credencial (está em SETTINGS_SECRET_FIELDS) e também é
 * gravável por essa rota: agentBiaApiKey/agentLuanaApiKey/agentRenatoApiKey/
 * agentPublicadorApiKey
 * (os bearer tokens que autenticam os próprios agentes nesta API, ver
 * src/lib/agent-auth.ts) são o caso mais grave, mas o mesmo risco já
 * existia sem correção nenhuma para metaAccessToken, metaAdsAccessToken,
 * uazapiInstanceToken, brevoApiKey, instagramAccessToken,
 * hotmartWebhookToken, kiwifyWebhookToken, greennWebhookToken e
 * zoutiWebhookToken (todos mascarados no GET, todos na allowlist de PATCH,
 * nenhum protegido antes desta função).
 *
 * Mesma regra de src/app/api/settings/route.ts (resolveSecret): campo de
 * credencial com valor vazio ou começando em "****" é ignorado (mantém o
 * que já está no banco); qualquer outro campo passa direto, igual sempre
 * passou.
 */
export function shouldWriteSettingsField(key: string, value: unknown): boolean {
  if (value === undefined) return false
  if (SETTINGS_SECRET_FIELD_SET.has(key) && isMaskedPlaceholderOrEmpty(value)) return false
  return true
}
