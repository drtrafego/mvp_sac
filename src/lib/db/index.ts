import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

let _db: Db | undefined

export const db = new Proxy({} as Db, {
  get(_, prop) {
    if (!_db) {
      _db = drizzle(neon(process.env.DATABASE_URL!), { schema })
    }
    return Reflect.get(_db, prop)
  },
})
