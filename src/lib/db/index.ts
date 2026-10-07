import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { randomBytes } from 'crypto'
import * as schema from './schema'
import { NINA_SOUL } from '../souls/nina'

type Db = ReturnType<typeof drizzle<typeof schema>>

let _db: Db | undefined
let _migrationPromise: Promise<void> | null = null

// ─── Consolidação AutonomIA: transferência + delete ATÔMICOS ─────────────────
// (26/09/2026, achado A07 P0 da auditoria Codex/gpt-6-astra). Antes, isto
// vivia dentro do Promise.allSettled de ensureSchema como 5 statements
// separados (INSERT autonomia, UPDATE recovery_leads, UPDATE
// whatsapp_messages, 3x DELETE de gastao-matos): allSettled dispara TODAS as
// queries do array em PARALELO, sem ordem garantida entre elas nem rollback
// conjunto (cada `client\`...\`` já executa a request assim que é chamado,
// antes mesmo do allSettled esperar), então o DELETE em cascata (FKs com
// ON DELETE CASCADE, ver schema.ts) podia rodar ANTES ou apesar de a
// transferência ter falhado silenciosamente, apagando lead/mensagem de
// cliente real que nunca chegou a ser migrado para a AutonomIA.
//
// Agora é UMA única query com múltiplos CTEs, extraída em função própria
// (testável isolada, sem depender do singleton _migrationPromise nem da
// lista gigante de ALTER TABLE de ensureSchema). Em Postgres uma query única
// (mesmo com vários CTEs de escrita) roda como uma transação implícita: se
// qualquer parte falhar, TUDO é revertido, nenhum DELETE acontece sem a
// transferência ter sido concluída primeiro.
//
// Testado com Postgres descartável real (scripts/db-consolidacao-
// autonomia.test.ts): cenário de sucesso completo, cenário de falha simulada
// no meio da transferência de mensagens (nada é apagado, rollback total
// confirmado), e execução repetida (idempotente, nenhuma empresa/lead/
// mensagem sobra pra mexer na segunda vez).
//
// Validação extra (defesa em profundidade, não só a atomicidade da
// transação): a contagem de leads/mensagens de gastao-matos ANTES
// (before_counts, contra o snapshot original, que os CTEs de leitura direta
// nunca veem afetado pelos UPDATEs irmãos porque todos os CTEs de uma mesma
// query usam o snapshot do início da query) é comparada com a contagem de
// linhas efetivamente movidas (RETURNING das próprias UPDATEs). Só bate = só
// então o DELETE de company_members/settings/companies roda; não bater vira
// log de erro e a origem fica preservada pra a próxima inicialização tentar
// de novo.
//
// casaldotrafego tem leads/mensagens migrados mas a EMPRESA em si não é
// apagada (mesmo comportamento de sempre, nunca mexemos nisso).
//
// LIMITAÇÃO conhecida 1 (achado do QA, 26/09/2026): safe_to_delete_gastao só
// valida a contagem do lado gastao-matos (before_counts / moved_*_gastao).
// Não é destrutivo, porque casaldotrafego nunca é apagada aqui, mas a
// garantia de "nenhum DELETE sem transferência confirmada" cobre só
// gastao-matos, não casaldotrafego — não afirmar cobertura completa dos dois
// lados.
//
// LIMITAÇÃO conhecida 2 (achado do QA, 26/09/2026): companies.id tem
// ON DELETE CASCADE a partir de outras ~7 tabelas além de recovery_leads e
// whatsapp_messages (syncCursors, gramadoReservations, recoverySequences,
// instagramCommentAutomations, instagramCommentLogs, agendaBlockedDates,
// metaConversionEvents — ver schema.ts). Se gastao-matos tiver linha em
// qualquer uma delas, o DELETE FROM companies cascateia e apaga sem ter sido
// migrado. NÃO é regressão desta função (o código antigo já tinha o mesmo
// buraco) — só não afirmar que "nenhum DELETE sem transferência confirmada"
// é garantia absoluta: ela cobre leads e mensagens, não as demais tabelas
// com cascade.
export async function consolidateAutonomiaCompany(client: any): Promise<void> {
  try {
    const [consolidation] = await client`
      WITH target_company AS (
        INSERT INTO companies (name, slug, plan)
        VALUES ('AutonomIA', 'autonomia', 'pro')
        ON CONFLICT (slug) DO UPDATE SET slug = companies.slug
        RETURNING id
      ),
      gastao_company AS (
        SELECT id FROM companies WHERE slug = 'gastao-matos'
      ),
      casal_company AS (
        SELECT id FROM companies WHERE slug = 'casaldotrafego'
      ),
      before_counts AS (
        SELECT
          (SELECT count(*) FROM recovery_leads WHERE company_id IN (SELECT id FROM gastao_company)) AS gastao_leads_before,
          (SELECT count(*) FROM whatsapp_messages WHERE company_id IN (SELECT id FROM gastao_company)) AS gastao_messages_before
      ),
      moved_leads_gastao AS (
        UPDATE recovery_leads
        SET company_id = (SELECT id FROM target_company)
        WHERE company_id IN (SELECT id FROM gastao_company)
        RETURNING id
      ),
      moved_leads_casal AS (
        UPDATE recovery_leads
        SET company_id = (SELECT id FROM target_company)
        WHERE company_id IN (SELECT id FROM casal_company)
        RETURNING id
      ),
      moved_messages_gastao AS (
        UPDATE whatsapp_messages
        SET company_id = (SELECT id FROM target_company)
        WHERE company_id IN (SELECT id FROM gastao_company)
        RETURNING id
      ),
      moved_messages_casal AS (
        UPDATE whatsapp_messages
        SET company_id = (SELECT id FROM target_company)
        WHERE company_id IN (SELECT id FROM casal_company)
        RETURNING id
      ),
      validated AS (
        SELECT
          (SELECT gastao_leads_before FROM before_counts) AS gastao_leads_before,
          (SELECT count(*) FROM moved_leads_gastao) AS gastao_leads_moved,
          (SELECT gastao_messages_before FROM before_counts) AS gastao_messages_before,
          (SELECT count(*) FROM moved_messages_gastao) AS gastao_messages_moved
      ),
      safe_to_delete_gastao AS (
        SELECT (
          (SELECT gastao_leads_before FROM validated) = (SELECT gastao_leads_moved FROM validated)
          AND (SELECT gastao_messages_before FROM validated) = (SELECT gastao_messages_moved FROM validated)
        ) AS ok
      ),
      deleted_members AS (
        DELETE FROM company_members
        WHERE company_id IN (SELECT id FROM gastao_company)
          AND (SELECT ok FROM safe_to_delete_gastao) = true
        RETURNING id
      ),
      deleted_settings AS (
        DELETE FROM settings
        WHERE company_id IN (SELECT id FROM gastao_company)
          AND (SELECT ok FROM safe_to_delete_gastao) = true
        RETURNING id
      ),
      deleted_company AS (
        DELETE FROM companies
        WHERE id IN (SELECT id FROM gastao_company)
          AND (SELECT ok FROM safe_to_delete_gastao) = true
        RETURNING id
      )
      SELECT
        (SELECT ok FROM safe_to_delete_gastao) AS safe_to_delete,
        (SELECT count(*) FROM moved_leads_gastao) + (SELECT count(*) FROM moved_leads_casal) AS leads_moved_total,
        (SELECT count(*) FROM moved_messages_gastao) + (SELECT count(*) FROM moved_messages_casal) AS messages_moved_total,
        (SELECT count(*) FROM deleted_members) AS members_deleted,
        (SELECT count(*) FROM deleted_settings) AS settings_deleted,
        (SELECT count(*) FROM deleted_company) AS company_deleted
    `
    if (consolidation && consolidation.safe_to_delete === false) {
      console.error(
        '[DB Schema Sync Error] Consolidação AutonomIA: a contagem de leads/mensagens transferidos de gastao-matos não bateu com o esperado. ' +
          'company_members/settings/companies de gastao-matos NÃO foram apagados nesta rodada (dado preservado); vai tentar de novo na próxima inicialização.',
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      '[DB Schema Sync Error] Falha na consolidação atômica AutonomIA (gastao-matos/casaldotrafego -> autonomia): ' +
        'nada foi transferido nem apagado nesta rodada, a query inteira foi revertida (rollback automático):',
      message,
    )
  }
}

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
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_paused_channel text`,
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
          client`CREATE INDEX IF NOT EXISTS whatsapp_messages_company_direction_lead_idx ON whatsapp_messages (company_id, direction, lead_id)`,
          client`CREATE INDEX IF NOT EXISTS recovery_leads_company_activity_idx ON recovery_leads (company_id, COALESCE(last_action_at, updated_at, created_at) DESC, id DESC)`,
          client`CREATE INDEX IF NOT EXISTS recovery_leads_company_paused_idx ON recovery_leads (company_id, bot_paused)`,

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
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_publicador_api_key text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS allowed_ips text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS pipeline_columns jsonb`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS sidebar_config jsonb`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_system_prompt text`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS meta_app_secret text`,
          // Gate de habilitado/desabilitado da integração Hotmart (30/09/2026),
          // ver comentário completo em schema.ts (settings.hotmartEnabled) e
          // no webhook (src/app/api/webhooks/hotmart/[slug]/route.ts).
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS hotmart_enabled boolean NOT NULL DEFAULT true`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS greenn_enabled boolean NOT NULL DEFAULT true`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS kiwify_enabled boolean NOT NULL DEFAULT true`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS zouti_enabled boolean NOT NULL DEFAULT true`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS ai_schedule_state jsonb`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS ai_reply_lock_at timestamp`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS availability_schedule jsonb`,
          client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS availability_schedule_manual boolean NOT NULL DEFAULT false`,
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
          // A transferência de leads/mensagens de gastao-matos/casaldotrafego
          // para autonomia, e o DELETE definitivo de gastao-matos, SAÍRAM
          // deste array em 26/09/2026 (achado A07, auditoria Codex/gpt-6-astra,
          // ver bloco atômico logo depois deste Promise.allSettled). Motivo:
          // Promise.allSettled dispara todas as queries do array em PARALELO,
          // sem ordem garantida entre elas (cada `client\`...\`` já executa a
          // request assim que é chamado, antes mesmo do allSettled esperar);
          // a transferência podia terminar DEPOIS do DELETE em cascata, e uma
          // falha silenciosa (allSettled não aborta as demais) não impedia o
          // DELETE de rodar mesmo sem o dado ter sido migrado. Isso apagava
          // lead/mensagem de cliente real sem nunca ter chegado na AutonomIA.
          //
          // Garante as 5 empresas ativas do sistema: AutonomIA, Dr. Lucas, Gramado Plaza, Isabela Fanini e Amanda Felix
          // (autonomia é criada de novo aqui, redundante com o INSERT ...
          // ON CONFLICT DO NOTHING de dentro de consolidateAutonomiaCompany
          // logo abaixo do array — mantido assim de propósito, é idempotente
          // e sair daqui é risco à toa fora do escopo do achado A07).
          client`INSERT INTO companies (name, slug, plan) VALUES ('AutonomIA', 'autonomia', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Gramado Plaza', 'gramado-plaza', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Dr. Lucas', 'drlucas', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Isabela Fanini', 'isabela-fanini', 'pro') ON CONFLICT (slug) DO NOTHING`,
          client`INSERT INTO companies (name, slug, plan) VALUES ('Amanda Felix', 'amanda', 'pro') ON CONFLICT (slug) DO NOTHING`,
          // Garante registro em settings para cada empresa
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
            CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_automations_company_media_unique
            ON instagram_comment_automations (company_id, media_id)
            WHERE media_id IS NOT NULL AND media_id != ''
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

          // ─── Gate de seguidor do Comment-to-DM (24/09/2026) ─────────────────────
          // Ver comentário completo em src/lib/db/schema.ts
          // (instagramCommentAutomations.requireFollowCheck e
          // recoveryLeads.pendingFollowCheckAutomationId).
          client`ALTER TABLE instagram_comment_automations ADD COLUMN IF NOT EXISTS require_follow_check BOOLEAN DEFAULT FALSE`,
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS pending_follow_check_automation_id INTEGER REFERENCES instagram_comment_automations(id) ON DELETE SET NULL`,
          // FIX ALTO de QA (24/09/2026, 2ª rodada): contador de tentativas
          // sem confirmar, ver comentário completo em schema.ts.
          client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS pending_follow_check_attempts INTEGER DEFAULT 0`,

          // ─── Bloqueios de agenda por data (férias, congresso, feriado) ─────────
          // Fonte local usada pelo cron de follow-up. Para o Dr. Lucas, as
          // escritas manuais também são propagadas e confirmadas no Hermes.
          // Ver comentário completo no schema.ts em agendaBlockedDates.
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

        // ─── Credenciais de agente com entropia real (26/09/2026, achado de ────
        // auditoria de segurança P0, reproduzido) ───────────────────────────────
        // As duas UPDATEs que geravam agent_bia_api_key / agent_luana_api_key /
        // agent_renato_api_key / invite_token por md5(slug + id numérico) foram
        // REMOVIDAS do Promise.allSettled acima: quem soubesse o slug e o id da
        // empresa (nenhum dos dois é secreto) recalculava a credencial sozinho,
        // sem entropia privada nenhuma. A geração agora usa crypto.randomBytes
        // (Node), por isso roda fora de SQL puro, uma empresa de cada vez, só
        // para quem ainda está NULL — igual ao padrão de fora do
        // Promise.allSettled já usado abaixo (falha loga em vez de sumir).
        // Empresa que já tinha chave md5 antiga (provavelmente todas as de
        // produção hoje) CONTINUA com ela até ser rotacionada: ver
        // POST /api/admin/companies/[id]/rotate-key (uma empresa por vez, nunca
        // em massa sem autorização explícita).
        try {
          type PendingAgentKeyRow = {
            company_id: number
            slug: string
            agent_bia_api_key: string | null
            agent_luana_api_key: string | null
            agent_renato_api_key: string | null
          }
          const pendingKeys = (await client`
            SELECT s.company_id, c.slug,
                   s.agent_bia_api_key, s.agent_luana_api_key, s.agent_renato_api_key
            FROM settings s
            JOIN companies c ON c.id = s.company_id
            WHERE s.agent_bia_api_key IS NULL
               OR s.agent_luana_api_key IS NULL
               OR s.agent_renato_api_key IS NULL
          `) as PendingAgentKeyRow[]
          for (const row of pendingKeys) {
            if (!row.agent_bia_api_key) {
              await client`
                UPDATE settings SET agent_bia_api_key = ${'sac_bia_' + row.slug + '_' + randomBytes(24).toString('hex')}
                WHERE company_id = ${row.company_id} AND agent_bia_api_key IS NULL
              `
            }
            if (!row.agent_luana_api_key) {
              await client`
                UPDATE settings SET agent_luana_api_key = ${'sac_luana_' + row.slug + '_' + randomBytes(24).toString('hex')}
                WHERE company_id = ${row.company_id} AND agent_luana_api_key IS NULL
              `
            }
            if (!row.agent_renato_api_key) {
              await client`
                UPDATE settings SET agent_renato_api_key = ${'sac_renato_' + row.slug + '_' + randomBytes(24).toString('hex')}
                WHERE company_id = ${row.company_id} AND agent_renato_api_key IS NULL
              `
            }
          }

          type PendingInviteRow = { id: number; slug: string }
          const pendingInvites = (await client`
            SELECT id, slug FROM companies WHERE invite_token IS NULL
          `) as PendingInviteRow[]
          for (const row of pendingInvites) {
            await client`
              UPDATE companies SET invite_token = ${'sac_company_' + row.slug + '_' + randomBytes(24).toString('hex')}
              WHERE id = ${row.id} AND invite_token IS NULL
            `
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[DB Schema Sync Error] Falha ao gerar credenciais de agente com entropia real:', message)
        }

        // Consolidação AutonomIA (transferência + delete de gastao-matos):
        // função própria, ver comentário completo em consolidateAutonomiaCompany
        // no topo deste arquivo (achado A07, 26/09/2026).
        await consolidateAutonomiaCompany(client)

        // Upload e disparo são etapas separadas. Estas tabelas guardam o
        // draft e seus destinatários; message_jobs só nasce na confirmação.
        try {
          await client`
            CREATE TABLE IF NOT EXISTS mass_dispatch_batches (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              file_name TEXT,
              event_type TEXT NOT NULL,
              tracking_source TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'draft',
              recipient_count INTEGER NOT NULL DEFAULT 0,
              confirmed_at TIMESTAMP,
              created_at TIMESTAMP DEFAULT NOW()
            )
          `
          await client`
            CREATE TABLE IF NOT EXISTS mass_dispatch_recipients (
              id SERIAL PRIMARY KEY,
              batch_id INTEGER NOT NULL REFERENCES mass_dispatch_batches(id) ON DELETE CASCADE,
              lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
              created_at TIMESTAMP DEFAULT NOW()
            )
          `
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS mass_dispatch_recipients_batch_lead_unique
            ON mass_dispatch_recipients (batch_id, lead_id)
          `
          await client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS mass_dispatch_batch_id INTEGER REFERENCES mass_dispatch_batches(id) ON DELETE SET NULL`
          await client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS message_snapshot JSONB`
          await client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`
          await client`ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP`
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS message_jobs_mass_dispatch_unique
            ON message_jobs (mass_dispatch_batch_id, lead_id, message_id)
          `
          await client`
            CREATE TABLE IF NOT EXISTS mass_dispatch_phone_cooldowns (
              meta_phone_number_id TEXT PRIMARY KEY,
              cooldown_until TIMESTAMP NOT NULL,
              reason TEXT,
              updated_at TIMESTAMP DEFAULT NOW()
            )
          `
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[DB Schema Sync Error] Falha ao criar infraestrutura de disparo em massa:', message)
        }

        // ─── Tags livres de lead (25/09/2026) ──────────────────────────────
        // Ver comentário completo em src/lib/db/schema.ts (leadTags) e no
        // contrato da rota src/app/api/leads/[leadId]/tags/route.ts.
        // Fora do Promise.allSettled acima de propósito (QA 25/09/2026, item
        // médio): aquele array nunca inspeciona o resultado de cada
        // statement, então uma falha ali some em silêncio — mesmo padrão já
        // usado abaixo para os índices de dedup de whatsapp_messages e
        // recovery_leads.
        try {
          await client`
            CREATE TABLE IF NOT EXISTS lead_tags (
              id SERIAL PRIMARY KEY,
              lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
              tag TEXT NOT NULL,
              scope_channel TEXT,
              created_at TIMESTAMP DEFAULT NOW(),
              created_by TEXT
            )
          `
          await client`
            ALTER TABLE lead_tags ADD COLUMN IF NOT EXISTS scope_channel TEXT
          `
          // Uma tentativa anterior, depois revertida, pode ter deixado tags
          // gerais duplicadas porque NULL não era protegido pelo índice.
          // Limpar antes do DROP + CREATE garante que dados legados não
          // façam a criação do índice correto falhar silenciosamente.
          await client`
            DELETE FROM lead_tags
            WHERE id IN (
              SELECT id
              FROM (
                SELECT
                  id,
                  ROW_NUMBER() OVER (
                    PARTITION BY lead_id, tag, COALESCE(scope_channel, '')
                    ORDER BY created_at ASC NULLS LAST, id ASC
                  ) AS duplicate_position
                FROM lead_tags
              ) AS ranked_lead_tags
              WHERE duplicate_position > 1
            )
          `
          // Uma versão revertida já usou este mesmo nome com uma definição
          // incorreta (sem COALESCE). DROP + CREATE é intencional: IF NOT
          // EXISTS preservaria silenciosamente o índice malformado.
          await client`
            DROP INDEX IF EXISTS lead_tags_lead_tag_scope_unique
          `
          await client`
            CREATE UNIQUE INDEX lead_tags_lead_tag_scope_unique
            ON lead_tags (lead_id, tag, COALESCE(scope_channel, ''))
          `
          await client`
            DROP INDEX IF EXISTS lead_tags_lead_tag_unique
          `
          await client`
            CREATE INDEX IF NOT EXISTS lead_tags_tag_idx
            ON lead_tags (tag)
          `
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[DB Schema Sync Error] Falha ao criar a tabela lead_tags ou seus índices:', message)
        }

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
        //
        // CONCURRENTLY foi tentado em 26/09/2026 (achado A07 da auditoria
        // Codex/gpt-6-astra) pra reduzir lock entre instâncias serverless
        // concorrentes, e revertido no mesmo dia (achado do QA sobre o
        // próprio fix A07): se a conexão cair no meio de um CREATE INDEX
        // CONCURRENTLY (plausível em serverless real: timeout, cold start
        // reciclado, Neon HTTP cortando a conexão), o índice fica no
        // catálogo com indisvalid=false (inválido, inútil) e o
        // "IF NOT EXISTS" do próximo cold start só olha se o NOME existe,
        // não se é válido — o índice fica quebrado PRA SEMPRE, em silêncio,
        // só um NOTICE que ninguém vê. Este índice específico protege
        // contra mensagem de WhatsApp duplicada: se quebrar sem avisar,
        // a proteção contra duplicata desliga sem ninguém saber. Sem
        // CONCURRENTLY o DROP/CREATE toma lock breve, mas é atômico e não
        // tem esse modo de falha silenciosa.
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
        //
        // CONCURRENTLY foi tentado em 26/09/2026 (achado A07) e revertido no
        // mesmo dia (achado do QA sobre o próprio fix A07, mesmo motivo do
        // bloco de whatsapp_messages logo acima): se a conexão cair no meio
        // de um CREATE INDEX CONCURRENTLY, o índice fica inválido no
        // catálogo em silêncio. Este bloco em particular usa o MESMO nome
        // no DROP e no CREATE, então cada cold start futuro já tenta
        // recriá-lo (se autocura sozinho), mas ainda assim fica uma janela
        // com o índice quebrado até o próximo cold start passar por aqui —
        // sem CONCURRENTLY não existe essa janela. Nota pra quem mexer aqui
        // de novo: este DROP+CREATE roda a CADA cold start (não só na
        // primeira vez), porque o DROP é incondicional; ficou assim de
        // propósito (mudar isso é risco à parte, fora de escopo) —
        // considerar no futuro checar antes se o índice já existe com a
        // definição certa, pra não reconstruir toda vez.
        try {
          await client`DROP INDEX IF EXISTS recovery_leads_chat_company_phone_unique`
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS recovery_leads_chat_company_phone_unique
            ON recovery_leads (company_id, phone)
            WHERE platform IN ('instagram', 'sac', 'hermes', 'import_planilha')
          `
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(
            '[DB Schema Sync Error] Falha ao criar recovery_leads_chat_company_phone_unique ' +
              '(provável causa: já existe phone duplicado em recovery_leads para o mesmo company_id entre ' +
              "leads de atendimento ou planilha; rode " +
              "\"SELECT company_id, phone, count(*) FROM recovery_leads WHERE platform IN ('instagram','sac','hermes','import_planilha') GROUP BY company_id, phone HAVING count(*) > 1\" " +
              'e resolva as duplicatas (mesclar os leads e as mensagens do lead perdedor no vencedor) antes de tentar de novo):',
            message,
          )
        }

        // ─── SAC Lote 1: Card de contexto, notas, respostas, pendências e auditoria ─
        try {
          await client`ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_agent_key TEXT`

          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS request_summary TEXT`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS request_message_id INTEGER`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS commitment TEXT`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS next_action TEXT`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS human_owner_member_id INTEGER REFERENCES company_members(id) ON DELETE SET NULL`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS next_action_due_at TIMESTAMP`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS sac_case_state TEXT DEFAULT 'aberto'`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS context_version INTEGER DEFAULT 1`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS context_updated_by TEXT`
          await client`ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_control_version INTEGER DEFAULT 1`

          await client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS send_state TEXT DEFAULT 'accepted'`
          await client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS client_request_id TEXT`
          await client`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS send_error TEXT`

          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_company_client_req_unique
            ON whatsapp_messages (company_id, client_request_id)
            WHERE client_request_id IS NOT NULL
          `

          await client`
            CREATE TABLE IF NOT EXISTS sac_internal_notes (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
              author_type TEXT NOT NULL DEFAULT 'human',
              author_id TEXT,
              author_name TEXT,
              body TEXT NOT NULL,
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW(),
              deleted_at TIMESTAMP
            )
          `
          await client`
            CREATE INDEX IF NOT EXISTS sac_internal_notes_company_lead_created_idx
            ON sac_internal_notes (company_id, lead_id, created_at)
          `

          await client`
            CREATE TABLE IF NOT EXISTS sac_approved_replies (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              shortcut TEXT,
              body TEXT NOT NULL,
              variables JSONB,
              approval_state TEXT NOT NULL DEFAULT 'approved',
              version INTEGER NOT NULL DEFAULT 1,
              approved_by TEXT,
              approved_at TIMESTAMP,
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW()
            )
          `
          await client`
            CREATE INDEX IF NOT EXISTS sac_approved_replies_company_state_idx
            ON sac_approved_replies (company_id, approval_state)
          `
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS sac_approved_replies_company_shortcut_unique
            ON sac_approved_replies (company_id, shortcut)
            WHERE shortcut IS NOT NULL
          `

          await client`
            CREATE TABLE IF NOT EXISTS sac_pending_items (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
              rule_type TEXT NOT NULL,
              source_key TEXT NOT NULL,
              reason TEXT NOT NULL,
              human_owner_member_id INTEGER REFERENCES company_members(id) ON DELETE SET NULL,
              due_at TIMESTAMP,
              state TEXT NOT NULL DEFAULT 'pendente',
              created_at TIMESTAMP DEFAULT NOW(),
              resolved_at TIMESTAMP
            )
          `
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS sac_pending_items_company_lead_rule_source_unique
            ON sac_pending_items (company_id, lead_id, rule_type, source_key)
          `
          await client`
            CREATE INDEX IF NOT EXISTS sac_pending_items_company_state_due_idx
            ON sac_pending_items (company_id, state, due_at)
          `

          await client`
            CREATE TABLE IF NOT EXISTS sac_audit_events (
              id SERIAL PRIMARY KEY,
              company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
              lead_id INTEGER REFERENCES recovery_leads(id) ON DELETE CASCADE,
              type TEXT NOT NULL,
              actor_type TEXT NOT NULL,
              actor_id TEXT,
              actor_name TEXT,
              reference_type TEXT,
              reference_id TEXT,
              payload JSONB,
              occurred_at TIMESTAMP DEFAULT NOW()
            )
          `
          await client`
            CREATE INDEX IF NOT EXISTS sac_audit_events_company_lead_occurred_idx
            ON sac_audit_events (company_id, lead_id, occurred_at)
          `
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[DB Schema Sync Error] Falha ao criar infraestrutura SAC Lote 1:', message)
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
