import type { InboxPage } from '@/lib/inbox-conversations'

export type InboxClientErrorCode =
  | 'unauthorized'
  | 'timeout'
  | 'invalid-response'
  | 'request-failed'

export class InboxClientError extends Error {
  readonly code: InboxClientErrorCode

  constructor(code: InboxClientErrorCode, message: string) {
    super(message)
    this.name = 'InboxClientError'
    this.code = code
  }
}

function responsePath(response: Response): string | null {
  try {
    return response.url ? new URL(response.url).pathname : null
  } catch {
    return null
  }
}

export async function readInboxResponse(response: Response): Promise<InboxPage> {
  const path = responsePath(response)
  if (path === '/handler/sign-in' || response.type === 'opaqueredirect') {
    throw new InboxClientError(
      'unauthorized',
      'Sua sessão expirou ou não está autenticada. Entre novamente para carregar as conversas.',
    )
  }

  if (response.status === 401) {
    throw new InboxClientError(
      'unauthorized',
      'Sua sessão expirou ou não está autenticada. Entre novamente para carregar as conversas.',
    )
  }

  if (!response.ok) {
    throw new InboxClientError('request-failed', `O servidor não conseguiu carregar as conversas (HTTP ${response.status}).`)
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) {
    throw new InboxClientError(
      'invalid-response',
      'O servidor devolveu uma resposta inválida para a lista de conversas. Tente novamente.',
    )
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new InboxClientError(
      'invalid-response',
      'O servidor devolveu um JSON inválido para a lista de conversas. Tente novamente.',
    )
  }

  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { conversations?: unknown }).conversations) ||
    typeof (data as { hasMore?: unknown }).hasMore !== 'boolean'
  ) {
    throw new InboxClientError(
      'invalid-response',
      'O servidor devolveu dados incompletos para a lista de conversas. Tente novamente.',
    )
  }

  return data as InboxPage
}

export function inboxClientErrorMessage(error: unknown): string {
  if (error instanceof InboxClientError) return error.message
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'O carregamento das conversas demorou mais de 12 segundos. Tente novamente.'
  }
  return 'Falha de rede ao buscar conversas. Tente novamente.'
}
