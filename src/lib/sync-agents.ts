import { db } from '@/lib/db'
import { companies, settings, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { queryAgentsDb, getAgentsDbUrl } from '@/lib/db/agents-db'
import { eq, and, or, sql } from 'drizzle-orm'

export interface AgentDbRow {
  id: string
  organization_id: string
  org_slug?: string
  org_name?: string
  slug: string
  schema_name: string
  name: string
  meta_phone_number_id?: string | null
  meta_waba_id?: string | null
  meta_token_env?: string | null
}

export interface ConversationDbRow {
  session_id: string
  chat_id: string | null
  channel?: string | null
  title: string | null
  started_at?: string | null
  ended_at?: string | null
  message_count?: number | null
}

export interface MessageDbRow {
  id: string | number
  session_id: string
  role: string
  content: string | null
  ts?: string | null
  platform_message_id?: string | null
}

export interface OutreachConvoDbRow {
  id: string
  agent_slug: string
  channel: string | null
  source: string | null
  lead_name: string | null
  lead_handle: string | null
  lead_company: string | null
  status: string | null
  last_at: string | null
  msg_count?: number | null
}

export interface OutreachMsgDbRow {
  id: string
  convo_id: string
  direction: string | null
  status: string | null
  subject: string | null
  body: string | null
  sent_at: string | null
}

export interface CtwaReferralDbRow {
  phone_norm: string
  campaign_name: string | null
  ad_name: string | null
}

export interface MetaLeadDbRow {
  phone_norm: string
  full_name: string | null
  email: string | null
  campaign_name: string | null
  ad_name: string | null
  platform?: string | null
}

export interface SyncReport {
  ok: boolean
  message: string
  agentsFound: number
  companiesCreated: number
  leadsCreated: number
  messagesImported: number
  details: string[]
  dbUrlUsed?: string | null
}

function normalizeDigits(val: string | null | undefined): string {
  if (!val) return ''
  return val.replace(/\D/g, '')
}

export async function syncAgentsAndCompanies(): Promise<SyncReport> {
  const details: string[] = []
  let companiesCreated = 0
  let leadsCreated = 0
  let messagesImported = 0

  const dbUrl = await getAgentsDbUrl()
  const dbUrlMasked = dbUrl ? dbUrl.replace(/:[^:@]+@/, ':****@') : 'Não configurado'

  // 1. Garante imediatamente as empresas principais no banco de dados local
  const defaultCompanies = [
    { name: 'Casal do Tráfego', slug: 'casaldotrafego' },
    { name: 'Gastão Matos', slug: 'gastao-matos' },
    { name: 'Gramado Plaza', slug: 'gramado-plaza' },
    { name: 'Dr. Lucas', slug: 'drlucas' },
  ]

  const companyMap = new Map<string, typeof companies.$inferSelect>()

  for (const def of defaultCompanies) {
    let [comp] = await db.select().from(companies).where(eq(companies.slug, def.slug)).limit(1)
    if (!comp) {
      const [created] = await db
        .insert(companies)
        .values({ name: def.name, slug: def.slug, plan: 'pro' })
        .returning()
      comp = created
      companiesCreated++
      details.push(`Empresa "${def.name}" (${def.slug}) criada.`)
    }
    companyMap.set(def.slug, comp)

    // Garante settings
    const [st] = await db.select().from(settings).where(eq(settings.companyId, comp.id)).limit(1)
    if (!st) {
      await db.insert(settings).values({ companyId: comp.id, whatsappProvider: 'meta' }).onConflictDoNothing()
    }
  }

  // 2. Busca agentes na tabela public.agents do Supabase / Neon de agentes
  const agents = await queryAgentsDb<AgentDbRow>(`
    select a.id, a.organization_id, o.slug as org_slug, o.name as org_name,
           a.slug, a.schema_name, a.name, a.meta_phone_number_id, a.meta_waba_id, a.meta_token_env
    from public.agents a
    left join public.organizations o on o.id = a.organization_id
    where a.active = true
    order by o.slug, a.slug
  `)

  if (!agents || agents.length === 0) {
    return {
      ok: false,
      message: `Nenhum agente ativo encontrado na base (${dbUrlMasked}). Verifique a string de conexão.`,
      agentsFound: 0,
      companiesCreated,
      leadsCreated,
      messagesImported,
      details: [
        ...details,
        `Tentativa de conexão com: ${dbUrlMasked}`,
      ],
      dbUrlUsed: dbUrlMasked,
    }
  }

  details.push(`Encontrados ${agents.length} agentes ativos no catálogo Supabase/Neon.`)

  for (const agent of agents) {
    const rawSlug = (agent.slug || agent.org_slug || agent.name.toLowerCase().replace(/\s+/g, '-')).toLowerCase()
    const rawName = agent.name || agent.org_name || 'Agente IA'

    let companySlug = rawSlug
    let companyName = rawName

    if (rawSlug.includes('casal') || rawSlug.includes('trafego')) {
      companySlug = 'casaldotrafego'
      companyName = 'Casal do Tráfego'
    } else if (rawSlug.includes('gastao') || rawSlug.includes('24horas') || rawName.toLowerCase().includes('gast')) {
      companySlug = 'gastao-matos'
      companyName = 'Gastão Matos'
    } else if (rawSlug.includes('gramado') || rawSlug.includes('plaza')) {
      companySlug = 'gramado-plaza'
      companyName = 'Gramado Plaza'
    } else if (rawSlug.includes('lucas') || rawName.toLowerCase().includes('lucas')) {
      companySlug = 'drlucas'
      companyName = 'Dr. Lucas'
    }

    let company = companyMap.get(companySlug)
    if (!company) {
      let [existingComp] = await db.select().from(companies).where(eq(companies.slug, companySlug)).limit(1)
      if (!existingComp) {
        const [created] = await db
          .insert(companies)
          .values({ name: companyName, slug: companySlug, plan: 'pro' })
          .returning()
        existingComp = created
        companiesCreated++
      }
      company = existingComp
      companyMap.set(companySlug, company)
    }

    // 3. Sincroniza Conversas e Mensagens do schema do agente ("<schema>".conversations e messages)
    const schema = agent.schema_name
    if (schema) {
      try {
        const convs = await queryAgentsDb<ConversationDbRow>(`
          select session_id, chat_id, channel, title, started_at, ended_at, message_count
          from "${schema}".conversations
          order by started_at desc
          limit 250
        `)

        if (convs && convs.length > 0) {
          for (const cv of convs) {
            const rawPhone = cv.chat_id || cv.session_id
            if (!rawPhone) continue
            const cleanPhone = normalizeDigits(rawPhone) || rawPhone

            // Encontra ou cria lead
            let [lead] = await db
              .select()
              .from(recoveryLeads)
              .where(
                and(
                  eq(recoveryLeads.companyId, company.id),
                  or(
                    eq(recoveryLeads.phone, cleanPhone),
                    sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = right(${cleanPhone}, 9)`
                  )
                )
              )
              .limit(1)

            const channelType = cv.channel?.includes('email')
              ? 'email'
              : cv.channel?.includes('insta')
              ? 'instagram'
              : 'whatsapp'

            if (!lead) {
              const [newLead] = await db
                .insert(recoveryLeads)
                .values({
                  companyId: company.id,
                  phone: cleanPhone,
                  name: cv.title || `Atendimento ${cleanPhone.slice(-4)}`,
                  platform: 'sac',
                  channel: channelType,
                  eventType: 'atendimento_ia',
                  status: 'in_conversation',
                  trackingSource: 'agente_ia',
                  createdAt: cv.started_at ? new Date(cv.started_at) : new Date(),
                  updatedAt: cv.ended_at ? new Date(cv.ended_at) : new Date(),
                })
                .returning()
              lead = newLead
              leadsCreated++
            }

            // Sincroniza mensagens desta conversa usando a coluna correta "ts"
            const msgs = await queryAgentsDb<MessageDbRow>(`
              select id, session_id, role, content, ts, platform_message_id
              from "${schema}".messages
              where session_id = $1
              order by ts asc
            `, [cv.session_id])

            if (msgs && msgs.length > 0) {
              for (const m of msgs) {
                const isUser = m.role === 'user'
                const direction = isUser ? 'inbound' : 'outbound'
                const sentBy = isUser ? 'user' : 'bot'
                const externalId = `agent_${schema}_${m.id || m.platform_message_id || cv.session_id + '_' + m.ts}`

                const [existingMsg] = await db
                  .select({ id: whatsappMessages.id })
                  .from(whatsappMessages)
                  .where(
                    and(
                      eq(whatsappMessages.companyId, company.id),
                      eq(whatsappMessages.externalId, externalId)
                    )
                  )
                  .limit(1)

                if (!existingMsg) {
                  await db.insert(whatsappMessages).values({
                    companyId: company.id,
                    leadId: lead.id,
                    phone: lead.phone,
                    channel: channelType,
                    direction,
                    content: m.content || '',
                    messageType: 'text',
                    sentBy,
                    externalId,
                    createdAt: m.ts ? new Date(m.ts) : new Date(),
                  })
                  messagesImported++
                }
              }
            }
          }
        }
      } catch (convErr) {
        details.push(`Aviso ao sincronizar conversas do schema "${schema}": ${String(convErr)}`)
      }
    }
  }

  // 4. Sincroniza Leads e Mensagens de Mineração / Prospecção (public.outreach_convos e public.outreach_msgs)
  try {
    const outreachConvos = await queryAgentsDb<OutreachConvoDbRow>(`
      select id, agent_slug, channel, source, lead_name, lead_handle, lead_company, status, last_at, msg_count
      from public.outreach_convos
      order by last_at desc
      limit 1000
    `)

    if (outreachConvos && outreachConvos.length > 0) {
      details.push(`Encontradas ${outreachConvos.length} conversas de prospecção/mineração.`)

      for (const oc of outreachConvos) {
        const agentSlug = (oc.agent_slug || '').toLowerCase()
        let companySlug = 'casaldotrafego'
        if (agentSlug.includes('gastao') || agentSlug.includes('24')) {
          companySlug = 'gastao-matos'
        } else if (agentSlug.includes('lucas')) {
          companySlug = 'drlucas'
        } else if (agentSlug.includes('gramado')) {
          companySlug = 'gramado-plaza'
        }

        const comp = companyMap.get(companySlug) || companyMap.get('casaldotrafego')
        if (!comp) continue

        const rawHandle = (oc.lead_handle || '').trim()
        const isEmail = rawHandle.includes('@')
        const phone = isEmail ? rawHandle : normalizeDigits(rawHandle) || rawHandle
        if (!phone) continue

        const ch = oc.channel || (isEmail ? 'email' : 'whatsapp')

        let [lead] = await db
          .select()
          .from(recoveryLeads)
          .where(
            and(
              eq(recoveryLeads.companyId, comp.id),
              or(
                eq(recoveryLeads.phone, phone),
                isEmail ? eq(recoveryLeads.email, phone) : sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = right(${phone}, 9)`
              )
            )
          )
          .limit(1)

        if (!lead) {
          const [newLead] = await db
            .insert(recoveryLeads)
            .values({
              companyId: comp.id,
              phone,
              email: isEmail ? rawHandle : null,
              name: oc.lead_name || `Lead ${phone.slice(-4)}`,
              productName: oc.lead_company || 'Prospecção / Mineração',
              platform: 'sac',
              channel: ch,
              eventType: oc.source || 'prospeccao',
              status: oc.status === 'active' ? 'in_conversation' : 'pending',
              trackingSource: 'mineracao_prospeccao',
              createdAt: oc.last_at ? new Date(oc.last_at) : new Date(),
              updatedAt: oc.last_at ? new Date(oc.last_at) : new Date(),
            })
            .returning()
          lead = newLead
          leadsCreated++
        }

        // Importa mensagens de public.outreach_msgs
        const msgs = await queryAgentsDb<OutreachMsgDbRow>(`
          select id, convo_id, direction, status, subject, body, sent_at
          from public.outreach_msgs
          where convo_id = $1
          order by sent_at asc
        `, [oc.id])

        if (msgs && msgs.length > 0) {
          for (const m of msgs) {
            const isUser = m.direction === 'inbound'
            const direction = isUser ? 'inbound' : 'outbound'
            const sentBy = isUser ? 'user' : 'bot'
            const externalId = `outreach_${m.id}`

            const [existingMsg] = await db
              .select({ id: whatsappMessages.id })
              .from(whatsappMessages)
              .where(
                and(
                  eq(whatsappMessages.companyId, comp.id),
                  eq(whatsappMessages.externalId, externalId)
                )
              )
              .limit(1)

            if (!existingMsg) {
              await db.insert(whatsappMessages).values({
                companyId: comp.id,
                leadId: lead.id,
                phone: lead.phone,
                channel: ch,
                direction,
                content: m.body || m.subject || '',
                messageType: 'text',
                sentBy,
                externalId,
                createdAt: m.sent_at ? new Date(m.sent_at) : (oc.last_at ? new Date(oc.last_at) : new Date()),
              })
              messagesImported++
            }
          }
        }
      }
    }
  } catch (outreachErr) {
    details.push(`Aviso ao sincronizar prospecção: ${String(outreachErr)}`)
  }

  // 5. Sincroniza Referrals de Anúncios Click-to-WhatsApp (CTWA) para Janela de 72 Horas
  try {
    const ctwaRows = await queryAgentsDb<CtwaReferralDbRow>(`
      select phone_norm, campaign_name, ad_name
      from public.ctwa_referrals
      where phone_norm is not null and length(phone_norm) >= 8
    `)

    if (ctwaRows && ctwaRows.length > 0) {
      let ctwaCount = 0
      for (const r of ctwaRows) {
        const norm = normalizeDigits(r.phone_norm)
        if (!norm) continue

        // Atualiza leads correspondentes marcando tracking_source = 'meta_ads' (Janela 72h)
        const updated = await db
          .update(recoveryLeads)
          .set({
            trackingSource: 'meta_ads',
            utmCampaign: r.campaign_name || undefined,
            updatedAt: new Date(),
          })
          .where(sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = right(${norm}, 9)`)
          .returning({ id: recoveryLeads.id })

        if (updated.length > 0) ctwaCount++
      }
      details.push(`${ctwaCount} leads identificados como Anúncios Meta (Janela de 72h).`)
    }
  } catch (ctwaErr) {
    // Tabela opcional
  }

  return {
    ok: true,
    message: `Sincronização concluída com sucesso. ${agents.length} agentes processados, ${leadsCreated} novos leads e ${messagesImported} mensagens importadas.`,
    agentsFound: agents.length,
    companiesCreated,
    leadsCreated,
    messagesImported,
    details,
    dbUrlUsed: dbUrlMasked,
  }
}
