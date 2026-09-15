// Deduplica vendas: a mesma transacao as vezes gera 2+ leads compra_aprovada
// (Hotmart manda PURCHASE_APPROVED e depois PURCHASE_COMPLETE; Greenn reenvia
// saleUpdated 'paid'). Isso conta a venda em dobro e cria registro com data
// errada (a data do 2o aviso, dias depois).
//
// Estrategia REVERSIVEL: mantem o lead original (menor created_at por
// company_id+transaction_id) e marca os excedentes como
// event_type='compra_aprovada_duplicada'. Eles saem dos relatorios de venda
// (que filtram event_type='compra_aprovada') mas o registro e preservado.
// Para reverter: update ... set event_type='compra_aprovada' where event_type='compra_aprovada_duplicada'.
//
// Uso:
//   node --use-system-ca scripts/dedup-compra-aprovada.mjs           (dry run)
//   node --use-system-ca scripts/dedup-compra-aprovada.mjs --apply   (aplica)

import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

if (!process.env.DATABASE_URL) {
  const content = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/)
    if (m) { process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, ''); break }
  }
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL nao encontrado.'); process.exit(1) }

const apply = process.argv.includes('--apply')
const sql = neon(process.env.DATABASE_URL)

const fmt = (cents) => 'R$ ' + (Number(cents) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })

const [antes] = await sql`
  select cast(count(*) as int) as vendas,
         cast(coalesce(sum(product_value),0) as bigint) as receita
  from recovery_leads where event_type = 'compra_aprovada'`
console.log(`ANTES  -> vendas: ${antes.vendas} | receita: ${fmt(antes.receita)}`)

// Excedentes: tudo que nao e o primeiro (menor created_at) da mesma transacao
const excedentes = await sql`
  select id from (
    select id, row_number() over (
      partition by company_id, transaction_id order by created_at asc, id asc
    ) as rn
    from recovery_leads
    where event_type = 'compra_aprovada' and transaction_id is not null
  ) t where rn > 1`

console.log(`Cópias fantasmas a marcar: ${excedentes.length}`)

if (excedentes.length === 0) { console.log('Nada a fazer.'); process.exit(0) }

if (!apply) {
  console.log('\nDry run. Rode com --apply para marcar as cópias como compra_aprovada_duplicada.')
  process.exit(0)
}

const ids = excedentes.map(e => e.id)
const marcados = await sql`
  update recovery_leads
  set event_type = 'compra_aprovada_duplicada'
  where id = any(${ids})
  returning id`

const [depois] = await sql`
  select cast(count(*) as int) as vendas,
         cast(coalesce(sum(product_value),0) as bigint) as receita
  from recovery_leads where event_type = 'compra_aprovada'`

console.log(`Marcados: ${marcados.length}`)
console.log(`DEPOIS -> vendas: ${depois.vendas} | receita: ${fmt(depois.receita)}`)
console.log(`Removido da conta: ${antes.vendas - depois.vendas} vendas | ${fmt(Number(antes.receita) - Number(depois.receita))}`)
