import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

let _db: Db | undefined
let _migrated = false

function ensureSchema(sqlClient: any) {
  if (_migrated) return
  _migrated = true
  // Fire and forget auto-migration to ensure missing columns are created in Neon DB
  sqlClient`
    ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp';
    ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused boolean DEFAULT false;
    ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_at timestamp;
    ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_by text;
    ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp';
  `.catch((err: any) => {
    console.error('[DB Schema Sync Error]', err)
  })
}

export const db = new Proxy({} as Db, {
  get(_, prop) {
    if (!_db) {
      const sqlClient = neon(process.env.DATABASE_URL!)
      ensureSchema(sqlClient)
      _db = drizzle(sqlClient, { schema })
    }
    return Reflect.get(_db, prop)
  },
})
