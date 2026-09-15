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
          // recovery_leads
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused boolean DEFAULT false`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_at timestamp`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_by text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS converted_by_job_id integer`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS converted_from text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS priority integer DEFAULT 0`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS follow_up_date timestamp`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS follow_up_note text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS pipeline_stage text`,

          // whatsapp_messages
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'`,

          // settings
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS brevo_api_key text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS brevo_sender_email text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS brevo_sender_name text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_username text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_account_id text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_access_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_verify_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_page_id text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS kiwify_webhook_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS uazapi_base_url text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS uazapi_instance_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS whatsapp_provider text DEFAULT 'meta'`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS supabase_database_url text`,

          // message_jobs
          client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS external_wamid text`,
          client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS delivery_status text`,
          client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS message_order integer`,

          // Centralização das empresas dos Agentes:
          // 1. Gastão Matos (vincula a empresa 1 que já possui todos os dados e histórico da AutonomIA)
          client`UPDATE companies SET name = 'Gastão Matos', slug = 'gastao-matos' WHERE id = 1`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Gastão Matos', 'gastao-matos', 'pro') ON CONFLICT (slug) DO NOTHING`,
          // 2. Gramado Plaza
          client`INSERT INTO companies (name, slug, plan) VALUES ('Gramado Plaza', 'gramado-plaza', 'pro') ON CONFLICT (slug) DO NOTHING`,
          // 3. Dr. Lucas
          client`INSERT INTO companies (name, slug, plan) VALUES ('Dr. Lucas', 'drlucas', 'pro') ON CONFLICT (slug) DO NOTHING`,
          // Garante registro em settings para cada empresa
          client`INSERT INTO settings (company_id) SELECT id FROM companies ON CONFLICT (company_id) DO NOTHING`,

          // Garante os proprietários como administradores ativos de todas as empresas
          client`
            INSERT INTO company_members (company_id, email, name, role, status)
            SELECT c.id, 'amandafelixgolden@gmail.com', 'Amanda Felix', 'admin', 'ativo'
            FROM companies c
            WHERE NOT EXISTS (
              SELECT 1 FROM company_members cm 
              WHERE cm.company_id = c.id AND cm.email = 'amandafelixgolden@gmail.com'
            )
          `,
          client`
            INSERT INTO company_members (company_id, email, name, role, status)
            SELECT c.id, 'dr.trafego@gmail.com', 'Dr. Tráfego', 'admin', 'ativo'
            FROM companies c
            WHERE NOT EXISTS (
              SELECT 1 FROM company_members cm 
              WHERE cm.company_id = c.id AND cm.email = 'dr.trafego@gmail.com'
            )
          `,
        ])

        // Dispara sincronização automática dos agentes do Supabase em segundo plano
        setTimeout(() => {
          import('@/lib/sync-agents').then(m => m.syncAgentsAndCompanies()).catch(() => {})
        }, 1000)
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

      const wrappedClient = new Proxy(rawClient, {
        apply(target, thisArg, argArray) {
          return ensureSchema(rawClient).then(() => Reflect.apply(target, thisArg, argArray))
        },
        get(target, p, receiver) {
          if (p === 'query') {
            const orig = typeof target.query === 'function' ? target.query.bind(target) : target.bind(target)
            return async function (...args: any[]) {
              await ensureSchema(rawClient)
              return orig(...args)
            }
          }
          return Reflect.get(target, p, receiver)
        },
      })

      _db = drizzle(wrappedClient, { schema })
    }
    return Reflect.get(_db, prop)
  },
})
