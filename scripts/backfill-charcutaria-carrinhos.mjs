import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8')
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const sql = neon(process.env.DATABASE_URL)

const COMPANY_ID = 4
const PRODUCT_NAME = 'Linguiças Artesanais Frescas e Defumadas - Curso completo'
const EVENT_TYPE = 'carrinho_abandonado'

// 4 carrinhos enviados pelo usuário (PURCHASE_OUT_OF_SHOPPING_CART)
// createdAtUtc: instante UTC correspondente ao horário informado em BRT (America/Sao_Paulo = UTC-3)
// Coluna recovery_leads.created_at é "timestamp without time zone" e o app trata como UTC.
const leads = [
  { name: 'Alvaniere Martins',   email: 'hamsmartinsterra@gmail.com',  createdAtUtc: '2026-05-31 17:45:00' },
  { name: 'Rogerio G.',          email: 'rogerio_formigoni@hotmail.com', createdAtUtc: '2026-05-31 10:32:00' },
  { name: 'Walace da Cruz Eker', email: 'walacedacruzeker@gmail.com',    createdAtUtc: '2026-05-30 01:01:00' },
  { name: 'Naiara Silva',        email: 'naiara_biologia@yahoo.com.br',  createdAtUtc: '2026-05-27 00:15:00' },
]

const [company] = await sql`SELECT id, name, slug FROM companies WHERE id = ${COMPANY_ID}`
if (!company) {
  console.error(`Empresa id=${COMPANY_ID} não encontrada. Abortando.`)
  process.exit(1)
}
console.log(`Empresa alvo: ${company.name} (slug=${company.slug})`)

let inserted = 0
let updated = 0
let unchanged = 0

for (const lead of leads) {
  const rawPayload = {
    backfill: true,
    source: 'manual_2026-06-01',
    reason: 'PURCHASE_OUT_OF_SHOPPING_CART não estava mapeado no webhook',
    original_event: 'PURCHASE_OUT_OF_SHOPPING_CART',
    note: 'Lead recuperado da lista fornecida pelo usuário. Sem disparo automático de mensagens.',
  }

  // Idempotência: se já existe lead com mesmo email + eventType + companyId, só ajusta created_at/updated_at
  const existing = await sql`
    SELECT id, created_at::text AS created_at FROM recovery_leads
    WHERE company_id = ${COMPANY_ID}
      AND email = ${lead.email}
      AND event_type = ${EVENT_TYPE}
    LIMIT 1
  `
  if (existing.length > 0) {
    const current = existing[0].created_at?.replace('T', ' ').split('.')[0]
    if (current === lead.createdAtUtc) {
      console.log(`UNCHANGED: ${lead.email} (id=${existing[0].id}) já com created_at correto`)
      unchanged++
      continue
    }
    await sql`
      UPDATE recovery_leads
      SET created_at = ${lead.createdAtUtc}::timestamp,
          updated_at = ${lead.createdAtUtc}::timestamp
      WHERE id = ${existing[0].id}
    `
    console.log(`UPDATED: lead id=${existing[0].id} (${lead.email}) ajustado para ${lead.createdAtUtc} UTC`)
    updated++
    continue
  }

  const [row] = await sql`
    INSERT INTO recovery_leads (
      company_id, platform, event_type, phone, name, email,
      product_name, priority, raw_payload, status, created_at, updated_at
    ) VALUES (
      ${COMPANY_ID}, 'hotmart', ${EVENT_TYPE}, '', ${lead.name}, ${lead.email},
      ${PRODUCT_NAME}, 1, ${rawPayload}, 'pending',
      ${lead.createdAtUtc}::timestamp, ${lead.createdAtUtc}::timestamp
    )
    RETURNING id
  `
  console.log(`INSERTED: lead id=${row.id} criado para ${lead.name} (${lead.email}) em ${lead.createdAtUtc} UTC`)
  inserted++
}

console.log(`\nResumo: ${inserted} inseridos, ${updated} atualizados, ${unchanged} sem alteração.`)
console.log('Nenhum message_job foi criado (intencional).')

const rows = await sql`
  SELECT id, name,
         created_at::text AS created_utc,
         to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') AS created_brt
  FROM recovery_leads
  WHERE company_id = ${COMPANY_ID}
    AND event_type = ${EVENT_TYPE}
    AND email = ANY(${leads.map(l => l.email)})
  ORDER BY id
`
console.log('\nEstado final (UTC + BRT):')
for (const r of rows) {
  console.log(`  ${r.id}  ${r.name.padEnd(22)}  UTC=${r.created_utc}  BRT=${r.created_brt}`)
}
