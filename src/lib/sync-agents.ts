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
    { name: 'AutonomIA', slug: 'autonomia' },
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

  // Pre-carrega em memória os telefones e externalIds existentes para evitar N+1 queries
  const existingLeadsRows = await db
    .select({ id: recoveryLeads.id, companyId: recoveryLeads.companyId, phone: recoveryLeads.phone, email: recoveryLeads.email })
    .from(recoveryLeads)

  const leadMap = new Map<string, number>()
  for (const row of existingLeadsRows) {
    if (row.phone) {
      const clean = row.phone.replace(/\D/g, '') || row.phone
      leadMap.set(`${row.companyId}_${clean}`, row.id)
      if (clean.length >= 9) leadMap.set(`${row.companyId}_${clean.slice(-9)}`, row.id)
    }
    if (row.email) {
      leadMap.set(`${row.companyId}_${row.email.trim().toLowerCase()}`, row.id)
    }
  }

  const existingMsgsRows = await db
    .select({ externalId: whatsappMessages.externalId })
    .from(whatsappMessages)
    .where(sql`${whatsappMessages.externalId} IS NOT NULL`)

  const existingMsgIds = new Set<string>(existingMsgsRows.map(m => m.externalId!).filter(Boolean))

  for (const agent of agents) {
    const rawSlug = (agent.slug || agent.org_slug || agent.name.toLowerCase().replace(/\s+/g, '-')).toLowerCase()
    const rawName = agent.name || agent.org_name || 'Agente IA'

    let companySlug = rawSlug
    let companyName = rawName

    if (rawSlug.includes('autonomia') || rawSlug.includes('gastao') || rawSlug.includes('24horas') || rawSlug.includes('casal') || rawSlug.includes('trafego') || rawName.toLowerCase().includes('gast') || rawName.toLowerCase().includes('casal') || rawName.toLowerCase().includes('autonomia')) {
      companySlug = 'autonomia'
      companyName = 'AutonomIA'
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

    // 3. Sincroniza Conversas e Mensagens recentes do schema do agente em BATCH
    const schema = agent.schema_name
    if (schema) {
      try {
        const convs = await queryAgentsDb<ConversationDbRow>(`
          select session_id, chat_id, channel, title, started_at, ended_at, message_count
          from "${schema}".conversations
          order by coalesce(ended_at, started_at) desc
          limit 300
        `)

        if (convs && convs.length > 0) {
          const sessionIds = convs.map(c => c.session_id).filter(Boolean)

          const msgs = sessionIds.length > 0 ? await queryAgentsDb<MessageDbRow>(`
            select id, session_id, role, content, ts, platform_message_id
            from "${schema}".messages
            where session_id = ANY($1)
            order by ts asc
          `, [sessionIds]) : []

          const msgsBySession = new Map<string, MessageDbRow[]>()
          if (msgs) {
            for (const m of msgs) {
              if (!msgsBySession.has(m.session_id)) msgsBySession.set(m.session_id, [])
              msgsBySession.get(m.session_id)!.push(m)
            }
          }

          for (const cv of convs) {
            const rawPhone = cv.chat_id || cv.session_id
            if (!rawPhone) continue
            const cleanPhone = normalizeDigits(rawPhone) || rawPhone
            const last9 = cleanPhone.length >= 9 ? cleanPhone.slice(-9) : cleanPhone

            let leadId = leadMap.get(`${company.id}_${cleanPhone}`) || leadMap.get(`${company.id}_${last9}`)
            const channelType = cv.channel?.includes('email')
              ? 'email'
              : cv.channel?.includes('insta')
              ? 'instagram'
              : 'whatsapp'

            let leadDate = cv.ended_at ? new Date(cv.ended_at) : (cv.started_at ? new Date(cv.started_at) : new Date())
            if (isNaN(leadDate.getTime())) leadDate = new Date()

            if (!leadId) {
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
                  trackingSource: companySlug === 'drlucas' ? 'whatsapp_sac' : 'agente_ia',
                  createdAt: cv.started_at ? new Date(cv.started_at) : new Date(),
                  updatedAt: leadDate,
                  lastActionAt: leadDate,
                })
                .returning()

              leadId = newLead.id
              leadMap.set(`${company.id}_${cleanPhone}`, leadId)
              if (cleanPhone.length >= 9) leadMap.set(`${company.id}_${last9}`, leadId)
              leadsCreated++
            }

            const convMsgs = msgsBySession.get(cv.session_id) || []
            const msgsToInsert: (typeof whatsappMessages.$inferInsert)[] = []

            for (const m of convMsgs) {
              const externalId = `agent_${schema}_${m.id || m.platform_message_id || cv.session_id + '_' + m.ts}`
              if (existingMsgIds.has(externalId)) continue

              const isUser = m.role === 'user'
              const msgDate = m.ts ? new Date(m.ts) : new Date()

              msgsToInsert.push({
                companyId: company.id,
                leadId: leadId,
                phone: cleanPhone,
                channel: channelType,
                direction: isUser ? 'inbound' : 'outbound',
                content: m.content || '',
                messageType: 'text',
                sentBy: isUser ? 'user' : 'bot',
                externalId,
                createdAt: msgDate,
              })
              existingMsgIds.add(externalId)
            }

            if (msgsToInsert.length > 0) {
              await db.insert(whatsappMessages).values(msgsToInsert)
              messagesImported += msgsToInsert.length
            }
          }
        }
      } catch (convErr) {
        details.push(`Aviso ao sincronizar conversas do schema "${schema}": ${String(convErr)}`)
      }
    }
  }

  // 4. Sincroniza Leads e Mensagens de Mineração / Prospecção em BATCH
  try {
    const outreachConvos = await queryAgentsDb<OutreachConvoDbRow>(`
      select id, agent_slug, channel, source, lead_name, lead_handle, lead_company, status, last_at, msg_count
      from public.outreach_convos
      where agent_slug not ilike '%lucas%'
      order by last_at desc
      limit 300
    `)

    if (outreachConvos && outreachConvos.length > 0) {
      const convoIds = outreachConvos.map(c => c.id).filter(Boolean)
      const outreachMsgs = convoIds.length > 0 ? await queryAgentsDb<OutreachMsgDbRow>(`
        select id, convo_id, direction, status, subject, body, sent_at
        from public.outreach_msgs
        where convo_id = ANY($1)
        order by sent_at asc
      `, [convoIds]) : []

      const msgsByConvo = new Map<string, OutreachMsgDbRow[]>()
      if (outreachMsgs) {
        for (const m of outreachMsgs) {
          if (!msgsByConvo.has(m.convo_id)) msgsByConvo.set(m.convo_id, [])
          msgsByConvo.get(m.convo_id)!.push(m)
        }
      }

      for (const oc of outreachConvos) {
        const agentSlug = (oc.agent_slug || '').toLowerCase()
        let companySlug = 'autonomia'
        if (agentSlug.includes('gramado') || agentSlug.includes('plaza')) {
          companySlug = 'gramado-plaza'
        }

        const comp = companyMap.get(companySlug) || companyMap.get('autonomia')
        if (!comp) continue

        const rawHandle = (oc.lead_handle || '').trim()
        const isEmail = rawHandle.includes('@')
        const phone = isEmail ? rawHandle : normalizeDigits(rawHandle) || rawHandle
        if (!phone) continue

        const ch = oc.channel || (isEmail ? 'email' : 'whatsapp')
        const ocDate = oc.last_at ? new Date(oc.last_at) : new Date()
        const last9 = !isEmail && phone.length >= 9 ? phone.slice(-9) : phone

        let leadId = isEmail
          ? leadMap.get(`${comp.id}_${rawHandle.toLowerCase()}`)
          : (leadMap.get(`${comp.id}_${phone}`) || leadMap.get(`${comp.id}_${last9}`))

        if (!leadId) {
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
              createdAt: ocDate,
              updatedAt: ocDate,
              lastActionAt: ocDate,
            })
            .returning()

          leadId = newLead.id
          if (isEmail) {
            leadMap.set(`${comp.id}_${rawHandle.toLowerCase()}`, leadId)
          } else {
            leadMap.set(`${comp.id}_${phone}`, leadId)
            if (phone.length >= 9) leadMap.set(`${comp.id}_${last9}`, leadId)
          }
          leadsCreated++
        }

        const convoMsgs = msgsByConvo.get(oc.id) || []
        const msgsToInsert: (typeof whatsappMessages.$inferInsert)[] = []

        for (const m of convoMsgs) {
          const externalId = `outreach_${m.id}`
          if (existingMsgIds.has(externalId)) continue

          const isUser = m.direction === 'inbound'
          msgsToInsert.push({
            companyId: comp.id,
            leadId: leadId,
            phone: phone,
            channel: ch,
            direction: isUser ? 'inbound' : 'outbound',
            content: m.body || m.subject || '',
            messageType: 'text',
            sentBy: isUser ? 'user' : 'bot',
            externalId,
            createdAt: m.sent_at ? new Date(m.sent_at) : (oc.last_at ? new Date(oc.last_at) : new Date()),
          })
          existingMsgIds.add(externalId)
        }

        if (msgsToInsert.length > 0) {
          await db.insert(whatsappMessages).values(msgsToInsert)
          messagesImported += msgsToInsert.length
        }
      }
    }
  } catch (outreachErr) {
    details.push(`Aviso ao sincronizar prospecção: ${String(outreachErr)}`)
  }

  // 5. Sincroniza novos Leads do CRM em BATCH
  try {
    const crmLeads = await queryAgentsDb<any>(`
      select id, organization_id, whatsapp, email, name, company, notes, value, status,
             follow_up_date, follow_up_note, campaign_source, utm_source, utm_medium,
             utm_campaign, utm_content, utm_term, ai_agent, created_at, first_contact_at
      from public.leads
      order by created_at desc
      limit 300
    `)

    if (crmLeads && crmLeads.length > 0) {
      const targetComp = companyMap.get('autonomia') || companyMap.values().next().value
      if (targetComp) {
        const leadsToInsert: (typeof recoveryLeads.$inferInsert)[] = []

        for (const l of crmLeads) {
          const rawPhone = (l.whatsapp || '').trim()
          const cleanPhone = normalizeDigits(rawPhone) || rawPhone
          const email = l.email ? l.email.trim().toLowerCase() : null
          if (!cleanPhone && !email) continue

          const last9 = cleanPhone && cleanPhone.length >= 9 ? cleanPhone.slice(-9) : null
          const existingId = (cleanPhone && leadMap.get(`${targetComp.id}_${cleanPhone}`)) ||
                             (last9 && leadMap.get(`${targetComp.id}_${last9}`)) ||
                             (email && leadMap.get(`${targetComp.id}_${email}`))

          if (!existingId) {
            const leadDate = l.created_at ? new Date(l.created_at) : (l.first_contact_at ? new Date(l.first_contact_at) : new Date())
            const prodVal = l.value ? Math.round(Number(l.value) * 100) : null
            const stage = l.status === 'converted' ? 'fechado' : (l.follow_up_date ? 'agendado' : 'qualificado')

            leadsToInsert.push({
              companyId: targetComp.id,
              phone: cleanPhone || email || '',
              email: email || undefined,
              name: l.name || l.company || ('Contato ' + (cleanPhone ? cleanPhone.slice(-4) : '')),
              productName: l.company || l.notes || 'Agente 24h / CRM',
              productValue: prodVal,
              platform: 'sac',
              channel: 'whatsapp',
              eventType: l.campaign_source || 'prospeccao',
              status: l.status === 'converted' ? 'converted' : 'in_conversation',
              pipelineStage: stage,
              trackingSource: l.campaign_source || l.utm_source || 'mineracao_prospeccao',
              utmMedium: l.utm_medium,
              utmCampaign: l.utm_campaign,
              utmContent: l.utm_content,
              utmTerm: l.utm_term,
              responsibleAgent: l.ai_agent || 'Nina',
              followUpDate: l.follow_up_date ? new Date(l.follow_up_date) : undefined,
              followUpNote: l.follow_up_note,
              createdAt: leadDate,
              updatedAt: leadDate,
              lastActionAt: leadDate,
            })

            if (cleanPhone) leadMap.set(`${targetComp.id}_${cleanPhone}`, -1)
            if (last9) leadMap.set(`${targetComp.id}_${last9}`, -1)
            if (email) leadMap.set(`${targetComp.id}_${email}`, -1)
            leadsCreated++
          }
        }

        if (leadsToInsert.length > 0) {
          await db.insert(recoveryLeads).values(leadsToInsert)
          details.push(`${leadsToInsert.length} novos leads importados da base de CRM.`)
        }
      }
    }
  } catch (crmErr) {
    details.push(`Aviso ao sincronizar CRM leads: ${String(crmErr)}`)
  }

  // 6. Sincroniza Referrals de Anúncios Click-to-WhatsApp (CTWA)
  try {
    const ctwaRows = await queryAgentsDb<CtwaReferralDbRow>(`
      select phone_norm, campaign_name, ad_name
      from public.ctwa_referrals
      where phone_norm is not null and length(phone_norm) >= 8
      order by created_at desc
      limit 200
    `)

    if (ctwaRows && ctwaRows.length > 0) {
      let ctwaCount = 0
      for (const r of ctwaRows) {
        const norm = normalizeDigits(r.phone_norm)
        if (!norm) continue

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
      if (ctwaCount > 0) {
        details.push(`${ctwaCount} leads identificados como Anúncios Meta (Janela de 72h).`)
      }
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
