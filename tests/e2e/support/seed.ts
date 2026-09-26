import postgres from 'postgres'
import { tenants } from './constants'

async function main() {
  const url = new URL(process.env.DATABASE_URL || '')
  if (process.env.SAC_E2E !== '1' || url.hostname !== '127.0.0.1' || url.pathname !== '/sac_e2e') {
    throw new Error('Seed recusou banco não descartável/local')
  }
  const sql = postgres(url.toString(), { max: 1 })
  try {
    for (const tenant of Object.values(tenants)) {
      await sql`insert into companies (id, name, slug, stack_auth_user_id)
        values (${tenant.id}, ${tenant.slug}, ${tenant.slug}, ${tenant.userId})`
      // Nenhum token de envio ou integração. Não há jobs nem sequências ativas.
      await sql`insert into settings (company_id) values (${tenant.id})`
      await sql`insert into recovery_leads (id, company_id, phone, name, email, platform, event_type, channel, status)
        values (${tenant.leadId}, ${tenant.id}, ${'55000000' + tenant.id}, ${tenant.name},
        ${tenant.slug + '@example.invalid'}, 'sac', 'atendimento', 'whatsapp', 'pending')`
      await sql`insert into whatsapp_messages (company_id, lead_id, phone, channel, direction, content)
        values (${tenant.id}, ${tenant.leadId}, ${'55000000' + tenant.id}, 'whatsapp', 'inbound', 'Mensagem sintética de teste')`
    }
  } finally {
    await sql.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
