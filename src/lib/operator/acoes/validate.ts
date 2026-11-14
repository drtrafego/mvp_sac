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
