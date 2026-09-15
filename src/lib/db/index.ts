import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

let _db: Db | undefined
let _migrationPromise: Promise<void> | null = null

function ensureSchema(client: any): Promise<void> {
  if (!_migrationPromise) {
    _migrationPromise = (async () => {
      try {
        await Promise.allSettled([
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused boolean DEFAULT false`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_at timestamp`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_by text`,
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_username text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_account_id text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_access_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_verify_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_page_id text`,
        ])
      } catch (err: any) {
        console.error('[DB Schema Sync Error]', err?.message || err)
      }
    })()
  }
  return _migrationPromise
}

export const db = new Proxy({} as Db, {
  get(_, prop) {
    if (!_db) {
      const rawClient: any = neon(process.env.DATABASE_URL!)

      if (typeof rawClient.query === 'function') {
        const origQuery = rawClient.query.bind(rawClient)
        rawClient.query = async function (querySql: string, params: any[], opts: any) {
          await ensureSchema(rawClient)
          return origQuery(querySql, params, opts)
        }
      } else {
        ensureSchema(rawClient)
      }

      _db = drizzle(rawClient, { schema })
    }
    return Reflect.get(_db, prop)
  },
})
