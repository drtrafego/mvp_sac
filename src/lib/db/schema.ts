import { pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

// ─── Empresas (multi-tenant) ──────────────────────────────────────────────────
export const companies = pgTable('companies', {
  id: serial('id').primaryKey(),
  stackAuthUserId: text('stack_auth_user_id').unique(),   // nullable: empresas criadas pelo admin sem usuário vinculado
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  plan: text('plan').default('free'),
  inviteToken: text('invite_token').unique(),              // token para convite de cliente
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
  // Supabase (Centralização dos Agentes IA)
  supabaseDatabaseUrl: text('supabase_database_url'),
  updatedAt: timestamp('updated_at').defaultNow(),
})

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

  // Follow-up, Lembretes e Etapa do Pipeline
  followUpDate: timestamp('follow_up_date'),
  followUpNote: text('follow_up_note'),
  pipelineStage: text('pipeline_stage'),

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
  createdAt: timestamp('created_at').defaultNow(),
})

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
  externalId: text('external_id'),
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

// ─── Relations ────────────────────────────────────────────────────────────────
export const companiesRelations = relations(companies, ({ one, many }) => ({
  settings: one(settings, { fields: [companies.id], references: [settings.companyId] }),
  sequences: many(recoverySequences),
  leads: many(recoveryLeads),
  whatsappMessages: many(whatsappMessages),
  members: many(companyMembers),
}))

export const settingsRelations = relations(settings, ({ one }) => ({
  company: one(companies, { fields: [settings.companyId], references: [companies.id] }),
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
