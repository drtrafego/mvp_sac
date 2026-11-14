import { OperatorServiceError } from '../service'
const pattern = /\[(?:T\d+|LINK_\d+|CONTATO_\d+|PALAVRA_\d+)\]/g
export function resolverMarcadores(texto: string, markers: Map<string, string>): string {
  return texto.replace(pattern, marker => {
    const value = markers.get(marker)
    if (value === undefined) throw new OperatorServiceError('Referência desconhecida no pedido.', 400, 'MARKER_UNKNOWN')
    return value
  })
}
export function temMarcador(texto: string, tipos: Array<'T' | 'LINK' | 'CONTATO' | 'PALAVRA'>) {
  return (texto.match(pattern) ?? []).some(m => tipos.some(t => m.startsWith(`[${t === 'T' ? 'T' : t + '_'}`)))
}
export function somenteMarcadores(texto: string) { return (texto.match(pattern) ?? []).join(' ') }
