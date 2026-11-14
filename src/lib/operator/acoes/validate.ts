import { OperatorServiceError } from '../service'
export function validarTextoNota(texto: string, original: string) {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  texto = texto.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  const textoReescrito = !norm(original).includes(norm(texto))
  const body = (textoReescrito ? 'Operador SAC: ' : '') + texto.trim()
  if (!texto.trim() || body.length > 4000 || [...body].some(c => (c.charCodeAt(0) < 32 && c !== '\n') || c.charCodeAt(0) === 127))
    throw new OperatorServiceError('Nota inválida.', 400, 'INVALID_NOTE')
  return { texto: body, textoReescrito }
}

import { isIP } from 'node:net'
import { normalizeCommentKeywordText } from '@/lib/instagram-comment-keywords'
import { INSTAGRAM_COMMENT_DM_TEMPLATE_KEYWORD } from '@/lib/instagram-comment-dm-template'
import { PALAVRAS_PROIBIDAS } from './limits'
import { resolverMarcadores } from './markers'
export function validarPalavra(palavra: string, correspondencia = 'contains'): string {
  const value = palavra.trim()
  const normalized = normalizeCommentKeywordText(value)
  if (value.length < (correspondencia === 'contains' ? 3 : 2) || value.length > 60 || /[,\r\n\x00-\x1f\x7f]/.test(value)
    || /\[(?:T\d+|PALAVRA_\d+|LINK_\d+|CONTATO_\d+)\]/.test(value) || PALAVRAS_PROIBIDAS.has(normalized) || normalized === normalizeCommentKeywordText(INSTAGRAM_COMMENT_DM_TEMPLATE_KEYWORD))
    throw new OperatorServiceError('Palavra inválida, comum demais ou reservada. Escolha outra palavra.', 400, 'INVALID_KEYWORD')
  return value
}
export function palavraDoMarcador(value: string, markers: Map<string, string>, correspondencia = 'contains') {
  if (!/^\[(?:PALAVRA_\d+|T\d+)\]$/.test(value.trim())) throw new OperatorServiceError('A palavra deve vir do pedido.', 400, 'MARKER_REQUIRED')
  return validarPalavra(resolverMarcadores(value, markers), correspondencia)
}
export function hostDe(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new OperatorServiceError('Use um endereço HTTPS válido.', 400, 'INVALID_LINK') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || isIP(host) || host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost'))
    throw new OperatorServiceError('Use um endereço HTTPS público, sem credenciais.', 400, 'INVALID_LINK')
  return host
}
export function validarMensagem(texto: string, contexto: { markers?: Map<string, string>; original?: string; linkDomains?: string[]; servidor?: boolean }) {
  if (!contexto.servidor && /https?|www\./i.test(texto)) throw new OperatorServiceError('O link precisa vir do pedido humano.', 400, 'LINK_NOT_FROM_USER')
  let mensagem = texto
  if (!contexto.servidor) {
    // Blocos entre aspas podem conter um [LINK_n] protegido antes da criação
    // do marcador do bloco. Expande somente os marcadores do próprio pedido.
    const markers = contexto.markers ?? new Map<string, string>()
    const seen = new Set<string>()
    while (/\[(?:T\d+|PALAVRA_\d+|LINK_\d+|CONTATO_\d+)\]/.test(mensagem)) {
      if (seen.has(mensagem) || seen.size > markers.size) throw new OperatorServiceError('Referência desconhecida no pedido.', 400, 'MARKER_UNKNOWN')
      seen.add(mensagem)
      mensagem = resolverMarcadores(mensagem, markers)
    }
  }
  if (!mensagem.trim() || mensagem.length > 1500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(mensagem)) throw new OperatorServiceError('Mensagem inválida. Use até 1.500 caracteres.', 400, 'INVALID_MESSAGE')
  const dominios = [...new Set((mensagem.match(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi) ?? []).map(hostDe))]
  const allowed = contexto.linkDomains ?? []
  if (allowed.length && dominios.some(host => !allowed.some(domain => host === domain.toLowerCase() || host.endsWith('.' + domain.toLowerCase()))))
    throw new OperatorServiceError('O domínio do link não está liberado para esta empresa.', 400, 'LINK_DOMAIN_NOT_ALLOWED')
  const avisos = allowed.length ? [] : dominios.map(host => `Domínio não verificado: ${host}.`)
  if (!contexto.original || !contexto.original.includes(mensagem)) avisos.push('Texto escrito pelo agente ou cadastrado anteriormente, revise antes de confirmar.')
  return { mensagem, dominios, avisos }
}
