// Importa o export "pedidos zouti.xlsx" (planilha de Pedidos da Zouti) como
// recovery_leads da empresa Dunas Capital (id=3). Usado para backfill do periodo
// em que o webhook Zouti estava preso a um unico produto e nao capturou vendas.
//
// Le o sheet1.xml ja extraido do xlsx (scripts/_zouti_sheet.xml). As celulas vem
// como <c r="A2" t="str"><v>valor</v></c>, sem sharedStrings.
//
// Idempotente: pula pedidos cujo transaction_id (ord_...) ja existe para a empresa.
// NAO cria message_jobs (apenas registra os leads no painel/analytics, sem disparar
// recuperacao retroativa).
//
// Uso:
//   node --use-system-ca scripts/import-zouti-pedidos.mjs           (dry run)
//   node --use-system-ca scripts/import-zouti-pedidos.mjs --apply   (grava)

import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

const COMPANY_ID = 3
const apply = process.argv.includes('--apply')

if (!process.env.DATABASE_URL) {
  const c = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const l of c.split('\n')) { const m = l.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/); if (m){process.env.DATABASE_URL=m[1].trim().replace(/^["']|["']$/g,'');break} }
}
const sql = neon(process.env.DATABASE_URL)

// ─── Parser do sheet1.xml ─────────────────────────────────────────────────────
const xml = readFileSync(new URL('./_zouti_sheet.xml', import.meta.url), 'utf8')

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}
function colLetters(ref) { return ref.replace(/[0-9]+/g, '') } // "AA2" -> "AA"

const rowsXml = xml.split('<row ').slice(1)
const rows = []
for (const r of rowsXml) {
  const cells = {}
  const cellRe = /<c r="([A-Z]+\d+)"[^>]*>(?:<v>([\s\S]*?)<\/v>)?<\/c>/g
  let m
  while ((m = cellRe.exec(r)) !== null) {
    cells[colLetters(m[1])] = m[2] != null ? decode(m[2]).trim() : ''
  }
  rows.push(cells)
}

// Linha 1 = cabecalho. Mapeia letra -> nome da coluna.
const header = rows.shift()
// Acesso por nome via letra fixa (ordem conhecida do export Zouti)
const COL = {
  id: 'A', metodo: 'B', status: 'C', valor: 'D', nome: 'I', email: 'J',
  telefone: 'K', documento: 'L', produtos: 'M', produtoId: 'N', ofertaId: 'O',
  precoOriginal: 'P', parcelas: 'Q', dataReembolso: 'R', dataCriacao: 'S',
  utmCampaign: 'T', utmSource: 'U', utmMedium: 'V', utmContent: 'W', utmTerm: 'X',
  sck: 'Y', nomeOferta: 'Z', motivoRecusa: 'AA', cidade: 'AF', estado: 'AG',
  pais: 'AH', cep: 'AI',
}
const get = (row, key) => (row[COL[key]] ?? '').trim()

// ─── Normalizadores ───────────────────────────────────────────────────────────
function norm(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}
function mapMetodo(metodo) {
  const m = norm(metodo)
  if (m.includes('PIX')) return 'pix'
  if (m.includes('BOLETO')) return 'boleto'
  if (m.includes('DEBIT')) return 'debit_card'
  if (m.includes('CART') || m.includes('CREDIT') || m.includes('CRED')) return 'credit_card'
  return m ? m.toLowerCase() : null
}
function mapEventType(status, paymentType, motivoRecusa) {
  const s = norm(status)
  if (['PAID', 'APPROVED', 'APROVADO', 'COMPLETE', 'COMPLETO', 'TRIAL'].includes(s)) return 'compra_aprovada'
  if (['REFUNDED', 'REEMBOLSADO', 'CHARGEBACK', 'DISPUTED', 'DISPUTA', 'PROTESTED'].includes(s)) return 'disputa'
  // Recusado / cancelado de cartao = oportunidade de recuperacao via cartao_recusado
  if (['REFUSED', 'RECUSADO', 'DECLINED', 'CANCELED', 'CANCELLED', 'CANCELADO', 'EXPIRED', 'EXPIRADO'].includes(s)) {
    if (paymentType === 'credit_card' || paymentType === 'debit_card' || motivoRecusa) return 'cartao_recusado'
    return 'disputa'
  }
  // Aguardando pagamento: depende do metodo
  if (['AWAITING_PAYMENT', 'WAITING_PAYMENT', 'AGUARDANDO', 'AGUARDANDO_PAGAMENTO', 'UNPAID', 'PENDING', 'PENDENTE', 'PROCESSING'].includes(s)) {
    if (paymentType === 'pix') return 'pix'
    if (paymentType === 'boleto') return 'boleto'
    if (paymentType === 'credit_card' || paymentType === 'debit_card') return 'cartao_recusado'
    return 'boleto'
  }
  return null // status desconhecido
}
const priorityMap = { cartao_recusado: 3, boleto: 2, pix: 2, carrinho_abandonado: 1, compra_aprovada: 0, disputa: 0 }

function brlToCents(v) {
  if (!v) return null
  const n = Number(String(v).replace(/\./g, '').replace(',', '.')) // "1.234,56" ou "37.00"
  // O export usa ponto decimal ("37.00"); se houver virgula tratamos acima.
  const direct = Number(v)
  const cents = Number.isFinite(direct) ? Math.round(direct * 100) : Math.round(n * 100)
  return Number.isFinite(cents) ? cents : null
}
function phoneNorm(p) {
  let d = (p || '').replace(/\D/g, '')
  if (!d) return null
  if (!d.startsWith('55')) d = '55' + d
  return d
}
// "14/06/2026 10:46:02" (BRT) -> "2026-06-14 13:46:02" (UTC, +3h), string sem tz
function dateBrtToUtcStr(s) {
  const m = (s || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, dd, mm, yyyy, hh, mi, ss] = m
  const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh + 3, +mi, +ss))
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

// ─── Monta os leads ─────────────────────────────────────────────────────────────
const parsed = []
const statusCount = {}
const typeCount = {}
for (const row of rows) {
  const id = get(row, 'id')
  if (!id) continue
  const status = get(row, 'status')
  const metodo = get(row, 'metodo')
  const motivoRecusa = get(row, 'motivoRecusa')
  const paymentType = mapMetodo(metodo)
  const eventType = mapEventType(status, paymentType, motivoRecusa)
  statusCount[`${status} / ${metodo}`] = (statusCount[`${status} / ${metodo}`] || 0) + 1
  typeCount[eventType || 'IGNORADO'] = (typeCount[eventType || 'IGNORADO'] || 0) + 1
  parsed.push({ row, id, status, metodo, motivoRecusa, paymentType, eventType })
}

console.log(`Linhas de pedido lidas: ${parsed.length}`)
console.log('\nPor (Status / Metodo):')
for (const [k, v] of Object.entries(statusCount)) console.log(`  ${k}: ${v}`)
console.log('\nClassificacao (event_type):')
for (const [k, v] of Object.entries(typeCount)) console.log(`  ${k}: ${v}`)

console.log('\nDetalhe linha a linha:')
for (const p of parsed) {
  const r = p.row
  console.log(`  ${p.id.slice(0,20)}.. | ${p.status}/${p.metodo} -> ${p.eventType || 'IGNORADO'} | ${get(r,'nome')} | ${phoneNorm(get(r,'telefone'))} | R$${get(r,'valor')} | ${get(r,'dataCriacao')} | ${get(r,'produtos').slice(0,30)}`)
}

// ─── Grava ────────────────────────────────────────────────────────────────────
if (!apply) {
  console.log('\n[DRY RUN] Nada gravado. Rode com --apply para inserir.')
  process.exit(0)
}

let inseridos = 0, pulados = 0, ignorados = 0
for (const p of parsed) {
  if (!p.eventType) { ignorados++; continue }
  const r = p.row
  const phone = phoneNorm(get(r, 'telefone'))
  if (!phone) { ignorados++; continue }

  // Idempotencia: ja existe esse pedido?
  const exists = await sql`
    select id from recovery_leads
    where company_id = ${COMPANY_ID} and transaction_id = ${p.id} limit 1`
  if (exists.length) { pulados++; continue }

  const dateUtc = dateBrtToUtcStr(get(r, 'dataCriacao'))
  const valueCents = brlToCents(get(r, 'valor'))
  const isApproved = p.eventType === 'compra_aprovada'

  const rawPayload = {
    source: 'backfill_xlsx',
    file: 'pedidos zouti.xlsx',
    columns: Object.fromEntries(Object.entries(COL).map(([k]) => [k, get(r, k)])),
  }

  await sql`
    insert into recovery_leads (
      company_id, platform, event_type, phone, name, email, cpf_cnpj,
      city, state, country, zipcode,
      product_id, product_name, product_value,
      transaction_id, payment_type, installments,
      tracking_source, tracking_source_sck, utm_medium, utm_campaign, utm_content, utm_term,
      affiliate_code, priority,
      order_date, approved_date, raw_payload, status,
      created_at, updated_at
    ) values (
      ${COMPANY_ID}, 'zouti', ${p.eventType}, ${phone}, ${get(r,'nome') || null}, ${get(r,'email') || null}, ${get(r,'documento') || null},
      ${get(r,'cidade') || null}, ${get(r,'estado') || null}, ${get(r,'pais') || null}, ${get(r,'cep') || null},
      ${get(r,'produtoId') || null}, ${get(r,'produtos') || null}, ${valueCents},
      ${p.id}, ${p.paymentType}, ${Number(get(r,'parcelas')) || null},
      ${get(r,'utmSource') || null}, ${get(r,'sck') || null}, ${get(r,'utmMedium') || null}, ${get(r,'utmCampaign') || null}, ${get(r,'utmContent') || null}, ${get(r,'utmTerm') || null},
      null, ${priorityMap[p.eventType] ?? 0},
      ${dateUtc}, ${isApproved ? dateUtc : null}, ${JSON.stringify(rawPayload)}, ${isApproved ? 'completed' : 'pending'},
      ${dateUtc}, ${dateUtc}
    )`
  inseridos++
}

console.log(`\nAPLICADO -> inseridos: ${inseridos} | pulados (ja existiam): ${pulados} | ignorados (sem tipo/telefone): ${ignorados}`)
process.exit(0)
