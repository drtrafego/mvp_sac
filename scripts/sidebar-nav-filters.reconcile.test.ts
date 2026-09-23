// Teste de RECONCILIAÇÃO dos filtros novos do menu lateral (sidebar.tsx).
//
// Contexto do bug real: instagramNav e mineracaoNav (src/components/layout/
// sidebar.tsx) apontavam pra telas genéricas SEM nenhum parâmetro de filtro
// (/inbox, /origens, /leads, /pipeline). O dono clicou em "Performance Direct"
// (vai pra /origens) e viu dado que não batia, porque a tela abria na visão
// geral, sem filtrar só Instagram. Auditoria completa (23/09/2026) achou o
// MESMO padrão em mais 4 seções: hotmartNav/kiwifyNav/greennNav/zoutiNav
// compartilham as MESMAS 5 telas de recuperação (/carrinho, /boleto, /pix,
// /cartao-recusado, /compra-aprovada) — "Boleto Kiwify" abria o mesmo lugar
// que "Boleto Bancário" (Hotmart), misturando lead de 4 plataformas juntas.
//
// Este teste sobe um Postgres DESCARTÁVEL de verdade (Docker, mesmo padrão de
// scripts/inbox-channel-filter.reconcile.test.ts), roda as MESMAS condições
// SQL que os arquivos de produção agora usam:
//   - channelWhereCondition(source) — src/lib/inbox-channel-filter.ts,
//     reaproveitado em src/app/api/leads/route.ts (?source=) e
//     src/app/(dashboard)/pipeline/page.tsx (?source=)
//   - eq(recoveryLeads.platform, platform) — src/app/api/leads/route.ts
//     (?platform=), consumido por src/components/recovery/sequence-page.tsx
// e afirma que cada link do menu (instagramNav, mineracaoNav, hotmartNav,
// kiwifyNav, greennNav, zoutiNav) só devolve leads da própria origem, nunca
// misturado com as outras.
//
// Uso:
//   npx tsx scripts/sidebar-nav-filters.reconcile.test.ts
//
// Por padrão sobe um container postgres:16-alpine descartável (precisa de
// Docker) numa porta livre, roda os testes e derruba o container ao final,
// mesmo em caso de falha. Pra rodar contra um Postgres já existente, exporte
// TEST_DATABASE_URL e o script pula o Docker.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and, sql } from 'drizzle-orm'
import { recoveryLeads } from '../src/lib/db/schema'
import { channelWhereCondition } from '../src/lib/inbox-channel-filter'
import { normalizeOrigin, type OriginCategory } from '../src/lib/origins'

type LeadFixture = {
  descricao: string
  secaoDoMenu: string
  channel: string | null
  platform: string | null
  trackingSource: string | null
  eventType: string | null
  phone: string
}

// Um lead por seção do menu lateral que hoje ganhou (ou já tinha) filtro real,
// gravado EXATAMENTE como o webhook/sync de produção grava (conferido lendo o
// código antes de escrever a fixture, não chutado):
//   - Instagram DM: src/app/api/webhooks/instagram/route.ts (platform='instagram', channel='instagram')
//   - Mineração: src/lib/sync-agents.ts bloco 4 (platform='sac', trackingSource='mineracao_prospeccao')
//     + o valor CANÔNICO real do CRM ("Minerador", ver comentário em inbox-channel-filter.ts)
//   - Hotmart/Kiwify/Greenn/Zouti: platform=<nome exato>, gravado pelos 4 webhooks de checkout
//   - Controle: lead de atendimento comum (SAC/WhatsApp), não deve aparecer em NENHUM filtro acima
const FIXTURES: LeadFixture[] = [
  {
    descricao: 'Instagram Direct (DM), lead real de conversa',
    secaoDoMenu: 'instagramNav → Conversas Direct / Leads Instagram / Performance Direct',
    channel: 'instagram',
    platform: 'instagram',
    trackingSource: null,
    eventType: 'atendimento',
    phone: '5511900020001',
  },
  {
    descricao: "Mineração via WhatsApp, trackingSource='mineracao_prospeccao' (valor mais comum gravado por sync-agents.ts)",
    secaoDoMenu: 'mineracaoNav → Leads Minerados / Canais de Mineração / Pipeline Prospecção',
    channel: 'whatsapp',
    platform: 'sac',
    trackingSource: 'mineracao_prospeccao',
    eventType: 'prospeccao',
    phone: '5511900020002',
  },
  {
    descricao: "Mineração via valor CANÔNICO do CRM 'Minerador' (não contém a palavra 'mineracao' inteira; ILIKE '%mineracao%' antigo NÃO pegava isto)",
    secaoDoMenu: 'mineracaoNav → Leads Minerados / Canais de Mineração / Pipeline Prospecção',
    channel: 'whatsapp',
    platform: 'sac',
    trackingSource: 'Minerador',
    eventType: 'prospeccao',
    phone: '5511900020003',
  },
  {
    descricao: 'Hotmart, carrinho abandonado',
    secaoDoMenu: 'hotmartNav → Carrinho abandonado (/carrinho?platform=hotmart)',
    channel: null,
    platform: 'hotmart',
    trackingSource: null,
    eventType: 'carrinho_abandonado',
    phone: '5511900020004',
  },
  {
    descricao: 'Kiwify, carrinho abandonado (MESMA tela /carrinho que Hotmart, plataforma diferente)',
    secaoDoMenu: 'kiwifyNav → Carrinho Kiwify (/carrinho?platform=kiwify)',
    channel: null,
    platform: 'kiwify',
    trackingSource: null,
    eventType: 'carrinho_abandonado',
    phone: '5511900020005',
  },
  {
    descricao: 'Greenn, boleto bancário (MESMA tela /boleto que Hotmart/Kiwify, plataforma diferente)',
    secaoDoMenu: 'greennNav → Boleto Greenn (/boleto?platform=greenn)',
    channel: null,
    platform: 'greenn',
    trackingSource: null,
    eventType: 'boleto',
    phone: '5511900020006',
  },
  {
    descricao: 'Zouti, Pix pendente (MESMA tela /pix que as outras 3 plataformas)',
    secaoDoMenu: 'zoutiNav → Pix Zouti (/pix?platform=zouti)',
    channel: null,
    platform: 'zouti',
    trackingSource: null,
    eventType: 'pix',
    phone: '5511900020007',
  },
  {
    descricao: 'Controle: atendimento comum via WhatsApp/SAC, não deve aparecer em NENHUM filtro de canal/plataforma acima',
    secaoDoMenu: '(nenhuma — item de controle)',
    channel: 'whatsapp',
    platform: 'sac',
    trackingSource: 'whatsapp_sac',
    eventType: 'atendimento',
    phone: '5511900020008',
  },
]

let passou = 0
let falhou = 0

async function caso(nome: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passou++
    console.log(`OK   ${nome}`)
  } catch (err) {
    falhou++
    console.error(`FAIL ${nome}`)
    console.error(err instanceof Error ? err.message : err)
  }
}

async function pickFreePortAsync(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object' && addr) {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('não deu pra alocar porta livre')))
      }
    })
  })
}

const CONTAINER_NAME = 'sidebar_nav_filters_reconcile_test'

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

async function startDisposablePostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePortAsync()
  console.log(`[setup] subindo postgres:16-alpine descartável na porta ${port} (container ${CONTAINER_NAME})...`)
  execFileSync('docker', [
    'run',
    '--rm',
    '-d',
    '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`,
    'postgres:16-alpine',
  ])

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`

  const deadline = Date.now() + 30_000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 500))
    }
  }
  if (lastErr) {
    throw new Error(`postgres descartável não respondeu a tempo: ${String(lastErr)}`)
  }

  return {
    url,
    stop: () => {
      console.log('[teardown] derrubando container descartável...')
      spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
    },
  }
}

async function main() {
  let stopContainer: (() => void) | null = null
  let databaseUrl = process.env.TEST_DATABASE_URL

  if (!databaseUrl) {
    if (!dockerAvailable()) {
      console.error(
        'Sem TEST_DATABASE_URL e sem Docker disponível. Exporte TEST_DATABASE_URL apontando pra um Postgres ' +
          'descartável, ou rode este script num ambiente com Docker.'
      )
      process.exitCode = 1
      return
    }
    const disposable = await startDisposablePostgres()
    databaseUrl = disposable.url
    stopContainer = disposable.stop
  } else {
    console.log('[setup] usando TEST_DATABASE_URL fornecido, pulando Docker.')
  }

  const client = postgres(databaseUrl)
  const db = drizzle(client)

  try {
    console.log('[setup] criando tabela mínima recovery_leads (só as colunas que os filtros do menu usam)...')
    await client`
      CREATE TABLE recovery_leads (
        id serial PRIMARY KEY,
        phone text NOT NULL,
        channel text,
        platform text,
        tracking_source text,
        event_type text
      )
    `

    console.log(`[setup] inserindo ${FIXTURES.length} leads de fixture (um por seção do menu lateral + 1 controle)...`)
    const ids: number[] = []
    for (const f of FIXTURES) {
      const [row] = await client<{ id: number }[]>`
        INSERT INTO recovery_leads (phone, channel, platform, tracking_source, event_type)
        VALUES (${f.phone}, ${f.channel}, ${f.platform}, ${f.trackingSource}, ${f.eventType})
        RETURNING id
      `
      ids.push(row.id)
    }
    const idByPhone = new Map(FIXTURES.map((f, i) => [f.phone, ids[i]]))

    const instagramLead = FIXTURES[0]
    const mineracaoLead1 = FIXTURES[1]
    const mineracaoLead2Canonico = FIXTURES[2]
    const hotmartLead = FIXTURES[3]
    const kiwifyLead = FIXTURES[4]
    const greennLead = FIXTURES[5]
    const zoutiLead = FIXTURES[6]
    const controleLead = FIXTURES[7]

    // ── 1. instagramNav: /leads?source=instagram e /pipeline (mesma condição
    // channelWhereCondition, reaproveitada em src/app/api/leads/route.ts e em
    // src/app/(dashboard)/pipeline/page.tsx) ──────────────────────────────
    await caso(
      '[instagramNav] channelWhereCondition("instagram") traz SÓ o lead de Instagram, exclui mineração/checkout/controle',
      async () => {
        const cond = channelWhereCondition('instagram')!
        const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(cond)
        const idsRetornados = new Set(rows.map(r => r.id))
        assert.equal(idsRetornados.size, 1, `esperava 1 lead, veio ${idsRetornados.size}`)
        assert.ok(idsRetornados.has(idByPhone.get(instagramLead.phone)!), 'deveria incluir o lead de Instagram')
        for (const outro of [mineracaoLead1, mineracaoLead2Canonico, hotmartLead, kiwifyLead, greennLead, zoutiLead, controleLead]) {
          assert.ok(!idsRetornados.has(idByPhone.get(outro.phone)!), `NÃO deveria incluir "${outro.descricao}"`)
        }
      }
    )

    // ── 2. mineracaoNav: /leads?source=mineracao e /pipeline?source=mineracao
    // (ANTES desta correção, /pipeline não filtrava NADA, e /leads usava um
    // ILIKE '%mineracao%' solto que não pegava o valor canônico "Minerador"
    // do CRM) ──────────────────────────────────────────────────────────────
    await caso(
      '[mineracaoNav] channelWhereCondition("mineracao") traz os 2 leads de mineração (inclusive o valor canônico "Minerador"), exclui o resto',
      async () => {
        const cond = channelWhereCondition('mineracao')!
        const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(cond)
        const idsRetornados = new Set(rows.map(r => r.id))
        assert.equal(idsRetornados.size, 2, `esperava 2 leads, veio ${idsRetornados.size}`)
        assert.ok(idsRetornados.has(idByPhone.get(mineracaoLead1.phone)!), 'deveria incluir mineração via trackingSource="mineracao_prospeccao"')
        assert.ok(
          idsRetornados.has(idByPhone.get(mineracaoLead2Canonico.phone)!),
          'deveria incluir mineração via valor canônico do CRM "Minerador" (regressão real: ILIKE antigo perdia este caso)'
        )
        for (const outro of [instagramLead, hotmartLead, kiwifyLead, greennLead, zoutiLead, controleLead]) {
          assert.ok(!idsRetornados.has(idByPhone.get(outro.phone)!), `NÃO deveria incluir "${outro.descricao}"`)
        }
      }
    )

    await caso(
      '[mineracaoNav] regressão documentada: o ILIKE de texto livre antigo ("%mineracao%") teria PERDIDO o lead "Minerador" do CRM',
      () => {
        const bateriaNoIlikeAntigo = (mineracaoLead2Canonico.trackingSource ?? '').toLowerCase().includes('mineracao')
        assert.equal(
          bateriaNoIlikeAntigo,
          false,
          'este teste documenta que "Minerador" NÃO contém a substring "mineracao" — é exatamente o gap que channelWhereCondition (borda de palavra "miner") resolve'
        )
      }
    )

    // ── 3, 4, 5, 6. hotmartNav/kiwifyNav/greennNav/zoutiNav: as 5 telas de
    // recuperação são COMPARTILHADAS pelas 4 plataformas (mesmo componente
    // SequencePage, mesmo endpoint /api/leads); só ?platform= diferencia.
    // Reproduz aqui a MESMA condição usada em src/app/api/leads/route.ts. ──
    const checkoutCases: { plataforma: string; leadEsperado: LeadFixture; secao: string }[] = [
      { plataforma: 'hotmart', leadEsperado: hotmartLead, secao: 'hotmartNav' },
      { plataforma: 'kiwify', leadEsperado: kiwifyLead, secao: 'kiwifyNav' },
      { plataforma: 'greenn', leadEsperado: greennLead, secao: 'greennNav' },
      { plataforma: 'zouti', leadEsperado: zoutiLead, secao: 'zoutiNav' },
    ]

    for (const { plataforma, leadEsperado, secao } of checkoutCases) {
      await caso(
        `[${secao}] ?platform=${plataforma} (eq(recoveryLeads.platform, ...), igual a src/app/api/leads/route.ts) traz SÓ o lead de ${plataforma}`,
        async () => {
          const rows = await db
            .select({ id: recoveryLeads.id })
            .from(recoveryLeads)
            .where(and(eq(recoveryLeads.eventType, leadEsperado.eventType!), eq(recoveryLeads.platform, plataforma)))
          const idsRetornados = new Set(rows.map(r => r.id))
          assert.equal(idsRetornados.size, 1, `esperava 1 lead pra platform=${plataforma}, veio ${idsRetornados.size}`)
          assert.ok(idsRetornados.has(idByPhone.get(leadEsperado.phone)!), `deveria incluir o lead de ${plataforma}`)
        }
      )
    }

    await caso(
      '[checkout] REGRESSÃO DIRETA DO BUG: mesma tela (/carrinho, eventType=carrinho_abandonado) SEM ?platform= misturava Hotmart e Kiwify juntos',
      async () => {
        // Comportamento ANTIGO (bug real): SequencePage buscava só por
        // event_type, sem platform nenhum — reproduzido aqui de propósito
        // pra provar que o sintoma existia antes da correção.
        const rowsSemFiltro = await db
          .select({ id: recoveryLeads.id, platform: recoveryLeads.platform })
          .from(recoveryLeads)
          .where(eq(recoveryLeads.eventType, 'carrinho_abandonado'))
        const plataformasMisturadas = new Set(rowsSemFiltro.map(r => r.platform))
        assert.ok(
          plataformasMisturadas.has('hotmart') && plataformasMisturadas.has('kiwify'),
          'pré-condição do teste: a tabela precisa ter carrinho_abandonado de hotmart E kiwify pra provar a mistura'
        )
        assert.ok(plataformasMisturadas.size >= 2, 'confirma o bug: mesma query misturava mais de uma plataforma')

        // Comportamento NOVO (com platform=): cada plataforma isolada.
        const rowsHotmart = await db
          .select({ platform: recoveryLeads.platform })
          .from(recoveryLeads)
          .where(and(eq(recoveryLeads.eventType, 'carrinho_abandonado'), eq(recoveryLeads.platform, 'hotmart')))
        assert.ok(rowsHotmart.every(r => r.platform === 'hotmart'), 'com platform=hotmart, só pode vir hotmart')
      }
    )

    // ── 7. /origens?source= usa uma função DIFERENTE (normalizeOrigin, em
    // memória, já filtrada por matchesSourceFilter dentro do próprio
    // src/app/(dashboard)/origens/page.tsx), não channelWhereCondition.
    // Pra 'instagram'/'mineracao' (não estão em SUBCATEGORY_FILTERS daquele
    // arquivo), matchesSourceFilter reduz a `meta.category === source` —
    // conferido lendo o código antes de escrever este teste, não reimplementado
    // aqui como heurística própria. Confere que os dois caminhos (Origens vs.
    // Inbox/Leads/Pipeline) concordam pros MESMOS leads. ─────────────────────
    await caso(
      '[instagramNav → /origens?source=instagram] normalizeOrigin concorda com channelWhereCondition',
      () => {
        const meta = normalizeOrigin(instagramLead.trackingSource, null, instagramLead.platform, instagramLead.eventType, instagramLead.channel)
        assert.equal(meta.category as OriginCategory, 'instagram')
      }
    )

    await caso(
      '[mineracaoNav → /origens?source=mineracao] normalizeOrigin concorda com channelWhereCondition, inclusive pro valor canônico "Minerador"',
      () => {
        for (const lead of [mineracaoLead1, mineracaoLead2Canonico]) {
          const meta = normalizeOrigin(lead.trackingSource, null, lead.platform, lead.eventType, lead.channel)
          assert.equal(meta.category as OriginCategory, 'mineracao', `"${lead.descricao}" deveria cair em category=mineracao em normalizeOrigin`)
        }
      }
    )

    // ── 8. Sanidade final: cada seção do menu, isolada, nunca devolve o lead
    // de controle (atendimento comum) nem o de outra seção. ────────────────
    const todasCondicoesDeCanal: { nome: string; cond: any }[] = [
      { nome: 'instagram', cond: channelWhereCondition('instagram') },
      { nome: 'mineracao', cond: channelWhereCondition('mineracao') },
    ]
    for (const { nome, cond } of todasCondicoesDeCanal) {
      await caso(`[sanidade] filtro de canal "${nome}" nunca inclui o lead de controle (atendimento comum)`, async () => {
        const rows = await db
          .select({ id: recoveryLeads.id })
          .from(recoveryLeads)
          .where(sql`${recoveryLeads.id} = ${idByPhone.get(controleLead.phone)} and ${cond}`)
        assert.equal(rows.length, 0, `o lead de controle não deveria bater no filtro "${nome}"`)
      })
    }
    for (const plataforma of ['hotmart', 'kiwify', 'greenn', 'zouti']) {
      await caso(`[sanidade] ?platform=${plataforma} nunca inclui o lead de controle (platform='sac')`, async () => {
        const rows = await db
          .select({ id: recoveryLeads.id })
          .from(recoveryLeads)
          .where(and(eq(recoveryLeads.id, idByPhone.get(controleLead.phone)!), eq(recoveryLeads.platform, plataforma)))
        assert.equal(rows.length, 0, `o lead de controle não deveria bater em platform=${plataforma}`)
      })
    }
  } finally {
    await client.end({ timeout: 2 })
    if (stopContainer) stopContainer()
  }

  console.log(`\n${passou} passaram, ${falhou} falharam.`)
  if (falhou > 0) process.exitCode = 1
}

main().catch(err => {
  console.error('Erro fatal no teste de reconciliação:', err)
  process.exitCode = 1
})
