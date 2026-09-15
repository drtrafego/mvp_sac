import { db } from '@/lib/db'
import { companies, settings, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { queryAgentsDb, getAgentsDbUrl } from '@/lib/db/agents-db'
import { eq, and } from 'drizzle-orm'

export interface AgentDbRow {
  id: string
  organization_id: string
  org_slug: string
  org_name: string
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
  title: string | null
  origin?: string | null
  started_at?: string | null
  ended_at?: string | null
}

export interface MessageDbRow {
  id: string | number
  session_id: string
  role: string
  content: string | null
  created_at?: string | null
}

export interface CrmLeadDbRow {
  id: string
  name: string
  company: string | null
  email: string | null
  phone: string | null
  notes: string | null
  campaign_source: string | null
  value: string | null
  status: string | null
  created_via: string | null
  created_at: string
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

function parseCents(val: string | null | undefined): number {
  if (!val) return 0
  const clean = val.replace(/[^0-9,-.]/g, '').trim()
  if (!clean) return 0
  if (clean.includes(',')) {
    return Math.round(parseFloat(clean.replace(/\./g, '').replace(',', '.')) * 100) || 0
  }
  return Math.round(parseFloat(clean) * 100) || 0
}

export async function syncAgentsAndCompanies(): Promise<SyncReport> {
  const details: string[] = []
  let companiesCreated = 0
  let leadsCreated = 0
  let messagesImported = 0

  const dbUrl = await getAgentsDbUrl()
  const dbUrlMasked = dbUrl ? dbUrl.replace(/:[^:@]+@/, ':****@') : 'Não configurado'

  // 1. Garante imediatamente as 3 empresas principais no banco de dados local
  const defaultCompanies = [
    { name: 'Gastão Matos', slug: 'gastao-matos' },
    { name: 'Gramado Plaza', slug: 'gramado-plaza' },
    { name: 'Dr. Lucas', slug: 'drlucas' },
  ]

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

    // Garante settings
    const [st] = await db.select().from(settings).where(eq(settings.companyId, comp.id)).limit(1)
    if (!st) {
      await db.insert(settings).values({ companyId: comp.id, whatsappProvider: 'meta' }).onConflictDoNothing()
    }
  }

  // 2. Busca agentes na tabela public.agents do Supabase
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
      message: `Nenhum agente ativo encontrado na base do Supabase (${dbUrlMasked}). Verifique se SUPABASE_DATABASE_URL aponta para o banco do Supabase dos agentes.`,
      agentsFound: 0,
      companiesCreated,
      leadsCreated,
      messagesImported,
      details: [
        ...details,
        `Tentativa de conexão com: ${dbUrlMasked}`,
        'Para conectar, defina SUPABASE_DATABASE_URL nas variáveis da Vercel com a string de conexão do Supabase (porta 6543 / transaction mode).',
      ],
      dbUrlUsed: dbUrlMasked,
    }
  }

  details.push(`Encontrados ${agents.length} agentes ativos no catálogo Supabase.`)

  for (const agent of agents) {
    const rawSlug = (agent.slug || agent.org_slug || agent.name.toLowerCase().replace(/\s+/g, '-')).toLowerCase()
    const rawName = agent.name || agent.org_name || 'Agente IA'

    // Mapeamento inteligente para as 3 empresas alvo
    let companySlug = rawSlug
    let companyName = rawName

    if (rawSlug.includes('gastao') || rawSlug.includes('24horas') || rawName.toLowerCase().includes('gast')) {
      companySlug = 'gastao-matos'
      companyName = 'Gastão Matos'
    } else if (rawSlug.includes('gramado') || rawSlug.includes('plaza') || rawName.toLowerCase().includes('gramado')) {
      companySlug = 'gramado-plaza'
      companyName = 'Gramado Plaza'
    } else if (rawSlug.includes('lucas') || rawName.toLowerCase().includes('lucas')) {
      companySlug = 'drlucas'
      companyName = 'Dr. Lucas'
    }

    // Localiza a empresa correspondente
    let [company] = await db.select().from(companies).where(eq(companies.slug, companySlug)).limit(1)

    if (!company) {
      const [created] = await db
        .insert(companies)
        .values({ name: companyName, slug: companySlug, plan: 'pro' })
        .returning()
      company = created
      companiesCreated++
      details.push(`Empresa "${companyName}" vinculada ao agente "${agent.name}".`)
    }

    // Atualiza credenciais Meta da empresa se vierem do agente
    if (agent.meta_phone_number_id || agent.meta_waba_id) {
      await db
        .update(settings)
        .set({
          metaPhoneNumberId: agent.meta_phone_number_id ?? undefined,
          metaWabaId: agent.meta_waba_id ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(settings.companyId, company.id))
    }

    const schema = agent.schema_name
    if (!schema) continue

    // 3. Sincroniza Leads do CRM ("<schema>".crm_leads)
    try {
      const crmLeads = await queryAgentsDb<CrmLeadDbRow>(`
        select id, name, company, email, phone, notes, campaign_source, value, status, created_via, created_at
        from "${schema}".crm_leads
        order by created_at desc
        limit 300
      `)

      if (crmLeads && crmLeads.length > 0) {
        for (const cl of crmLeads) {
          const phone = cl.phone?.replace(/\D/g, '')
          if (!phone || phone.length < 8) continue

          const [existing] = await db
            .select()
            .from(recoveryLeads)
            .where(and(eq(recoveryLeads.phone, phone), eq(recoveryLeads.companyId, company.id)))
            .limit(1)

          if (!existing) {
            await db.insert(recoveryLeads).values({
              companyId: company.id,
              phone,
              name: cl.name || `Lead ${phone.slice(-4)}`,
              email: cl.email || null,
              productName: cl.company || cl.campaign_source || 'Atendimento IA',
              productValue: parseCents(cl.value),
              platform: 'sac',
              channel: 'whatsapp',
              eventType: 'prospeccao',
              status: cl.status || 'pending',
              trackingSource: cl.campaign_source || cl.created_via || 'crm_agente',
              createdAt: cl.created_at ? new Date(cl.created_at) : new Date(),
            })
            leadsCreated++
          }
        }
      }
    } catch (crmErr) {
      // Schema pode não ter crm_leads se for agente simples
    }

    // 4. Sincroniza Conversas e Mensagens ("<schema>".conversations e messages)
    try {
      const convs = await queryAgentsDb<ConversationDbRow>(`
        select session_id, chat_id, title, origin, started_at, ended_at
        from "${schema}".conversations
        order by started_at desc
        limit 200
      `)

      if (convs && convs.length > 0) {
        for (const cv of convs) {
          const rawPhone = cv.chat_id || cv.session_id
          if (!rawPhone) continue
          const phone = rawPhone.replace(/\D/g, '') || rawPhone

          let [lead] = await db
            .select()
            .from(recoveryLeads)
            .where(and(eq(recoveryLeads.phone, phone), eq(recoveryLeads.companyId, company.id)))
            .limit(1)

          if (!lead) {
            const [newLead] = await db
              .insert(recoveryLeads)
              .values({
                companyId: company.id,
                phone,
                name: cv.title || `Lead ${phone.slice(-4)}`,
                platform: 'sac',
                channel: 'whatsapp',
                eventType: cv.origin || 'atendimento_ia',
                status: 'in_conversation',
                trackingSource: cv.origin || 'agente_ia',
                createdAt: cv.started_at ? new Date(cv.started_at) : new Date(),
              })
              .returning()
            lead = newLead
            leadsCreated++
          }

          // Mensagens da conversa
          const msgs = await queryAgentsDb<MessageDbRow>(`
            select id, session_id, role, content, created_at
            from "${schema}".messages
            where session_id = $1
            order by created_at asc
          `, [cv.session_id])

          if (msgs && msgs.length > 0) {
            for (const m of msgs) {
              const isUser = m.role === 'user'
              const direction = isUser ? 'inbound' : 'outbound'
              const sentBy = isUser ? 'user' : 'bot'
              const externalId = `agent_${schema}_${m.id}`

              const [existingMsg] = await db
                .select()
                .from(whatsappMessages)
                .where(and(eq(whatsappMessages.companyId, company.id), eq(whatsappMessages.externalId, externalId)))
                .limit(1)

              if (!existingMsg) {
                await db.insert(whatsappMessages).values({
                  companyId: company.id,
                  leadId: lead.id,
                  phone,
                  channel: 'whatsapp',
                  direction,
                  content: m.content || '',
                  messageType: 'text',
                  sentBy,
                  externalId,
                  createdAt: m.created_at ? new Date(m.created_at) : new Date(),
                })
                messagesImported++
              }
            }
          }
        }
      }
    } catch (convErr) {
      details.push(`Aviso ao consultar conversas em "${schema}": ${String(convErr)}`)
    }
  }

  return {
    ok: true,
    message: `Sincronização concluída com sucesso. ${agents.length} agentes processados, ${leadsCreated} leads e ${messagesImported} mensagens importadas.`,
    agentsFound: agents.length,
    companiesCreated,
    leadsCreated,
    messagesImported,
    details,
    dbUrlUsed: dbUrlMasked,
  }
}
