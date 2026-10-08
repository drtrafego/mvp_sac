// PostgreSQL WASM descartável para testes de handlers; nunca usa DATABASE_URL.
// Instale @electric-sql/pglite no ambiente de testes ou passe PGLITE_MODULE
// com o caminho absoluto do módulo já instalado. Requer Node 24.
import * as nodeModule from 'node:module'
import { pathToFileURL } from 'node:url'
import { getTableColumns, getTableName, SQL } from 'drizzle-orm'
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core'

export async function createSacTestDatabase(tables: PgTable[]) {
  const require = nodeModule.createRequire(import.meta.url)
  const pglitePath = process.env.PGLITE_MODULE || require.resolve('@electric-sql/pglite')
  const moduleUrl = pathToFileURL(pglitePath).href
  // Drizzle resolve o mesmo módulo instalado fora do projeto, sem copiar
  // dependências, mudar node_modules ou alterar configurações do produto.
  type HookApi = { registerHooks(options: { resolve: (specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => unknown) => unknown }): { deregister(): void } }
  const hooks = (nodeModule as unknown as HookApi).registerHooks({ resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => unknown) {
    if (specifier === '@electric-sql/pglite') return { url: moduleUrl, shortCircuit: true }
    // Auth.ts usa server-only no Next; o teste de servidor fora do Next é
    // executado exclusivamente em Node e não cria um bundle de navegador.
    if (specifier === 'server-only') return { url: 'data:text/javascript,export%20%7B%7D', shortCircuit: true }
    return nextResolve(specifier, context)
  } })
  const { PGlite } = await import(moduleUrl)
  const { drizzle } = await import('drizzle-orm/pglite')
  const pg = new PGlite()
  const db = drizzle(pg)
  const dialect = new PgDialect()
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
  const expression = (value: SQL, tableName?: string) => {
    const compiled = dialect.sqlToQuery(value)
    if (compiled.params.length) throw new Error('DDL de teste não suporta parâmetros')
    return tableName ? compiled.sql.split(`${quote(tableName)}.`).join('') : compiled.sql
  }
  const literal = (value: unknown, type: string): string => {
    if (value instanceof SQL) return expression(value)
    if (value === null) return 'null'
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return `'${text.replace(/'/g, "''")}'${type === 'jsonb' ? '::jsonb' : ''}`
  }
  try {
    for (const table of tables) {
      const config = getTableConfig(table)
      const columns = Object.values(getTableColumns(table)).map((column) => {
        const type = column.getSQLType()
        return `${quote(column.name)} ${type}${column.primary ? ' primary key' : ''}${column.isUnique ? ' unique' : ''}${column.default !== undefined ? ` default ${literal(column.default, type)}` : ''}`
      })
      // Tipos, defaults, chaves e índices são do schema. FKs/NOT NULL de
      // campos não exercitados não substituem as guardas reais dos handlers.
      await pg.exec(`create table ${quote(getTableName(table))} (${columns.join(', ')})`)
      for (const index of config.indexes) {
        const columns = index.config.columns.map(column => {
          if (!(column instanceof SQL)) {
            const name = (column as { name?: string }).name
            if (!name) throw new Error('Coluna de índice sem nome no schema de teste')
            return quote(name)
          }
          const raw = expression(column, config.name)
          const direction = raw.match(/\s+(ASC|DESC)(?:\s+NULLS\s+(FIRST|LAST))?\s*$/i)
          return direction ? `(${raw.slice(0, direction.index)})${direction[0]}` : `(${raw})`
        })
        if (!index.config.name) throw new Error('Índice sem nome no schema de teste')
        await pg.exec(`create ${index.config.unique ? 'unique ' : ''}index ${quote(index.config.name)} on ${quote(config.name)} (${columns.join(', ')})${index.config.where ? ` where ${expression(index.config.where, config.name)}` : ''}`)
      }
      for (const constraint of config.uniqueConstraints) {
        await pg.exec(`alter table ${quote(config.name)} add constraint ${quote(constraint.name!)} unique (${constraint.columns.map(column => quote(column.name)).join(', ')})`)
      }
    }
  } catch (error) {
    await pg.close(); hooks.deregister(); throw error
  }
  return { pg, db, close: async () => { await pg.close(); hooks.deregister() } }
}
