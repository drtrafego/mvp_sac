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
