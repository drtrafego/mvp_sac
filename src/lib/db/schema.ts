import { pgTable, serial, integer, bigint, numeric, text, boolean, timestamp, jsonb, uniqueIndex, index, date, time } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

// ─── Empresas (multi-tenant) ──────────────────────────────────────────────────
export const companies = pgTable('companies', {
  id: serial('id').primaryKey(),
  stackAuthUserId: text('stack_auth_user_id').unique(),   // nullable: empresas criadas pelo admin sem usuário vinculado
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  plan: text('plan').default('free'),
  inviteToken: text('invite_token').unique(),              // token para convite de cliente
  // Nome de persona do bot de atendimento desta empresa (ex.: "Clara" pro Dr.
  // Lucas), 22/09/2026. Por padrão vem de public.agents.name no Agents DB. Uma
  // edição manual em Configurações passa a ter precedência sobre o sync; o
  // booleano abaixo registra essa escolha sem confundir nomes sincronizados
  // antigos com overrides do usuário. Nulo = nenhum agente resolvido ainda; a
  // UI cai no fallback genérico "Bot IA" (ver MessageBubble/ChannelBadge/
  // ChatWindow) em vez de quebrar.
  agentDisplayName: text('agent_display_name'),
  agentDisplayNameManual: boolean('agent_display_name_manual').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})

// ─── Configurações (uma por empresa) ─────────────────────────────────────────
export const settings = pgTable('settings', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull().unique(),
  hotmartWebhookToken: text('hotmart_webhook_token').unique(),
  hotmartClientId: text('hotmart_client_id'),
  hotmartClientSecret: text('hotmart_client_secret'),
  greennWebhookToken: text('greenn_webhook_token').unique(),
  greennPublicKey: text('greenn_public_key'),
  greennApiKey: text('greenn_api_key'),
  zoutiWebhookToken: text('zouti_webhook_token').unique(),
  zoutiApiKey: text('zouti_api_key'),
  kiwifyWebhookToken: text('kiwify_webhook_token').unique(),   // segredo do HMAC-SHA1 do webhook Kiwify
  // WhatsApp: meta (oficial) ou uazapi
  whatsappProvider: text('whatsapp_provider').default('meta'),
  metaPhoneNumberId: text('meta_phone_number_id'),
  metaAccessToken: text('meta_access_token'),
  metaVerifyToken: text('meta_verify_token'),
  metaWabaId: text('meta_waba_id'),
  // App Secret da Meta específico desta empresa (quando ela tem o PRÓPRIO app
  // na Meta, não o compartilhado). Nulo = usa o META_APP_SECRET compartilhado
  // do .env (comportamento de hoje). Ver src/lib/meta-signature.ts.
  metaAppSecret: text('meta_app_secret'),
  // Marketing API (Anúncios), DISTINTO do metaAccessToken acima (esse é o
  // token do WhatsApp Cloud API). Token de sistema com escopo ads_read na
  // conta de anúncios do cliente, usado para resolver campanha/conjunto/
  // anúncio (e o url_tags/UTM configurado no anúncio) de um lead a partir do
  // meta_ad_id salvo nele. Porta de META_ACCESS_TOKEN_<slug> do painel antigo
  // (agente_painel/app.py). Nulo = atribuição de anúncio desligada para esta
  // empresa. Ver src/lib/ads-attribution.ts.
  metaAdsAccessToken: text('meta_ads_access_token'),
  metaAdsAccountId: text('meta_ads_account_id'),        // formato act_XXXXXXXXXXXX
  // Conversions API (evento de conversão offline pro Meta, ex.: Purchase de
  // checkout aprovado), 21/09/2026. Pixel ID é ID público (não é segredo, não
  // entra na mask() do GET). Reaproveita metaAdsAccessToken acima como token
  // de envio: a CAPI aceita o mesmo tipo de token de sistema, DESDE QUE o
  // usuário de sistema também esteja atribuído a este Pixel com permissão de
  // escrita (não basta ads_read na conta de anúncios). Se o teste real de
  // envio falhar por permissão, aí sim nasce um metaCapiAccessToken separado.
  // Nulo = envio de conversão desligado para esta empresa. Ver
  // src/lib/meta-conversions-api.ts.
  metaPixelId: text('meta_pixel_id'),
  uazapiBaseUrl: text('uazapi_base_url'),
  uazapiInstanceToken: text('uazapi_instance_token'),
  notificationPhone: text('notification_phone'),
  // Brevo (E-mail transacional e notificações)
  brevoApiKey: text('brevo_api_key'),
  brevoSenderEmail: text('brevo_sender_email'),
  brevoSenderName: text('brevo_sender_name'),
  // Instagram Direct (Meta Graph API)
  instagramUsername: text('instagram_username'),
  instagramAccountId: text('instagram_account_id'),
  instagramAccessToken: text('instagram_access_token'),
  instagramVerifyToken: text('instagram_verify_token'),
  instagramPageId: text('instagram_page_id'),
  // ‼️ 23/09/2026: o app do Instagram (Instagram API with Instagram Login,
  // sem Página do Facebook) tem App ID e App Secret PRÓPRIOS, diferentes do
  // app principal usado pro WhatsApp. O webhook estava usando metaAppSecret
  // (secret do app de WhatsApp) pra validar a assinatura x-hub-signature-256
  // do Instagram, e por isso rejeitava com 401 TODO evento real da Meta
  // (confirmado ao vivo: 401 no exato segundo que uma mensagem real chegou).
  instagramAppSecret: text('instagram_app_secret'),
  // Supabase (Centralização dos Agentes IA)
  supabaseDatabaseUrl: text('supabase_database_url'),
  // Credenciais & Segurança dos Agentes IA (Bia - Amanda & Luana - Gastão)
  agentBiaApiKey: text('agent_bia_api_key'),
  agentLuanaApiKey: text('agent_luana_api_key'),
  agentRenatoApiKey: text('agent_renato_api_key'),
  allowedIps: text('allowed_ips'),
  // Configuração e personalização de colunas do Pipeline
  pipelineColumns: jsonb('pipeline_columns'),
  // Configuração personalizada de menus da barra lateral (visibilidade por cliente/empresa)
  sidebarConfig: jsonb('sidebar_config'),
  // Grade semanal de horário de atendimento da agenda (por dia da semana), fuso e
  // duração do slot. Espelha o agenda_config.json que cada bot Hermes guarda hoje
  // dentro do próprio container (ver agenda_tools.py no painel antigo). Aqui é
  // só a CONFIGURAÇÃO: nenhum bot consome isto ainda (integração é trabalho futuro).
  // Formato: { segunda: { inicio, fim } | null, terca: {...}, quarta: {...},
  // quinta: {...}, sexta: {...}, sabado: {...}, domingo: {...}, timezone,
  // duracaoSlotMinutos }. Dia com valor null = fechado naquele dia.
  availabilitySchedule: jsonb('availability_schedule'),
  // Resposta automática por IA (Nina/Amanda, via ponte da Luana): não é mais o
  // prompt enviado pra API nenhuma (a ponte tem o SOUL dela mesma), sobrou só
  // como o GATE manual: nulo = resposta automática desligada pra essa empresa,
  // preenchido = ligada (ver src/lib/ai-reply.ts).
  aiSystemPrompt: text('ai_system_prompt'),
  updatedAt: timestamp('updated_at').defaultNow(),
})

// ─── Cursores de sincronização incremental dos Agents/CRM ───────────────────
export const syncCursors = pgTable('sync_cursors', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  source: text('source').notNull(),
  sourceKey: text('source_key').notNull(),
  newestSyncedAt: timestamp('newest_synced_at'),
  newestSyncedId: text('newest_synced_id'),
  backfillBeforeAt: timestamp('backfill_before_at'),
  backfillBeforeId: text('backfill_before_id'),
  lastRunAt: timestamp('last_run_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  uniqueIndex('sync_cursors_company_source_key_unique').on(table.companyId, table.source, table.sourceKey),
])

// ─── Espelho somente-leitura da agenda nativa dos agentes ────────────────────────────
// O SAC nunca escreve de volta no schema do bot. nativeId identifica a linha
// na fonte e sourceSyncedAt é o cursor de alteração mantido por ela.
export const appointmentMirror = pgTable('appointment_mirror', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  nativeId: text('native_id').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  phoneNorm: text('phone_norm'),
  consultationAt: timestamp('consultation_at', { withTimezone: true }).notNull(),
  status: text('status').notNull(),
  origin: text('origin'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  sourceSyncedAt: timestamp('source_synced_at', { withTimezone: true }).notNull(),
  mirroredAt: timestamp('mirrored_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('appointment_mirror_company_native_unique').on(table.companyId, table.nativeId),
  index('appointment_mirror_company_phone_idx').on(table.companyId, table.phoneNorm),
  index('appointment_mirror_company_date_idx').on(table.companyId, table.consultationAt),
])

// Espelho somente leitura da grade que o bot realmente usa. A tabela é
// separada de settings.availabilitySchedule de propósito: o valor legado e
// editável do SAC não pode voltar a ser confundido com a fonte operacional.
// O publicador roda no host do bot, lê a fonte nativa sem alterá-la e envia um
// snapshot autenticado. sourceCursor torna cada passe idempotente; syncedAt
// comprova que a fonte continuou acessível mesmo quando a grade não mudou.
export const nativeAvailabilitySchedules = pgTable('native_availability_schedules', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull().unique(),
  schedule: jsonb('schedule').notNull(),
  source: text('source').notNull(),
  sourceLabel: text('source_label').notNull(),
  sourceCursor: text('source_cursor').notNull(),
  capturedAt: timestamp('captured_at').notNull(),
  syncedAt: timestamp('synced_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})

// ─── Espelho operacional das reservas do Gramado Plazza ───────────────────
// A fonte de verdade continua sendo gramadoplazza.reservas no Agents DB. Esta
// tabela guarda o estado mais recente de cada reserva para o SAC exibir sem
// consultar o banco remoto durante a navegação. phone_norm existe apenas para
// resolver a reserva ao recovery_lead correto; nome e telefone cru não são
// replicados. O upsert é idempotente por empresa + reserva_id.
export const gramadoReservations = pgTable('gramado_reservations', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  // FK é criada em ensureSchema(); sem callback aqui porque recoveryLeads é
  // declarado abaixo neste arquivo e a referência antecipada cairia no TDZ.
  leadId: integer('lead_id'),
  reservaId: text('reserva_id').notNull(),
  phoneNorm: text('phone_norm'),
  data: date('data').notNull(),
  horarioReservado: time('horario_reservado'),
  horarioChegada: time('horario_chegada'),
  pessoas: integer('pessoas'),
  valorTotal: numeric('valor_total', { precision: 12, scale: 2 }),
  status: text('status').notNull(),
  observacoes: text('observacoes'),
  mesasUnificadas: boolean('mesas_unificadas'),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('gramado_reservations_company_reserva_unique').on(table.companyId, table.reservaId),
  index('gramado_reservations_lead_idx').on(table.companyId, table.leadId),
  index('gramado_reservations_phone_idx').on(table.companyId, table.phoneNorm),
])

// ─── Sequências de recuperação (uma por tipo por empresa) ─────────────────────
export const recoverySequences = pgTable('recovery_sequences', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  eventType: text('event_type').notNull(),
  isActive: boolean('is_active').default(false),
  name: text('name').notNull(),
  productFilter: text('product_filter'),              // se preenchido, só dispara para este produto (id ou nome)
  upsellMessage: text('upsell_message'),
  upsellDelayMinutes: integer('upsell_delay_minutes').default(1440),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  uniqueIndex('recovery_sequences_company_event_unique').on(table.companyId, table.eventType),
])

// ─── Mensagens da sequência ───────────────────────────────────────────────────
export const sequenceMessages = pgTable('sequence_messages', {
  id: serial('id').primaryKey(),
  sequenceId: integer('sequence_id').references(() => recoverySequences.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
  delayMinutes: integer('delay_minutes').default(0),
  messageType: text('message_type').default('text'),
  content: text('content'),
  mediaUrl: text('media_url'),
  caption: text('caption'),
  buttonsJson: jsonb('buttons_json'),
  // Template Meta (messageType = 'template')
  templateName: text('template_name'),
  templateLanguage: text('template_language').default('pt_BR'),
  templateVariablesMap: jsonb('template_variables_map'), // { "1": "{nome}", "2": "{produto}" }
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
})

// ─── Leads captados via webhook ───────────────────────────────────────────────
export const recoveryLeads = pgTable('recovery_leads', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),

  // Plataforma de origem
  platform: text('platform'),                      // hotmart | greenn | zouti | kiwify

  // Evento
  eventType: text('event_type').notNull(),

  // Contato
  phone: text('phone').notNull(),
  name: text('name'),
  email: text('email'),
  // Metadados do contato no CRM nativo dos agentes. Diferem de productName:
  // company é a empresa do lead e notes são as observações livres do CRM.
  company: text('company'),
  notes: text('notes'),
  cpfCnpj: text('cpf_cnpj'),

  // Localização
  city: text('city'),
  state: text('state'),
  country: text('country'),
  zipcode: text('zipcode'),

  // Produto
  productId: text('product_id'),
  productName: text('product_name'),
  productValue: integer('product_value'),           // em centavos

  // Transação
  transactionId: text('transaction_id'),
  paymentType: text('payment_type'),                // boleto | pix | credit_card | debit_card | paypal
  installments: integer('installments'),

  // Boleto
  boletoCode: text('boleto_code'),
  boletoUrl: text('boleto_url'),
  boletoExpiry: timestamp('boleto_expiry'),

  // PIX
  pixCode: text('pix_code'),
  pixExpiry: timestamp('pix_expiry'),

  // Checkout
  checkoutUrl: text('checkout_url'),                // link de retomada do checkout (carrinho abandonado)

  // Rastreamento
  trackingSource: text('tracking_source'),          // utm_source
  trackingSourceSck: text('tracking_source_sck'),   // sck (Hotmart)
  trackingExternalCode: text('tracking_external_code'), // external_code (Hotmart)
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  utmContent: text('utm_content'),
  utmTerm: text('utm_term'),
  utmPlacement: text('utm_placement'),
  // Nomes resolvidos do referral Click-to-WhatsApp. IDs Meta continuam nos
  // campos abaixo; estes nomes preservam exatamente o que o usuário precisa
  // enxergar no SAC sem depender de uma nova chamada à Marketing API.
  adsetName: text('adset_name'),
  adName: text('ad_name'),
  metaCampaignId: text('meta_campaign_id'),
  metaAdsetId: text('meta_adset_id'),
  metaAdId: text('meta_ad_id'),

  // Afiliado
  affiliateCode: text('affiliate_code'),
  commissionValue: integer('commission_value'),     // em centavos

  // Datas
  orderDate: timestamp('order_date'),
  approvedDate: timestamp('approved_date'),

  // Orderbump
  isOrderBump: boolean('is_order_bump').default(false),

  // Status e payload bruto
  rawPayload: jsonb('raw_payload'),
  status: text('status').default('pending'),
  priority: integer('priority').default(0),           // Fase 3.2: 3=cartao_recusado, 2=boleto, 1=carrinho, 0=aprovada
  convertedByJobId: integer('converted_by_job_id'),   // Fase 2: qual job desencadeou a conversão
  convertedFrom: text('converted_from'),               // Fase 2: "msg_N" para rastrear posição da mensagem

  // Canal e controle de atendimento / bot de IA
  channel: text('channel').default('whatsapp'),       // whatsapp | instagram | email | mineracao
  botPaused: boolean('bot_paused').default(false),    // true se o atendente humano pausou o bot para assumir
  botPausedAt: timestamp('bot_paused_at'),
  botPausedBy: text('bot_paused_by'),
  botPausedAll: boolean('bot_paused_all').default(false), // true só quando o PAUSAR TUDO da empresa foi quem pausou este lead.
  botPausedChannel: text('bot_paused_channel'), // 'whatsapp' | 'instagram' | 'email' quando uma pausa em massa por canal pausou este lead.

  // Estado do gate de seguidor do Instagram Comment-to-DM (24/09/2026, ver
  // comentário completo em instagramCommentAutomations.requireFollowCheck).
  // Não-nulo = este lead está no meio do fluxo de 2 mensagens de UMA
  // automação específica (aguardando a pessoa responder pra checar
  // is_user_follow_business de verdade via Graph API). O webhook inbound do
  // Instagram (src/app/api/webhooks/instagram/route.ts e [slug]/route.ts)
  // testa este campo (E !botPaused, ver comentário lá) ANTES de decidir se a
  // mensagem cai no generateAndSendAiReply normal: se estiver pendente, a
  // mensagem vai pro handleFollowCheckReply (src/lib/instagram-comment-processor.ts)
  // em vez da IA, pra não ter duas respostas conflitantes pro mesmo lead na
  // mesma mensagem. Fica null quando o lead nunca entrou no fluxo, quando a
  // Graph API confirma que a pessoa segue e o dmMessage real é liberado, ou
  // quando pendingFollowCheckAttempts estoura o limite (gate desiste, ver
  // comentário abaixo).
  // Só UM fluxo pendente por vez (modelagem mais simples que cobre o caso
  // real: se a pessoa comentar em dois posts com automações diferentes que
  // exigem seguir, a última pergunta é a que vale, decisão de produto
  // documentada aqui em vez de espalhada por uma tabela nova).
  // FIX CRÍTICO de QA (24/09/2026, 2ª rodada): processInstagramComment só
  // pode ESCREVER este campo quando a automação que casou o comentário TEM
  // requireFollowCheck=true. Antes do fix, qualquer automação (inclusive uma
  // SEM o flag) sobrescrevia isto pra null sempre que casava um comentário
  // novo da mesma pessoa, e derrubava silenciosamente um gate pendente de
  // OUTRA automação (comentar depois em post B sem o flag apagava a espera
  // do post A com o flag, e a resposta seguinte da pessoa confirmando A caía
  // direto na IA normal, nunca liberando o conteúdo de A).
  pendingFollowCheckAutomationId: integer('pending_follow_check_automation_id').references(() => instagramCommentAutomations.id, { onDelete: 'set null' }),

  // Quantas vezes a pessoa respondeu SEM confirmar que segue, dentro do
  // fluxo pendente acima. FIX ALTO de QA (24/09/2026, 2ª rodada): sem
  // limite, handleFollowCheckReply repetia "segue lá" pra sempre, mesmo se a
  // pessoa decidiu não seguir mas queria falar de outra coisa (sequestro de
  // conversa sem saída). Ao atingir MAX_FOLLOW_CHECK_ATTEMPTS (ver
  // src/lib/instagram-comment-processor.ts), o gate desiste: zera este
  // campo e o campo acima, grava uma nota em `notes` (CRM nativo do lead) e
  // devolve a mensagem pro fluxo normal de generateAndSendAiReply. Zerado
  // (não incrementado) toda vez que um NOVO ciclo do gate começa.
  pendingFollowCheckAttempts: integer('pending_follow_check_attempts').default(0),

  // Follow-up, Lembretes e Etapa do Pipeline
  followUpDate: timestamp('follow_up_date'),
  followUpNote: text('follow_up_note'),
  pipelineStage: text('pipeline_stage'),

  // Rastreamento de Agente IA (Luana / Renato / Humano)
  responsibleAgent: text('responsible_agent'),         // 'Luana' | 'Renato'
  lastActionBy: text('last_action_by'),                 // 'Luana (Agente IA)' | 'Renato (Agente IA)'
  lastActionAt: timestamp('last_action_at').defaultNow(),

  // Abordagem real: preenchido só quando a PRIMEIRA mensagem de verdade (inbound
  // ou outbound) é trocada com o lead. Nulo = lead existe no banco mas nunca foi
  // contatado, e por isso não entra nas contagens principais do dashboard.
  firstContactAt: timestamp('first_contact_at'),

  // Estado de agendamento da IA (Fase 1, espelha o state.json por lead que o
  // receiver.py da Nina já mantém): { eventId?, start?, end?, nome?, email?,
  // pendingStart?, pendingEnd?, pendingNome? }. É o que permite RESCHEDULE/CANCEL
  // saberem qual reunião mexer sem o modelo precisar saber o id.
  aiScheduleState: jsonb('ai_schedule_state'),

  // Lock otimista por lead durante a geração da resposta automática de IA
  // (21/09/2026, plano de migração Dr. Lucas/Gramado, seção 3): sem isto,
  // duas mensagens do mesmo lead em sequência rápida disparam duas chamadas
  // concorrentes de generateAndSendAiReply pro MESMO lead (resposta fora de
  // ordem, ou pior quando a ferramenta de agenda entrar em cena: duas
  // execuções de reserva na mesma sessão). Preenchido = alguém está gerando
  // resposta pra este lead agora; nulo = livre. O timeout de 3 minutos (ver
  // src/lib/ai-reply.ts) é rede de segurança contra processo morto no meio
  // (função da Vercel derrubada por timeout) sem exigir liberação explícita.
  aiReplyLockAt: timestamp('ai_reply_lock_at'),

  // Metadados da conversa nativa do Hermes. Ficam no painel de auditoria do
  // Inbox e não na lista principal, para não poluir o atendimento.
  agentConversationId: text('agent_conversation_id'),
  agentCostUsd: numeric('agent_cost_usd', { precision: 18, scale: 8 }),
  agentInputTokens: bigint('agent_input_tokens', { mode: 'number' }),
  agentOutputTokens: bigint('agent_output_tokens', { mode: 'number' }),
  agentSyncedAt: timestamp('agent_synced_at', { withTimezone: true }),

  // Tags estruturadas de mineração (21/09/2026): classificação/segmentação do
  // lead vinda do lado do minerador, via sync-agents.ts (Agents DB
  // intermediário, CRM_DATABASE_URL). TODOS os campos são opcionais porque o
  // dado real tem lacuna e o sync precisa ser resiliente a fonte incompleta:
  //   origem: já 100% preenchido no minerador (source: google_places |
  //     instagram | linkedin | manual), só herdado/copiado pro lead aqui.
  //   nicho: promovido do nível da mineração (minings.niche) pro lead.
  //   temperatura: hot | cold | warm; 9% dos leads (4.474 de 49.785) não têm
  //     valor no minerador, por isso nullable também aqui.
  //   statusRelacionamento: campo NOVO, introduzido pelo SAC. Não existe
  //     centralizado no minerador hoje (só fragmentado por campanha, 8,6% de
  //     cobertura), por isso nasce vazio pra 91,4% dos leads.
  miningTags: jsonb('mining_tags').$type<{
    origem?: string
    nicho?: string
    temperatura?: string
    statusRelacionamento?: string
    emailEngagement?: {
      funnelStatus: string
      lastEventType: string
      everOpened: boolean
      everBounced: boolean
      everUnsubscribed: boolean
      lastEventAt: string
      lastStep: number | null
      totalEventsCount: number
      syncedAt: string
    }
  }>(),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
  // Idempotência: a plataforma reenvia o mesmo evento (retry/POST duplo) e isso
  // gerava leads duplicados que inflavam a contagem de vendas. Inclui event_type
  // de propósito para que boleto/pix e a compra aprovada do mesmo pedido coexistam,
  // mas dois eventos idênticos do mesmo pedido colidam. Parcial: só onde há transação.
  uniqueIndex('recovery_leads_txn_dedup_unique')
    .on(table.companyId, table.platform, table.transactionId, table.eventType)
    .where(sql`${table.transactionId} is not null`),

  // Idempotência dos webhooks de ATENDIMENTO (Instagram Direct, WhatsApp SAC
  // e Hermes/reserva confirmada, platform IN ('instagram','sac','hermes')):
  // SELECT-então-INSERT sem lock deixava uma corrida entre requisições
  // concorrentes com o mesmo telefone novo, e cada uma criava um lead
  // próprio, fragmentando a conversa do cliente em vários cards no Inbox
  // (provado pelo QA ao vivo, 2ª rodada: 10 requisições concorrentes com
  // telefone novo e mesmo mid → 6 leads distintos). 'hermes' foi adicionado
  // em 22/09/2026 (QA reproduziu o mesmo bug ao vivo no webhook de conversão
  // do Hermes: 2 requisições concorrentes com telefone novo → 2 leads),
  // migration drizzle/0010_recovery_leads_hermes_dedup.sql. Parcial e
  // restrito a platform IN ('instagram','sac','hermes') de propósito: os
  // webhooks de VENDA (hotmart/greenn/zouti/kiwify, platform nesses valores)
  // criam MÚLTIPLAS linhas legítimas para o mesmo company_id+phone (um lead
  // por transação/evento, ver recovery_leads_txn_dedup_unique acima) e um
  // índice único geral em (company_id, phone) quebraria esse fluxo. phone é
  // NOT NULL, então não precisa de "IS NOT NULL" na condição parcial.
  //
  // ⚠️ Qualquer INSERT com onConflictDoUpdate/onConflictDoNothing que usa
  // este índice como arbiter (webhooks whatsapp/instagram/instagram-[slug]/
  // hermes) precisa que o `targetWhere`/`where` da query bata EXATAMENTE com
  // esta condição parcial (Postgres exige o predicado casar com o índice pra
  // inferir o arbiter em ON CONFLICT). Mudou aqui? Muda nos 4 lugares.
  uniqueIndex('recovery_leads_chat_company_phone_unique')
    .on(table.companyId, table.phone)
    .where(sql`${table.platform} in ('instagram', 'sac', 'hermes')`),
])

// ─── Fila de mensagens agendadas ─────────────────────────────────────────────
export const messageJobs = pgTable('message_jobs', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').references(() => recoveryLeads.id, { onDelete: 'cascade' }),
  messageId: integer('message_id').references(() => sequenceMessages.id, { onDelete: 'set null' }),
  upsellContent: text('upsell_content'),
  scheduledFor: timestamp('scheduled_for').notNull(),
  sentAt: timestamp('sent_at'),
  status: text('status').default('pending'),
  error: text('error'),
  checkBeforeSend: boolean('check_before_send').default(false),
  externalWamid: text('external_wamid'),               // Fase 1.4: WAMID retornado pela Meta ao enviar
  deliveryStatus: text('delivery_status'),              // Fase 1.4: sent | delivered | read | failed
  messageOrder: integer('message_order'),               // Fase 2.3: posição da mensagem na sequência
})

// ─── Tags de Leads ────────────────────────────────────────────────────────────
export const leadTags = pgTable('lead_tags', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').references(() => recoveryLeads.id, { onDelete: 'cascade' }).notNull(),
  tag: text('tag').notNull(),
  scopeChannel: text('scope_channel'), // null = geral; 'whatsapp' | 'instagram' | 'email' | 'mineracao'
  createdBy: text('created_by'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  uniqueIndex('lead_tags_lead_tag_scope_unique').on(table.leadId, table.tag, table.scopeChannel),
  index('lead_tags_lead_idx').on(table.leadId),
])

// ─── Histórico de mensagens WhatsApp / Instagram / E-mail ────────────────────
export const whatsappMessages = pgTable('whatsapp_messages', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  leadId: integer('lead_id').references(() => recoveryLeads.id, { onDelete: 'set null' }),
  phone: text('phone').notNull(),
  channel: text('channel').default('whatsapp'), // 'whatsapp' | 'instagram' | 'email'
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
  content: text('content'),
  messageType: text('message_type').default('text'),
  mediaUrl: text('media_url'),
  sentBy: text('sent_by').default('system'), // 'system' | 'human' | 'bot'
  senderName: text('sender_name'),          // 'Luana' | 'Renato' | 'Amanda Felix'
  agentId: text('agent_id'),                // 'luana' | 'renato'
  externalId: text('external_id'),
  reasoning: text('reasoning'),
  sentEmail: text('sent_email'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  // Cursor do histórico aberto: os dois índices deixam o Postgres buscar só
  // PAGE_SIZE+1 linhas, tanto para mensagens ligadas ao lead quanto para as
  // importadas pelo telefone antes da associação local existir.
  index('whatsapp_messages_company_lead_created_id_idx')
    .on(table.companyId, table.leadId, table.createdAt, table.id),
  index('whatsapp_messages_company_phone_created_id_idx')
    .on(table.companyId, table.phone, table.createdAt, table.id),
  // Idempotência contra reentrega de webhook da Meta (comportamento real e
  // documentado dela, não hipotético): sem isso, o mesmo evento reentregue
  // grava duas linhas inbound iguais e o generateAndSendAiReply() dispara
  // DUAS respostas reais pro mesmo cliente pra mesma mensagem.
  // Segunda camada: a primeira é o SELECT em src/lib/webhook-dedup.ts antes
  // do insert, que não fecha corrida entre duas requisições concorrentes.
  // Restrita a direction='inbound' porque external_id também é usado em
  // mensagens outbound (resposta manual do Inbox, DM de comentário, sync de
  // outros agentes), que têm semântica diferente e não devem colidir aqui.
  //
  // Inclui company_id (achado do QA, 2ª rodada, severidade MÉDIA): antes o
  // índice era só (channel, external_id), e isInboundMessageAlreadyProcessed()
  // em src/lib/webhook-dedup.ts já checa companyId + externalId + direction,
  // então havia um descompasso teórico entre a checagem em código (por
  // empresa) e a trava do banco (global por canal): uma empresa mal
  // configurada compartilhando phone_number_id/instagram_account_id com
  // outra (cenário já visto neste projeto) poderia ter uma mensagem legítima
  // descartada como "duplicada" de outra empresa. Renomeado de propósito
  // (whatsapp_messages_inbound_external_id_unique → …_company_channel_…):
  // "CREATE UNIQUE INDEX IF NOT EXISTS" com o mesmo nome não teria recriado
  // o índice em produção com a composição nova (ver src/lib/db/index.ts).
  uniqueIndex('whatsapp_messages_inbound_company_channel_external_id_unique')
    .on(table.companyId, table.channel, table.externalId)
    .where(sql`${table.externalId} is not null and ${table.direction} = 'inbound'`),
])

// ─── Log de atividades dos agentes IA (Luana e Renato) ─────────────────────────
export const agentActivityLogs = pgTable('agent_activity_logs', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  agentName: text('agent_name').notNull(),  // 'Luana' | 'Renato' | 'Master' | 'Humano'
  agentId: text('agent_id'),                // 'luana' | 'renato'
  action: text('action').notNull(),         // 'create_lead' | 'update_stage' | 'schedule_followup' | 'send_message' | 'pause_bot'
  entityType: text('entity_type').notNull(),// 'lead' | 'message' | 'settings' | 'company'
  entityId: text('entity_id'),
  details: jsonb('details'),
  createdAt: timestamp('created_at').defaultNow(),
})

// ─── Log de webhooks recebidos (debug Hotmart/Greenn/Zouti/Kiwify) ───────────
export const webhookReceived = pgTable('webhook_received', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  slug: text('slug'),
  source: text('source').default('hotmart'),    // hotmart | greenn | zouti | kiwify
  event: text('event'),
  processed: boolean('processed').default(false),
  skipReason: text('skip_reason'),
  errorMessage: text('error_message'),
  leadId: integer('lead_id'),
  rawBody: jsonb('raw_body'),
  headers: jsonb('headers'),
  receivedAt: timestamp('received_at').defaultNow(),
})

// ─── Log de envio da Meta Conversions API (irmão de saída do webhook_received) ─
// webhookReceived audita ENTRADA (webhook de compra chegando). Esta tabela
// audita SAÍDA (evento de conversão saindo pro Meta), 21/09/2026. Sem isso não
// tem como provar "todo lead que fechou mandou evento pro Meta", nem retentar
// falha de rede/token sem reenviar o que já foi aceito. eventId é o mesmo
// event_id que vai no payload da Graph API: uniqueIndex garante que o mesmo
// evento de negócio (ex.: purchase_<transactionId>) nunca é mandado duas
// vezes por esta tabela, mesmo com retry.
export const metaConversionEvents = pgTable('meta_conversion_events', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  leadId: integer('lead_id').references(() => recoveryLeads.id, { onDelete: 'set null' }), // nullable: pode falhar antes de resolver o lead
  eventName: text('event_name').notNull(),          // 'Purchase' (checkout) | 'Schedule' (reserva/agendamento, futuro)
  eventId: text('event_id').notNull(),              // vai em data[].event_id na Graph API, chave de dedup
  pixelId: text('pixel_id'),
  status: text('status').default('pending').notNull(), // 'pending' | 'sent' | 'failed' | 'skipped' | 'expired_token'
  httpStatus: integer('http_status'),
  metaResponse: jsonb('meta_response'),             // resposta crua da Graph API (sucesso ou erro), auditoria
  errorMessage: text('error_message'),
  attempts: integer('attempts').default(0).notNull(),
  nextRetryAt: timestamp('next_retry_at'),          // usado pelo cron de retry (ainda não implementado)
  createdAt: timestamp('created_at').defaultNow(),
  sentAt: timestamp('sent_at'),
}, (table) => [
  uniqueIndex('meta_conversion_events_company_event_unique').on(table.companyId, table.eventId),
])

// ─── Membros da empresa ───────────────────────────────────────────────────────
export const companyMembers = pgTable('company_members', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  stackAuthUserId: text('stack_auth_user_id'),
  email: text('email').notNull(),
  name: text('name'),
  role: text('role').default('admin').notNull(),   // 'admin' | 'membro'
  inviteToken: text('invite_token').unique(),
  status: text('status').default('pending').notNull(), // 'pending' | 'ativo'
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})

// ─── Automações de Comentário vira DM (Instagram Comment-to-DM) ─────────────
export const instagramCommentAutomations = pgTable('instagram_comment_automations', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  mediaId: text('media_id'),                               // null = qualquer post/reel da conta
  mediaUrl: text('media_url'),
  mediaCaption: text('media_caption'),
  keywords: text('keywords'),                             // palavras separadas por vírgula ("QUERO, PREÇO")
  matchType: text('match_type').default('contains').notNull(), // 'contains' | 'exact' | 'any'
  dmMessage: text('dm_message').notNull(),                // texto enviado no Direct
  publicReply: text('public_reply'),                      // resposta pública no comentário (opcional)
  hideCommentAfterReply: boolean('hide_comment_after_reply').default(false),
  activeHoursStart: text('active_hours_start'),           // ex: "08:00"
  activeHoursEnd: text('active_hours_end'),               // ex: "22:00"
  isActive: boolean('is_active').default(true),
  // ─── Gate de seguidor (24/09/2026) ─────────────────────────────────────
  // Opt-in POR AUTOMAÇÃO, default false = comportamento de sempre (manda o
  // dmMessage direto). Quando true, processInstagramComment (ver
  // src/lib/instagram-comment-processor.ts) manda uma PERGUNTA INTERMEDIÁRIA
  // em vez do dmMessage, marca recoveryLeads.pendingFollowCheckAutomationId
  // com o id desta automação, e só libera o dmMessage de verdade quando a
  // pessoa responder E a Instagram User Profile API confirmar
  // is_user_follow_business=true (ver checkInstagramUserFollowsBusiness em
  // src/lib/instagram.ts). Pedido do Gastão depois de ver um bot de terceiro
  // fazer essa checagem real (ele testou mentir "já sigo" sem seguir de
  // verdade, e o bot pegou a mentira): tem que ser verificação real via API,
  // nunca um botão de honra sem checagem.
  requireFollowCheck: boolean('require_follow_check').default(false),
  totalTriggered: integer('total_triggered').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})

export const instagramCommentLogs = pgTable('instagram_comment_logs', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  automationId: integer('automation_id').references(() => instagramCommentAutomations.id, { onDelete: 'cascade' }),
  commentId: text('comment_id').notNull(),
  commenterId: text('commenter_id').notNull(),
  commenterUsername: text('commenter_username'),
  mediaId: text('media_id'),
  commentText: text('comment_text'),
  matchedKeyword: text('matched_keyword'),
  status: text('status').notNull(),                       // 'sent' | 'failed' | 'skipped' | 'rate_limited'
  errorMessage: text('error_message'),
  sentAt: timestamp('sent_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  uniqueIndex('instagram_comment_logs_comment_unique').on(table.companyId, table.commentId),
  uniqueIndex('instagram_comment_logs_user_media_unique').on(table.automationId, table.commenterId, table.mediaId),
])

// ─── Bloqueios de agenda por data (férias, congresso, feriado) ───────────────
// Espelha o comando `bloquear <data> [motivo]` do agenda_tools.py do painel
// antigo (roda dentro do container Hermes de cada bot). Aqui é só a
// CONFIGURAÇÃO ficando salva no banco do SAC: nenhum bot consulta isto ainda,
// a integração ("o bot pergunta ao SAC antes de oferecer horário") é trabalho
// futuro, fora do escopo desta tarefa.
// 22/09/2026: a tela de Agenda do Dr. Lucas (company_id=3, slug 'drlucas')
// passou a refletir o Google Calendar real dele além do bloqueio manual e do
// bloqueio gravado pelo bot via WhatsApp (Hermes). `source` diz de onde veio
// cada linha: 'manual' (padrão, criado pela tela ou pelo comando antigo),
// 'google_calendar' (evento de dia inteiro lido do Calendar), 'bot_bloqueios'
// (gravado pelo bot Hermes via WhatsApp, fora desta tarefa) ou o valor
// combinado 'google_calendar+bot_bloqueios' quando as duas fontes bloquearam
// a mesma data. `externalRef` guarda o id do evento do Google (só quando
// source inclui 'google_calendar'); `syncedAt` é a última vez que uma fonte
// EXTERNA confirmou a linha (fica null pra 'manual', que não tem fonte externa).
//
// FIX de QA (bug ALTO, 22/09/2026): `reason` era concatenado e sobrescrito
// diretamente a cada sync, e a 2ª rodada apagava a parte do bot mesmo sem
// nada mudar do lado dele. `reason` deixou de ser fonte de verdade e virou
// campo CALCULADO a cada escrita: `[botReason, googleReason].filter(Boolean)
// .join('; ')`. `botReason` guarda só o texto vindo do bot (bot_bloqueios,
// nunca tocado por escrita que só veio do Google) e `googleReason` guarda só
// o texto vindo do Google Calendar (nunca tocado por escrita que só veio do
// bot). Ver src/lib/google-calendar-sync.ts para a lógica de upsert e o
// fallback de compatibilidade com o script Hermes (fora deste repo) que
// ainda escreve direto em `reason`.
export const agendaBlockedDates = pgTable('agenda_blocked_dates', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  date: date('date', { mode: 'string' }).notNull(),   // 'YYYY-MM-DD', sem timestamp: bloqueio é o dia inteiro
  reason: text('reason'),                              // CALCULADO: ver comentário acima, nunca escrever por concatenação manual
  botReason: text('bot_reason'),                        // só o texto vindo do bot (bot_bloqueios), preservado entre syncs do Google
  googleReason: text('google_reason'),                  // só o texto vindo do Google Calendar, recalculado a cada sync
  source: text('source').notNull().default('manual'), // 'manual' | 'google_calendar' | 'bot_bloqueios' | 'google_calendar+bot_bloqueios'
  externalRef: text('external_ref'),                   // id do evento do Google, só quando source inclui 'google_calendar'
  syncedAt: timestamp('synced_at'),                     // última confirmação pela fonte externa; null quando source = 'manual'
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  // Não faz sentido bloquear a mesma data duas vezes para a mesma empresa.
  uniqueIndex('agenda_blocked_dates_company_date_unique').on(table.companyId, table.date),
])

// ─── Rate limit local da ponte de IA (Nina/Amanda, ver src/lib/ai/ai-bridge.ts) ─
// Contagem GLOBAL, não por empresa: o serviço do outro lado (claude -p) é
// single-thread e compartilha fila com o atendimento REAL do WhatsApp de
// produção. Cada linha é uma tentativa de chamada (sucesso ou não).
export const aiBridgeCalls = pgTable('ai_bridge_calls', {
  id: serial('id').primaryKey(),
  status: text('status').notNull(), // 'em_andamento' | status HTTP como texto | 'excecao'
  createdAt: timestamp('created_at').defaultNow(),
})

// ─── Relations ────────────────────────────────────────────────────────────────
export const companiesRelations = relations(companies, ({ one, many }) => ({
  settings: one(settings, { fields: [companies.id], references: [settings.companyId] }),
  syncCursors: many(syncCursors),
  gramadoReservations: many(gramadoReservations),
  sequences: many(recoverySequences),
  leads: many(recoveryLeads),
  whatsappMessages: many(whatsappMessages),
  members: many(companyMembers),
  commentAutomations: many(instagramCommentAutomations),
  commentLogs: many(instagramCommentLogs),
  agendaBlockedDates: many(agendaBlockedDates),
  metaConversionEvents: many(metaConversionEvents),
}))

export const settingsRelations = relations(settings, ({ one }) => ({
  company: one(companies, { fields: [settings.companyId], references: [companies.id] }),
}))

export const syncCursorsRelations = relations(syncCursors, ({ one }) => ({
  company: one(companies, { fields: [syncCursors.companyId], references: [companies.id] }),
}))

export const recoverySequencesRelations = relations(recoverySequences, ({ one, many }) => ({
  company: one(companies, { fields: [recoverySequences.companyId], references: [companies.id] }),
  messages: many(sequenceMessages),
}))

export const sequenceMessagesRelations = relations(sequenceMessages, ({ one }) => ({
  sequence: one(recoverySequences, { fields: [sequenceMessages.sequenceId], references: [recoverySequences.id] }),
}))

export const recoveryLeadsRelations = relations(recoveryLeads, ({ one, many }) => ({
  company: one(companies, { fields: [recoveryLeads.companyId], references: [companies.id] }),
  jobs: many(messageJobs),
  messages: many(whatsappMessages),
  gramadoReservations: many(gramadoReservations),
  tags: many(leadTags),
}))

export const leadTagsRelations = relations(leadTags, ({ one }) => ({
  lead: one(recoveryLeads, { fields: [leadTags.leadId], references: [recoveryLeads.id] }),
}))

export const gramadoReservationsRelations = relations(gramadoReservations, ({ one }) => ({
  company: one(companies, { fields: [gramadoReservations.companyId], references: [companies.id] }),
  lead: one(recoveryLeads, { fields: [gramadoReservations.leadId], references: [recoveryLeads.id] }),
}))

export const messageJobsRelations = relations(messageJobs, ({ one }) => ({
  lead: one(recoveryLeads, { fields: [messageJobs.leadId], references: [recoveryLeads.id] }),
  message: one(sequenceMessages, { fields: [messageJobs.messageId], references: [sequenceMessages.id] }),
}))

export const whatsappMessagesRelations = relations(whatsappMessages, ({ one }) => ({
  company: one(companies, { fields: [whatsappMessages.companyId], references: [companies.id] }),
  lead: one(recoveryLeads, { fields: [whatsappMessages.leadId], references: [recoveryLeads.id] }),
}))

export const companyMembersRelations = relations(companyMembers, ({ one }) => ({
  company: one(companies, { fields: [companyMembers.companyId], references: [companies.id] }),
}))

export const metaConversionEventsRelations = relations(metaConversionEvents, ({ one }) => ({
  company: one(companies, { fields: [metaConversionEvents.companyId], references: [companies.id] }),
  lead: one(recoveryLeads, { fields: [metaConversionEvents.leadId], references: [recoveryLeads.id] }),
}))

export const instagramCommentAutomationsRelations = relations(instagramCommentAutomations, ({ one, many }) => ({
  company: one(companies, { fields: [instagramCommentAutomations.companyId], references: [companies.id] }),
  logs: many(instagramCommentLogs),
}))

export const instagramCommentLogsRelations = relations(instagramCommentLogs, ({ one }) => ({
  company: one(companies, { fields: [instagramCommentLogs.companyId], references: [companies.id] }),
  automation: one(instagramCommentAutomations, { fields: [instagramCommentLogs.automationId], references: [instagramCommentAutomations.id] }),
}))

export const agendaBlockedDatesRelations = relations(agendaBlockedDates, ({ one }) => ({
  company: one(companies, { fields: [agendaBlockedDates.companyId], references: [companies.id] }),
}))
