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
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS responsible_agent text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS last_action_by text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS last_action_at timestamp DEFAULT NOW()`,

          // whatsapp_messages
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'`,
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS sender_name text`,
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS agent_id text`,

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
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_bia_api_key text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_luana_api_key text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_renato_api_key text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS allowed_ips text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS pipeline_columns jsonb`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS sidebar_config jsonb`,

          // agent_activity_logs
          client`
            CREATE TABLE IF NOT EXISTS agent_activity_logs (
              id SERIAL PRIMARY KEY,
              company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
              agent_name TEXT NOT NULL,
              agent_id TEXT,
              action TEXT NOT NULL,
              entity_type TEXT NOT NULL,
              entity_id TEXT,
              details JSONB,
              created_at TIMESTAMP DEFAULT NOW()
            )
          `,

          // message_jobs
          client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS external_wamid text`,
          client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS delivery_status text`,
          client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS message_order integer`,

          // Limpeza e correção definitiva de origens do Dr. Lucas (NUNCA é mineração)
          client`
            UPDATE recovery_leads 
            SET tracking_source = 'whatsapp_sac', event_type = 'atendimento' 
            WHERE (tracking_source ILIKE '%miner%' OR event_type ILIKE '%prospec%')
              AND company_id IN (SELECT id FROM companies WHERE slug ILIKE '%lucas%' OR name ILIKE '%lucas%')
          `,

          // Centralização das empresas dos Agentes:
          // 1. Garante que AutonomIA existe
          client`INSERT INTO companies (name, slug, plan) VALUES ('AutonomIA', 'autonomia', 'pro') ON CONFLICT (slug) DO NOTHING`,
          // 2. Transfere todos os leads e mensagens de Gastão Matos e Casal do Tráfego para AutonomIA
          client`
            UPDATE recovery_leads 
            SET company_id = (SELECT id FROM companies WHERE slug = 'autonomia' LIMIT 1) 
            WHERE company_id IN (SELECT id FROM companies WHERE slug = 'gastao-matos' OR slug = 'casaldotrafego')
          `,
          client`
            UPDATE whatsapp_messages 
            SET company_id = (SELECT id FROM companies WHERE slug = 'autonomia' LIMIT 1) 
            WHERE company_id IN (SELECT id FROM companies WHERE slug = 'gastao-matos' OR slug = 'casaldotrafego')
          `,
          // 3. Remove dependências e apaga definitivamente Gastão Matos (consolidado na AutonomIA)
          client`DELETE FROM company_members WHERE company_id IN (SELECT id FROM companies WHERE slug = 'gastao-matos')`,
          client`DELETE FROM settings WHERE company_id IN (SELECT id FROM companies WHERE slug = 'gastao-matos')`,
          client`DELETE FROM companies WHERE slug = 'gastao-matos'`,
          // 4. Garante as 5 empresas ativas do sistema: AutonomIA, Dr. Lucas, Gramado Plaza, Isabela Fanini e Amanda Felix
          client`INSERT INTO companies (name, slug, plan) VALUES ('AutonomIA', 'autonomia', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Gramado Plaza', 'gramado-plaza', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Dr. Lucas', 'drlucas', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Isabela Fanini', 'isabela-fanini', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Amanda Felix', 'amanda', 'pro') ON CONFLICT (slug) DO NOTHING`,
          // 5. Garante registro em settings para cada empresa
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

          // Garante chaves de API individuais por agente para cada empresa
          client`
            UPDATE settings s
            SET 
              agent_bia_api_key = COALESCE(s.agent_bia_api_key, 'sac_bia_' || c.slug || '_' || md5(c.id::text || '_bia')),
              agent_luana_api_key = COALESCE(s.agent_luana_api_key, 'sac_luana_' || c.slug || '_' || md5(c.id::text || '_luana')),
              agent_renato_api_key = COALESCE(s.agent_renato_api_key, 'sac_renato_' || c.slug || '_' || md5(c.id::text || '_renato'))
            FROM companies c
            WHERE s.company_id = c.id
          `,
          client`
            UPDATE companies
            SET invite_token = COALESCE(invite_token, 'sac_company_' || slug || '_' || md5(id::text || '_token'))
            WHERE invite_token IS NULL
          `,

          // ─── Instagram Comment-to-DM (Automações e Logs) ───────────────────────
          client`
            CREATE TABLE IF NOT EXISTS instagram_comment_automations (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              media_id TEXT,
              media_url TEXT,
              media_caption TEXT,
              keywords TEXT,
              match_type TEXT NOT NULL DEFAULT 'contains',
              dm_message TEXT NOT NULL,
              public_reply TEXT,
              hide_comment_after_reply BOOLEAN DEFAULT FALSE,
              active_hours_start TEXT,
              active_hours_end TEXT,
              is_active BOOLEAN DEFAULT TRUE,
              total_triggered INTEGER DEFAULT 0,
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW()
            )
          `,
          client`
            CREATE TABLE IF NOT EXISTS instagram_comment_logs (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              automation_id INTEGER REFERENCES instagram_comment_automations(id) ON DELETE CASCADE,
              comment_id TEXT NOT NULL,
              commenter_id TEXT NOT NULL,
              commenter_username TEXT,
              media_id TEXT,
              comment_text TEXT,
              matched_keyword TEXT,
              status TEXT NOT NULL,
              error_message TEXT,
              sent_at TIMESTAMP,
              created_at TIMESTAMP DEFAULT NOW()
            )
          `,
          client`
            CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_logs_comment_unique 
            ON instagram_comment_logs (company_id, comment_id)
          `,
          client`
            CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_logs_user_media_unique 
            ON instagram_comment_logs (automation_id, commenter_id, media_id)
          `,
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
