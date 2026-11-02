export const INSTAGRAM_COMMENT_DM_TEMPLATE_ID = '021126'
export const INSTAGRAM_COMMENT_DM_TEMPLATE_VERSION = 1
export const INSTAGRAM_COMMENT_DM_TEMPLATE_KEYWORD = 'Luana'
export const INSTAGRAM_COMMENT_DM_TEMPLATE_URL =
  'https://www.casaldotrafego.com/blog/avaliar-assistente-ia-pedidos-de-clientes'

export const INSTAGRAM_COMMENT_DM_TEMPLATE_BODY = `Oi! Aqui está a página de avaliação sobre pedidos de clientes.

Ela mostra o que o vídeo explica, o que a empresa precisa ter pronto e traz 7 perguntas para você ver se essa rotina cabe no seu caso.

O assistente organiza o pedido e a sua equipe revisa antes de qualquer envio ao cliente. Se quiser conversar sobre a sua operação, é só responder por aqui.`

export const INSTAGRAM_COMMENT_DM_TEMPLATE_VARIABLES = ['url'] as const

export type InstagramCommentDmTemplateVariables = {
  url: typeof INSTAGRAM_COMMENT_DM_TEMPLATE_URL
}

export function renderInstagramCommentDmTemplate(
  variables: InstagramCommentDmTemplateVariables = { url: INSTAGRAM_COMMENT_DM_TEMPLATE_URL },
): string {
  if (variables.url !== INSTAGRAM_COMMENT_DM_TEMPLATE_URL) {
    throw new Error('A URL do template 021126 não pode ser alterada.')
  }
  return `${INSTAGRAM_COMMENT_DM_TEMPLATE_BODY}\n\n${variables.url}`
}

export const INSTAGRAM_COMMENT_DM_TEMPLATE = {
  id: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
  version: INSTAGRAM_COMMENT_DM_TEMPLATE_VERSION,
  variables: INSTAGRAM_COMMENT_DM_TEMPLATE_VARIABLES,
  body: INSTAGRAM_COMMENT_DM_TEMPLATE_BODY,
  url: INSTAGRAM_COMMENT_DM_TEMPLATE_URL,
  channel: 'instagram_direct' as const,
  apiOrigin: 'instagram_graph' as const,
  graphHost: 'graph.instagram.com' as const,
  accountIdField: 'instagramAccountId' as const,
  accessTokenField: 'instagramAccessToken' as const,
  pageIdField: null,
  publicReply: null,
  consent: {
    required: true,
    basis: 'official_instagram_comment_event' as const,
    followUpRequiresUserReply: true,
  },
  metaPrivateReplyWindowHours: 7 * 24,
}

export function buildInstagramCommentDmTemplateRegistration(options?: {
  mediaId?: string | null
  isActive?: boolean
}) {
  const mediaId = options?.mediaId?.trim() || null
  const isActive = options?.isActive ?? false
  if (isActive && !mediaId) {
    throw new Error('O template 021126 só pode ser ativado depois que o mediaId real for identificado.')
  }

  return {
    name: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
    templateId: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
    templateVariables: { url: INSTAGRAM_COMMENT_DM_TEMPLATE_URL },
    mediaId,
    keywords: INSTAGRAM_COMMENT_DM_TEMPLATE_KEYWORD,
    matchType: 'contains' as const,
    dmMessage: renderInstagramCommentDmTemplate(),
    publicReply: null,
    hideCommentAfterReply: false,
    isActive,
    consentRequired: true,
    metaWindowHours: INSTAGRAM_COMMENT_DM_TEMPLATE.metaPrivateReplyWindowHours,
    apiOrigin: INSTAGRAM_COMMENT_DM_TEMPLATE.apiOrigin,
  }
}
