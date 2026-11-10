import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

type NeonRawClient = any

// O cliente embrulhado espera o schema antes de cada query, mas o `query` do
// embrulho é uma função async: devolve uma Promise comum, não a "query do
// neon" (com queryData) que `client.transaction([...])` exige. Por isso o
// `db.batch` do drizzle falhava em produção com "transaction() expects an
// array of queries" (todo Instagram Direct inbound se perdia desde 03/11).
// Solução: o batch roda num drizzle ligado ao cliente SEM embrulho, depois de
// o schema ter sido garantido uma vez pelo chamador.
export function createNeonDbPair(rawClient: NeonRawClient, ensure: (client: NeonRawClient) => Promise<unknown>) {
  const wrappedClient = new Proxy(rawClient, {
    apply(target, thisArg, argArray) {
      return ensure(rawClient).then(() => Reflect.apply(target, thisArg, argArray))
    },
    get(target, p, receiver) {
      if (p === 'query') {
        const orig = typeof target.query === 'function' ? target.query.bind(target) : target.bind(target)
        return async function (...args: unknown[]) {
          await ensure(rawClient)
          return orig(...args)
        }
      }
      return Reflect.get(target, p, receiver)
    },
  })

  return {
    wrapped: drizzle(wrappedClient, { schema }),
    raw: drizzle(rawClient, { schema }),
  }
}
