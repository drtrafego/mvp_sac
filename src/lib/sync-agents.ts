import { db } from '@/lib/db'
import { companies, settings, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { queryAgentsDb } from '@/lib/db/agents-db'
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

export interface SyncReport {
  ok: boolean
  message: string
  agentsFound: number
  companiesCreated: number
  leadsCreated: number
  messagesImported: number
  details: string[]
}

export async function syncAgentsAndCompanies(): Promise<SyncReport> {
  const details: string[] = []
  let companiesCreated = 0
  let leadsCreated = 0
  let messagesImported = 0

  // 1. Busca todos os agentes e suas organizações na tabela public.agents do Supabase
  const agents = await queryAgentsDb<AgentDbRow>(`
    select a.id, a.organization_id, o.slug as org_slug, o.name as org_name,
           a.slug, a.schema_name, a.name, a.meta_phone_number_id, a.meta_waba_id, a.meta_token_env
    from public.agents a
    join public.organizations o on o.id = a.organization_id
    where a.active = true
    order by o.slug, a.slug
  `)

  if (!agents || agents.length === 0) {
    return {
      ok: false,
      message: 'Nenhum agente ativo encontrado na base de dados do Supabase ou banco inacessível.',
      agentsFound: 0,
      companiesCreated: 0,
      leadsCreated: 0,
      messagesImported: 0,
      details: ['Banco de agentes retornou lista vazia ou conexão não configurada.'],
    }
  }

  details.push(`Encontrados ${agents.length} agentes ativos no Supabase.`)

  for (const agent of agents) {
    const companySlug = (agent.slug || agent.org_slug || agent.name.toLowerCase().replace(/\s+/g, '-')).toLowerCase()
    const companyName = agent.name || agent.org_name || 'Agente IA'

    // 2. Garante que a empresa existe em mvp_sac
    let [company] = await db.select().from(companies).where(eq(companies.slug, companySlug)).limit(1)

    if (!company) {
      const [created] = await db
        .insert(companies)
        .values({
          name: companyName,
          slug: companySlug,
          plan: 'pro',
        })
        .returning()
      company = created
      companiesCreated++
      details.push(`Empresa "${companyName}" (slug: ${companySlug}) criada.`)

      // Cria configurações iniciais para a empresa
      await db.insert(settings).values({
        companyId: company.id,
        metaPhoneNumberId: agent.meta_phone_number_id ?? null,
        metaWabaId: agent.meta_waba_id ?? null,
        whatsappProvider: 'meta',
      })
    } else {
      // Atualiza configurações se a empresa já existia
      const [existingSetting] = await db.select().from(settings).where(eq(settings.companyId, company.id))
      if (!existingSetting) {
        await db.insert(settings).values({
          companyId: company.id,
          metaPhoneNumberId: agent.meta_phone_number_id ?? null,
          metaWabaId: agent.meta_waba_id ?? null,
          whatsappProvider: 'meta',
        })
      }
    }

    // 3. Sincroniza conversas e mensagens do schema do agente
    const schema = agent.schema_name
    if (!schema) continue

    try {
      const convs = await queryAgentsDb<ConversationDbRow>(`
        select session_id, chat_id, title, origin, started_at, ended_at
        from "${schema}".conversations
        order by started_at desc
        limit 100
      `)

      if (convs && convs.length > 0) {
        for (const cv of convs) {
          const phone = cv.chat_id || cv.session_id
          if (!phone) continue

          // Procura ou cria o lead
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
              })
              .returning()
            lead = newLead
            leadsCreated++
          }

          // Busca as mensagens da conversa no Supabase
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
              const externalId = `agent_${m.id}`

              // Verifica se a mensagem já foi gravada
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
    } catch (err) {
      details.push(`Aviso ao consultar schema "${schema}": ${String(err)}`)
    }
  }

  return {
    ok: true,
    message: `Sincronização concluída com sucesso. ${agents.length} agentes processados.`,
    agentsFound: agents.length,
    companiesCreated,
    leadsCreated,
    messagesImported,
    details,
  }
}
