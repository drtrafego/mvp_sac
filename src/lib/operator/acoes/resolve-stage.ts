import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { DEFAULT_PIPELINE_COLUMNS, parsePipelineColumns } from '@/lib/pipeline-columns-update'
export function norm(value: string) { return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim() }
export async function colunasDaEmpresa(companyId: number) {
  const [row] = await db.select({ columns: settings.pipelineColumns }).from(settings).where(eq(settings.companyId, companyId)).limit(1)
  try { return parsePipelineColumns(row?.columns) } catch { return DEFAULT_PIPELINE_COLUMNS }
}
export async function resolverEtapa(companyId: number, termo: string, aliases: Record<string, string>) {
  const columns = await colunasDaEmpresa(companyId)
  const n = norm(termo)
  const alias = columns.find(c => c.id === aliases[n])
  const parts = (c: typeof columns[number]) => [c.id, c.label, ...c.label.split('/')].map(norm)
  const exact = columns.filter(c => parts(c).includes(n))
  const prefix = n.length >= 4 ? columns.filter(c => parts(c).some(p => p.startsWith(n))) : []
  const found = alias ?? (exact.length === 1 ? exact[0] : exact.length === 0 && prefix.length === 1 ? prefix[0] : undefined)
  return found ? { tipo: 'ok' as const, etapaId: found.id, label: found.label }
    : { tipo: 'esclarecer' as const, termo, opcoes: columns.map(({ id, label }) => ({ id, label })) }
}
