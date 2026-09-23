import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'
import { NINA_SOUL } from '../souls/nina'

type Db = ReturnType<typeof drizzle<typeof schema>>

let _db: Db | undefined
let _migrationPromise: Promise<void> | null = null

export function ensureSchema(client: any): Promise<void> {
  if (!_migrationPromise) {
    _migrationPromise = (async () => {
      try {
        await Promise.allSettled([
          // recovery_leads
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused boolean DEFAULT false`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_at timestamp`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_by text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_all boolean DEFAULT false`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS converted_by_job_id integer`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS converted_from text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS priority integer DEFAULT 0`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS follow_up_date timestamp`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS follow_up_note text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS pipeline_stage text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS responsible_agent text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS last_action_by text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS last_action_at timestamp DEFAULT NOW()`,
          // Metadados preservados do crm_leads nativo dos agentes. As outras
          // colunas da mesma carga (email, product_value e first_contact_at)
          // já fazem parte do schema base de recovery_leads.
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS company text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS notes text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS adset_name text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS ad_name text`,

          // whatsapp_messages
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS channel text DEFAULT 'whatsapp'`,
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS sender_name text`,
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS agent_id text`,
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS reasoning text`,
          client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS sent_email text`,
          client`CREATE INDEX IF NOT EXISTS whatsapp_messages_company_lead_created_id_idx ON whatsapp_messages (company_id, lead_id, created_at, id)`,
          client`CREATE INDEX IF NOT EXISTS whatsapp_messages_company_phone_created_id_idx ON whatsapp_messages (company_id, phone, created_at, id)`,

          // Auditoria da conversa nativa do Hermes no painel do Inbox.
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS agent_conversation_id text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS agent_cost_usd numeric(18, 8)`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS agent_input_tokens bigint`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS agent_output_tokens bigint`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS agent_synced_at timestamptz`,

          // settings
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS brevo_api_key text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS brevo_sender_email text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS brevo_sender_name text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_username text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_account_id text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_access_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_verify_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_page_id text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS instagram_app_secret text`,
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
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_system_prompt text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS meta_app_secret text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS ai_schedule_state jsonb`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS ai_reply_lock_at timestamp`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS availability_schedule jsonb`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS meta_ads_access_token text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS meta_ads_account_id text`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS mining_tags jsonb`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS meta_pixel_id text`,

          // ─── Nome de persona do bot no Inbox (22/09/2026) ──────────────────────
          // Ver comentário completo em src/lib/db/schema.ts (companies.agentDisplayName)
          // e drizzle/0012_companies_agent_display_name.sql (documental).
          client`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agent_display_name text`,
          client`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agent_display_name_manual boolean NOT NULL DEFAULT false`,

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

          // Fase 1 da resposta automática de IA (Nina/AutonomIA, 19/09/2026):
          // popula o SOUL só na primeira vez (nunca sobrescreve edição feita
          // depois pela tela de Configurações ou direto no banco).
          client`
            UPDATE settings
            SET ai_system_prompt = ${NINA_SOUL}
            FROM companies
            WHERE settings.company_id = companies.id
              AND companies.slug = 'autonomia'
              AND settings.ai_system_prompt IS NULL
          `,

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

          // ─── Bloqueios de agenda por data (férias, congresso, feriado) ─────────
          // Só a CONFIGURAÇÃO fica salva aqui: nenhum bot consulta isto ainda
          // (ver comentário no schema.ts em agendaBlockedDates).
          client`
            CREATE TABLE IF NOT EXISTS agenda_blocked_dates (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              date DATE NOT NULL,
              reason TEXT,
              created_at TIMESTAMP DEFAULT NOW()
            )
          `,
          client`
            CREATE UNIQUE INDEX IF NOT EXISTS agenda_blocked_dates_company_date_unique
            ON agenda_blocked_dates (company_id, date)
          `,

          // ─── Sync com Google Calendar real do Dr. Lucas (22/09/2026) ───────────
          // Ver comentário completo em schema.ts. Mecanismo REAL de produção é
          // aqui, não em drizzle/0011_*.sql (que é só documental) — é o
          // mesmo erro que atingiu recovery_leads antes, não repetir.
          client`ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`,
          client`ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS external_ref text`,
          client`ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS synced_at timestamp`,
          // Fix de QA (bug ALTO, 22/09/2026): reason vira campo calculado a
          // partir de bot_reason + google_reason, ver comentário em schema.ts.
          client`ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS bot_reason text`,
          client`ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS google_reason text`,

          // ─── Rate limit local da ponte de IA (Nina/Amanda, 19/09/2026) ─────────
          client`
            CREATE TABLE IF NOT EXISTS ai_bridge_calls (
              id SERIAL PRIMARY KEY,
              status TEXT NOT NULL,
              created_at TIMESTAMP DEFAULT NOW()
            )
          `,
          client`
            CREATE INDEX IF NOT EXISTS ai_bridge_calls_created_at_idx
            ON ai_bridge_calls (created_at)
          `,

          // ─── Meta Conversions API: log de envio de conversão (21/09/2026) ──────
          // Irmão de saída do webhook_received. uniqueIndex(company_id, event_id)
          // via UNIQUE inline garante que o mesmo evento (ex.: purchase_<txnId>)
          // nunca é mandado duas vezes, mesmo com retry. Ver src/lib/meta-conversions-api.ts.
          client`
            CREATE TABLE IF NOT EXISTS meta_conversion_events (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              lead_id INTEGER REFERENCES recovery_leads(id) ON DELETE SET NULL,
              event_name TEXT NOT NULL,
              event_id TEXT NOT NULL,
              pixel_id TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              http_status INTEGER,
              meta_response JSONB,
              error_message TEXT,
              attempts INTEGER NOT NULL DEFAULT 0,
              next_retry_at TIMESTAMP,
              created_at TIMESTAMP DEFAULT NOW(),
              sent_at TIMESTAMP,
              UNIQUE (company_id, event_id)
            )
          `,

          // ─── Cursores de sync incremental Agents/CRM (22/09/2026) ─────────
          // Guarda uma linha por empresa + fonte + schema/chave da fonte. Usado
          // por sync-agents.ts para separar novidades de backfill histórico e
          // acabar com o LIMIT fixo que deixava histórico antigo preso para
          // sempre quando uma fonte tinha mais de 300 linhas.
          client`
            CREATE TABLE IF NOT EXISTS sync_cursors (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              source TEXT NOT NULL,
              source_key TEXT NOT NULL,
              newest_synced_at TIMESTAMP,
              newest_synced_id TEXT,
              backfill_before_at TIMESTAMP,
              backfill_before_id TEXT,
              last_run_at TIMESTAMP,
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW()
            )
          `,
          client`
            CREATE UNIQUE INDEX IF NOT EXISTS sync_cursors_company_source_key_unique
            ON sync_cursors (company_id, source, source_key)
          `,
          client`
            CREATE INDEX IF NOT EXISTS sync_cursors_source_lookup_idx
            ON sync_cursors (source, source_key)
          `,
          client`
            CREATE TABLE IF NOT EXISTS appointment_mirror (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              native_id TEXT NOT NULL,
              name TEXT NOT NULL,
              phone TEXT,
              phone_norm TEXT,
              consultation_at TIMESTAMPTZ NOT NULL,
              status TEXT NOT NULL,
              origin TEXT,
              cancelled_at TIMESTAMPTZ,
              source_synced_at TIMESTAMPTZ NOT NULL,
              mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `,
          client`
            CREATE UNIQUE INDEX IF NOT EXISTS appointment_mirror_company_native_unique
            ON appointment_mirror (company_id, native_id)
          `,
          client`
            CREATE INDEX IF NOT EXISTS appointment_mirror_company_phone_idx
            ON appointment_mirror (company_id, phone_norm)
          `,
          client`
            CREATE INDEX IF NOT EXISTS appointment_mirror_company_date_idx
            ON appointment_mirror (company_id, consultation_at)
          `,

          // Espelho da disponibilidade operacional dos bots nativos. Nunca é
          // lido pelos bots e portanto não controla atendimento real.
          client`
            CREATE TABLE IF NOT EXISTS native_availability_schedules (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
              schedule JSONB NOT NULL,
              source TEXT NOT NULL,
              source_label TEXT NOT NULL,
              source_cursor TEXT NOT NULL,
              captured_at TIMESTAMP NOT NULL,
              synced_at TIMESTAMP NOT NULL DEFAULT NOW(),
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW()
            )
          `,

          // Espelho de gramadoplazza.reservas. A fonte remota é lida pelo
          // cursor incremental de sync-agents.ts; esta tabela nunca recebe
          // nome nem telefone cru do hóspede.
          client`
            CREATE TABLE IF NOT EXISTS gramado_reservations (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              lead_id INTEGER REFERENCES recovery_leads(id) ON DELETE SET NULL,
              reserva_id TEXT NOT NULL,
              phone_norm TEXT,
              data DATE NOT NULL,
              horario_reservado TIME,
              horario_chegada TIME,
              pessoas INTEGER,
              valor_total NUMERIC(12,2),
              status TEXT NOT NULL,
              observacoes TEXT,
              mesas_unificadas BOOLEAN,
              atualizado_em TIMESTAMPTZ,
              synced_at TIMESTAMPTZ DEFAULT NOW()
            )
          `,
          client`
            CREATE UNIQUE INDEX IF NOT EXISTS gramado_reservations_company_reserva_unique
            ON gramado_reservations (company_id, reserva_id)
          `,
          client`
            CREATE INDEX IF NOT EXISTS gramado_reservations_lead_idx
            ON gramado_reservations (company_id, lead_id)
          `,
          client`
            CREATE INDEX IF NOT EXISTS gramado_reservations_phone_idx
            ON gramado_reservations (company_id, phone_norm)
          `,
        ])

        // ─── Idempotência contra reentrega de webhook da Meta (20/09/2026, ────
        // ampliado 21/09/2026 pra incluir company_id, achado do QA 2ª rodada)
        // Fora do Promise.allSettled acima de propósito: aquele array nunca
        // inspeciona o resultado de cada statement, então uma falha ali some
        // em silêncio. Esta CREATE UNIQUE INDEX só falha se já existir
        // external_id duplicado (mesmo company_id+channel, direction='inbound')
        // em produção, e isso precisa aparecer no log em vez de sumir — sem o
        // índice, só a camada 1 (SELECT antes do insert, ver
        // src/lib/webhook-dedup.ts) protege contra reentrega, sem fechar a
        // corrida entre requisições concorrentes.
        //
        // O índice antigo (channel, external_id), sem company_id, é
        // removido primeiro: "CREATE UNIQUE INDEX IF NOT EXISTS" com um nome
        // novo não apaga o antigo sozinho, e mantê-lo não protegeria nada a
        // mais (o novo já cobre o mesmo par channel+external_id, só que
        // também escopado por empresa) e ficaria como índice morto.
        try {
          await client`DROP INDEX IF EXISTS whatsapp_messages_inbound_external_id_unique`
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_inbound_company_channel_external_id_unique
            ON whatsapp_messages (company_id, channel, external_id)
            WHERE external_id IS NOT NULL AND direction = 'inbound'
          `
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(
            '[DB Schema Sync Error] Falha ao criar whatsapp_messages_inbound_company_channel_external_id_unique ' +
              '(provável causa: já existe external_id duplicado em whatsapp_messages para o mesmo company_id+channel ' +
              "com direction='inbound'; rode " +
              "\"SELECT company_id, channel, external_id, count(*) FROM whatsapp_messages WHERE external_id IS NOT NULL AND direction='inbound' GROUP BY company_id, channel, external_id HAVING count(*) > 1\" " +
              'e resolva as duplicatas antes de tentar de novo):',
            message,
          )
        }

        // ─── Idempotência dos webhooks de atendimento contra lead duplicado ───
        // (21/09/2026, achado do QA 2ª rodada, severidade ALTA; predicado
        // ampliado com 'hermes' em 22/09/2026, achado CRÍTICO da 2ª rodada
        // seguinte): mesmo padrão do índice acima, fora do Promise.allSettled
        // de propósito para que uma falha apareça no log em vez de sumir.
        // O DROP antes do CREATE é indispensável aqui: sem ele, o índice
        // antigo (predicado sem 'hermes') já existe em produção e o
        // "IF NOT EXISTS" pula a criação, deixando o predicado velho pra
        // sempre, o que quebra com "there is no unique or exclusion
        // constraint matching ON CONFLICT" toda vez que uma rota (hermes,
        // whatsapp, instagram) fizer ON CONFLICT com o predicado novo. Só
        // falha se já existir company_id+phone duplicado entre leads de
        // atendimento (platform IN ('instagram','sac','hermes')) em
        // produção; leads de VENDA (hotmart etc.) não entram nessa condição
        // e não são afetados.
        try {
          await client`DROP INDEX IF EXISTS recovery_leads_chat_company_phone_unique`
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS recovery_leads_chat_company_phone_unique
            ON recovery_leads (company_id, phone)
            WHERE platform IN ('instagram', 'sac', 'hermes')
          `
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(
            '[DB Schema Sync Error] Falha ao criar recovery_leads_chat_company_phone_unique ' +
              '(provável causa: já existe phone duplicado em recovery_leads para o mesmo company_id entre ' +
              "leads de atendimento; rode " +
              "\"SELECT company_id, phone, count(*) FROM recovery_leads WHERE platform IN ('instagram','sac','hermes') GROUP BY company_id, phone HAVING count(*) > 1\" " +
              'e resolva as duplicatas (mesclar os leads e as mensagens do lead perdedor no vencedor) antes de tentar de novo):',
            message,
          )
        }
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
