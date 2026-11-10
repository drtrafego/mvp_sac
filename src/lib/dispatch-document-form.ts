import {
  isSafeHeaderDocumentFilename,
  isSafeHeaderDocumentLink,
} from '@/lib/validations/mass-dispatch'

export type TemplateHeaderDocumentInput = {
  link: string
  filename: string
}

export type TemplateHeaderDocumentValidation = {
  isValid: boolean
  value?: TemplateHeaderDocumentInput
  linkError: string | null
  filenameError: string | null
}

/**
 * Normaliza e valida o documento obrigatório de um HEADER DOCUMENT antes de
 * uma seleção de template poder seguir para as rotas de disparo.
 */
export function validateTemplateHeaderDocument(
  document: TemplateHeaderDocumentInput,
  required: boolean,
): TemplateHeaderDocumentValidation {
  if (!required) {
    return { isValid: true, linkError: null, filenameError: null }
  }

  const link = document.link.trim()
  const filename = document.filename.trim()
  const linkError = !link
    ? 'Informe o link público do PDF.'
    : !isSafeHeaderDocumentLink(link)
      ? 'Use um link https público, sem credenciais ou endereço interno.'
      : null
  const filenameError = !filename
    ? 'Informe o nome do arquivo.'
    : !isSafeHeaderDocumentFilename(filename)
      ? 'Use um nome de arquivo válido, sem barras ou "..".'
      : null

  if (linkError || filenameError) {
    return { isValid: false, linkError, filenameError }
  }

  return {
    isValid: true,
    value: { link, filename },
    linkError: null,
    filenameError: null,
  }
}
