// Backfill: reclassifica leads historicos que entraram como eventType='boleto'
// mas cujo metodo de pagamento foi PIX (paymentType='pix') para eventType='pix'.
//
// PIX virou tipo de recuperacao proprio em 2026-06-10. Antes disso, PIX pendente
// caia dentro de 'boleto'. Este script separa os historicos usando paymentType
// como fonte da verdade. Idempotente: rodar de novo nao muda nada.
//
// Uso:
//   node scripts/backfill-pix-eventtype.mjs           (dry run, so conta)
//   node scripts/backfill-pix-eventtype.mjs --apply   (aplica o UPDATE)

import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

// Carrega DATABASE_URL do .env.local sem dependencia externa
function loadEnv() {
  if (process.env.DATABASE_URL) return
  try {
    const content = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/)
      if (m) {
        process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '')
        break
      }
    }
  } catch {
    // ignora
  }
}

loadEnv()

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL nao encontrado (.env.local ou env).')
  process.exit(1)
}

const apply = process.argv.includes('--apply')
const sql = neon(process.env.DATABASE_URL)

const [{ count }] = await sql`
  select cast(count(*) as int) as count
  from recovery_leads
  where event_type = 'boleto' and payment_type = 'pix'
`

console.log(`Leads boleto que sao PIX (payment_type='pix'): ${count}`)

if (count === 0) {
  console.log('Nada a fazer.')
  process.exit(0)
}

// Quebra por empresa para visibilidade
const byCompany = await sql`
  select company_id, cast(count(*) as int) as count
  from recovery_leads
  where event_type = 'boleto' and payment_type = 'pix'
  group by company_id
  order by company_id
`
for (const row of byCompany) {
  console.log(`  empresa ${row.company_id}: ${row.count}`)
}

if (!apply) {
  console.log('\nDry run. Rode com --apply para reclassificar para event_type=pix.')
  process.exit(0)
}

const updated = await sql`
  update recovery_leads
  set event_type = 'pix', updated_at = now()
  where event_type = 'boleto' and payment_type = 'pix'
  returning id
`

console.log(`\nReclassificados ${updated.length} leads de boleto -> pix.`)
