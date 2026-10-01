// Teste de RECONCILIAÇÃO do filtro de canal do Inbox (src/lib/inbox-channel-filter.ts).
//
// Contexto: esta é a 4ª rodada de correção da mesma heurística. As rodadas
// anteriores acharam overlap com WhatsApp, buraco de NULL/vazio e overlap
// textual entre instagram/email/mineracao (dois padrões de `ilike` batendo
// no mesmo tracking_source). Este teste sobe um Postgres DESCARTÁVEL de
// verdade (Docker), roda channelWhereCondition() e classifyChannelInMemory()
// exatamente como o produto roda, e afirma pra CADA caso de borda das 4
// rodadas: soma dos buckets == total, sem overlap, sem buraco, e SQL bate
// com memória célula por célula. Sem isso, cada rodada nova só teria
// descoberto o problema em produção de novo.
//
// Uso:
//   npx tsx scripts/inbox-channel-filter.reconcile.test.ts
//
// Por padrão sobe um container postgres:16-alpine descartável (precisa de
// Docker) numa porta livre, roda os testes e derruba o container ao final,
// mesmo em caso de falha. Pra rodar contra um Postgres já existente (CI sem
// Docker, por exemplo), exporte TEST_DATABASE_URL e o script pula o Docker.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { recoveryLeads } from '../src/lib/db/schema'
import {
  channelWhereCondition,
  classifyAnuncioSubcategory,
  classifyChannelInMemory,
  classifyMineracaoSubchannel,
  type AnuncioSubcategory,
  type ChannelClassification,
  type MineracaoSubchannel,
} from '../src/lib/inbox-channel-filter'
import { normalizeOrigin } from '../src/lib/origins'

type Categoria = 'mineracao' | 'anuncio' | 'email' | 'instagram' | 'whatsapp'

type LeadFixture = {
  descricao: string
  // origem do bug (rodada em que foi encontrado, pra rastrear regressão)
  origem: string
  channel: string | null
  platform: string | null
  trackingSource: string | null
  phone: string
  esperado: Categoria
  // Só preenchido quando esperado === 'mineracao': qual o canal REAL de
  // contato dentro do universo mineracao (a granularidade nova pedida pelo
  // Gastão). Fixtures sem esse campo não entram nos testes de subcategoria.
  esperadoSub?: MineracaoSubchannel
  // Só preenchido quando esperado === 'anuncio': plataforma paga reconhecida
  // dentro do universo Anúncio.
  esperadoAnuncioSub?: AnuncioSubcategory
}

const FIXTURES: LeadFixture[] = [
  // ── Rodada 1: overlap com WhatsApp / buraco de NULL ─────────────────────
  {
    descricao: 'tudo NULL, phone comum: cai no else (whatsapp)',
    origem: 'rodada 1',
    channel: null,
    platform: null,
    trackingSource: null,
    phone: '5511911112222',
    esperado: 'whatsapp',
  },
  {
    descricao: "channel='whatsapp' explícito",
    origem: 'rodada 1',
    channel: 'whatsapp',
    platform: null,
    trackingSource: null,
    phone: '5511911113333',
    esperado: 'whatsapp',
  },
  // ── Rodada 2: buraco de NULL/vazio em campos que apontam pra outro canal ─
  {
    descricao: "channel=NULL, trackingSource='instagram_ads_agosto': agora é Anúncio (Meta), não Direct orgânico",
    origem: 'rodada 8',
    channel: null,
    platform: null,
    trackingSource: 'instagram_ads_agosto',
    phone: '5511922221111',
    esperado: 'anuncio',
    esperadoAnuncioSub: 'meta_ads',
  },
  {
    descricao: "channel=NULL, platform de outro canal (mineracao)",
    origem: 'rodada 2',
    channel: null,
    platform: 'mineracao',
    trackingSource: null,
    phone: '5511933334444',
    esperado: 'mineracao',
    esperadoSub: 'whatsapp', // sem sinal de email/instagram: cai no else (WhatsApp Outreach)
  },
  {
    descricao: "channel='' (string vazia): não é 'whatsapp' por engano nem quebra o WHERE",
    origem: 'rodada 2',
    channel: '',
    platform: null,
    trackingSource: null,
    phone: '5511944445555',
    esperado: 'whatsapp',
  },
  // ── Rodada 3: overlap textual entre categorias (o motivo desta rodada) ──
  {
    descricao: "trackingSource='instagram_email_crosspost': bate em instagram E email, precedência decide email",
    origem: 'rodada 3',
    channel: null,
    platform: null,
    trackingSource: 'instagram_email_crosspost',
    phone: '5511955556666',
    esperado: 'email',
  },
  {
    descricao: "trackingSource='prospeccao_email_followup': bate em mineracao E email, precedência decide mineracao",
    origem: 'rodada 3',
    channel: null,
    platform: null,
    trackingSource: 'prospeccao_email_followup',
    phone: '5511966667777',
    esperado: 'mineracao',
    esperadoSub: 'email', // dentro de mineracao, o canal real de contato É email
  },
  {
    descricao: "channel='instagram' explícito + trackingSource='brevo_newsletter': bate em instagram E email, precedência decide email",
    origem: 'rodada 3',
    channel: 'instagram',
    platform: null,
    trackingSource: 'brevo_newsletter',
    phone: '5511977778888',
    esperado: 'email',
  },
  {
    descricao: "trackingSource='PROSPECCAO_INSTAGRAM_MINERACAO' (maiúsculo): bate em mineracao E instagram, precedência decide mineracao",
    origem: 'rodada 3',
    channel: null,
    platform: null,
    trackingSource: 'PROSPECCAO_INSTAGRAM_MINERACAO',
    phone: '5511988889999',
    esperado: 'mineracao',
    esperadoSub: 'instagram', // dentro de mineracao, o canal real de contato É instagram
  },
  // ── Rodada 4 (esta): case-sensitivity ────────────────────────────────────
  {
    descricao: "channel='Instagram' (maiúsculo): precisa cair em instagram, não em whatsapp",
    origem: 'rodada 4',
    channel: 'Instagram',
    platform: null,
    trackingSource: null,
    phone: '5511999990000',
    esperado: 'instagram',
  },
  {
    descricao: "phone='IG_5511999991111' (prefixo maiúsculo): precisa cair em instagram, não em whatsapp",
    origem: 'rodada 4',
    channel: null,
    platform: null,
    trackingSource: null,
    phone: 'IG_5511999991111',
    esperado: 'instagram',
  },
  // ── Casos de controle (garantem que o básico continua certo) ────────────
  {
    descricao: "channel='email' explícito, sem tracking",
    origem: 'controle',
    channel: 'email',
    platform: null,
    trackingSource: null,
    phone: '5511900001111',
    esperado: 'email',
  },
  {
    descricao: "channel='mineracao' explícito, sem tracking",
    origem: 'controle',
    channel: 'mineracao',
    platform: null,
    trackingSource: null,
    phone: '5511900002222',
    esperado: 'mineracao',
    esperadoSub: 'whatsapp', // sem sinal de email/instagram: cai no else
  },
  {
    descricao: "platform='instagram', channel NULL",
    origem: 'controle',
    channel: null,
    platform: 'instagram',
    trackingSource: null,
    phone: '5511900003333',
    esperado: 'instagram',
  },
  {
    descricao: "trackingSource='brevo_campanha_natal', sem channel/platform",
    origem: 'controle',
    channel: null,
    platform: null,
    trackingSource: 'brevo_campanha_natal',
    phone: '5511900004444',
    esperado: 'email',
  },
  {
    descricao: "phone com prefixo ig_ minúsculo, sem outro sinal",
    origem: 'controle',
    channel: null,
    platform: null,
    trackingSource: null,
    phone: 'ig_5511900005555',
    esperado: 'instagram',
  },
  {
    descricao: "trackingSource='fb_ads_campanha_x': anúncio pago Meta deve cair em Anúncio > Meta Ads",
    origem: 'rodada 8',
    channel: null,
    platform: 'hotmart',
    trackingSource: 'fb_ads_campanha_x',
    phone: '5511900006666',
    esperado: 'anuncio',
    esperadoAnuncioSub: 'meta_ads',
  },
  {
    descricao: "channel=NULL, platform='greenn' (plataforma de venda, não é canal de conversa)",
    origem: 'controle',
    channel: null,
    platform: 'greenn',
    trackingSource: null,
    phone: '5511900007777',
    esperado: 'whatsapp',
  },
  // ── Rodada 5 (esta): granularidade nova — subcategoria de canal real DENTRO
  // de mineracao (pedido do Gastão em 21/09/2026, depois do bug de e-mail
  // sumido: mineracao continua vencendo no canal principal, mas agora tem
  // uma segunda dimensão de filtro pelo canal real de contato) ────────────
  {
    descricao: "mineracao via platform='mineracao' + channel='email' explícito: sub deve ser email (não só tracking_source aciona sub)",
    origem: 'rodada 5',
    channel: 'email',
    platform: 'mineracao',
    trackingSource: null,
    phone: '5511900011111',
    esperado: 'mineracao',
    esperadoSub: 'email',
  },
  {
    descricao: "mineracao via channel='mineracao' + channel também bateria... trackingSource='mineracao_whatsapp_outreach', sem sinal de email/instagram: sub cai no else (whatsapp)",
    origem: 'rodada 5',
    channel: null,
    platform: null,
    trackingSource: 'mineracao_whatsapp_outreach',
    phone: '5511900022222',
    esperado: 'mineracao',
    esperadoSub: 'whatsapp',
  },
  {
    descricao: "mineracao via trackingSource='mineracao_prospeccao' + channel='instagram' explícito: sub deve ser instagram",
    origem: 'rodada 5',
    channel: 'instagram',
    platform: null,
    trackingSource: 'mineracao_prospeccao',
    phone: '5511900033333',
    esperado: 'mineracao',
    esperadoSub: 'instagram',
  },
  {
    descricao: "mineracao via trackingSource='prospeccao_direct_frio' + phone com prefixo ig_: sub deve ser instagram (sinal duplo, mesma direção)",
    origem: 'rodada 5',
    channel: null,
    platform: null,
    trackingSource: 'prospeccao_direct_frio',
    phone: 'ig_5511900044444',
    esperado: 'mineracao',
    esperadoSub: 'instagram',
  },
  {
    descricao: "mineracao via trackingSource='mineracao_instagram_email_crosspost': bate em email E instagram DENTRO do sub, precedência do sub decide email (mesmo motivo de colisão textual do nível principal)",
    origem: 'rodada 5',
    channel: null,
    platform: null,
    trackingSource: 'mineracao_instagram_email_crosspost',
    phone: '5511900055555',
    esperado: 'mineracao',
    esperadoSub: 'email',
  },
  {
    descricao: "mineracao via platform='mineracao' + channel='EMAIL' (maiúsculo): sub precisa cair em email, não em whatsapp (case-sensitivity dentro do sub, mesmo bug da rodada 4)",
    origem: 'rodada 5',
    channel: 'EMAIL',
    platform: 'mineracao',
    trackingSource: null,
    phone: '5511900066666',
    esperado: 'mineracao',
    esperadoSub: 'email',
  },
  {
    descricao: "mineracao via platform='mineracao' + phone='IG_5511900077777' (prefixo maiúsculo): sub precisa cair em instagram, não em whatsapp",
    origem: 'rodada 5',
    channel: null,
    platform: 'mineracao',
    trackingSource: null,
    phone: 'IG_5511900077777',
    esperado: 'mineracao',
    esperadoSub: 'instagram',
  },
  // ── Rodada 6 (esta): trackingIncludes estreito divergia de origins.ts ──────
  // Achado real em produção (22/09/2026): o CRM grava campaign_source
  // canônico "Minerador" (ver /opt/gastaomatos/conexoes_comuns/crm.md) e
  // sync-agents.ts (bloco 5) grava esse valor direto em trackingSource
  // (`l.campaign_source || l.utm_source || 'mineracao_prospeccao'`, e
  // campaign_source não é nulo, então o fallback nunca disparava). "Minerador"
  // bate em origins.ts (que já tinha 'miner') mas NÃO batia na lista antiga
  // de inbox-channel-filter.ts (só 'mineracao'/'prospeccao'): o lead aparecia
  // certo em Origens e sumia da aba Mineração do Inbox. Estes 3 casos cobrem
  // os 3 termos novos adicionados ('miner', 'mining', 'places').
  {
    descricao: "trackingSource='Minerador' (valor canônico exato gravado pelo CRM/sync-agents.ts, com maiúscula)",
    origem: 'rodada 6',
    channel: null,
    platform: null,
    trackingSource: 'Minerador',
    phone: '5511900088888',
    esperado: 'mineracao',
    esperadoSub: 'whatsapp',
  },
  {
    descricao: "trackingSource='mining_campaign_leads' (termo novo 'mining')",
    origem: 'rodada 6',
    channel: null,
    platform: null,
    trackingSource: 'mining_campaign_leads',
    phone: '5511900099999',
    esperado: 'mineracao',
    esperadoSub: 'whatsapp',
  },
  {
    descricao: "trackingSource='google_places_scraper' (termo novo 'places', ferramenta de mineração via Google Maps)",
    origem: 'rodada 6',
    channel: null,
    platform: null,
    trackingSource: 'google_places_scraper',
    phone: '5511900010101',
    esperado: 'mineracao',
    esperadoSub: 'whatsapp',
  },
  // ── Rodada 7 (esta): ILIKE/`.includes()` por SUBSTRING SOLTA (sem borda de
  // palavra) colidia com texto livre de TERCEIROS que chega em
  // trackingSource pelos 4 checkouts (Hotmart/Greenn/Zouti/Kiwify), onde o
  // valor vem direto de utm_source/tracking.source controlado pelo
  // afiliado/vendedor, não é texto interno. Achado do QA (22/09/2026), 2 dos
  // 3 exemplos confirmados e corrigidos por borda de palavra (só do lado
  // ESQUERDO: ver wordBoundaryPattern em inbox-channel-filter.ts e
  // hasWordBoundary em origins.ts — borda nos dois lados quebraria o valor
  // canônico real "Minerador" da rodada 6, que tem 'miner' como PREFIXO de
  // palavra maior, não palavra isolada).
  //
  // ⚠️ NÃO incluído aqui: "bitcoin_mining_influencer_promo" (3º exemplo do
  // QA). Continua classificando como mineracao=true mesmo depois da correção:
  // 'mining' aparece lá como palavra INTEIRA, delimitada por '_' dos dois
  // lados, estruturalmente idêntica ao caso legítimo
  // "mining_campaign_leads" (fixture da rodada 6, algumas linhas acima).
  // Nenhuma regra de borda de texto distingue os dois; corrigir isso exige
  // uma regra de negócio nova (lista de exclusão tipo "bitcoin"/"cripto"),
  // que é decisão de produto, não faz parte desta correção. Reportado
  // separadamente, não escondido nem forçado a passar aqui.
  {
    descricao: "trackingSource='hotmart_marketplaces_afiliados': 'places' aparece como SUFIXO de 'marketplaces' (precedido de letra), não deve virar Mineração",
    origem: 'rodada 7',
    channel: null,
    platform: 'hotmart',
    trackingSource: 'hotmart_marketplaces_afiliados',
    phone: '5511900012121',
    esperado: 'whatsapp',
  },
  {
    descricao: "trackingSource='facebook_ads_examiner_leads': 'miner' aparece como SUFIXO de 'examiner' (precedido de letra), não deve virar Mineração; deve virar Anúncio Meta",
    origem: 'rodada 7',
    channel: null,
    platform: null,
    trackingSource: 'facebook_ads_examiner_leads',
    phone: '5511900013131',
    esperado: 'anuncio',
    esperadoAnuncioSub: 'meta_ads',
  },
  // ── Rodada 8 (esta): categoria principal Anúncio com subcategorias Meta Ads
  // e Google Ads. Dado real confirmado hoje: CTWA e Meta Conversions API já
  // gravam trackingSource='meta_ads'. Não existe coluna gclid no schema atual
  // nem uso real de gclid encontrado no repo; Google fica preparado via
  // tracking_source/utm_source com "google", "google_ads" ou "gclid".
  {
    descricao: "trackingSource='meta_ads' (valor real gravado por CTWA e Meta Conversions API)",
    origem: 'rodada 8',
    channel: null,
    platform: null,
    trackingSource: 'meta_ads',
    phone: '5511900014141',
    esperado: 'anuncio',
    esperadoAnuncioSub: 'meta_ads',
  },
  {
    descricao: "trackingSource='google_ads' (estrutura pronta para UTM de Google Ads)",
    origem: 'rodada 8',
    channel: null,
    platform: null,
    trackingSource: 'google_ads',
    phone: '5511900015151',
    esperado: 'anuncio',
    esperadoAnuncioSub: 'google_ads',
  },
  {
    descricao: "trackingSource='google' (utm_source=google, sem coluna gclid no schema atual)",
    origem: 'rodada 8',
    channel: null,
    platform: null,
    trackingSource: 'google',
    phone: '5511900016161',
    esperado: 'anuncio',
    esperadoAnuncioSub: 'google_ads',
  },
  {
    descricao: "trackingSource='gclid' salvo como source textual: estrutura pronta para Google Ads",
    origem: 'rodada 8',
    channel: null,
    platform: null,
    trackingSource: 'gclid',
    phone: '5511900017171',
    esperado: 'anuncio',
    esperadoAnuncioSub: 'google_ads',
  },
  {
    descricao: "trackingSource='crm_parameta_interno': 'meta' aparece colado dentro de palavra maior, não deve virar Anúncio",
    origem: 'rodada 8',
    channel: null,
    platform: null,
    trackingSource: 'crm_parameta_interno',
    phone: '5511900018181',
    esperado: 'whatsapp',
  },
  {
    descricao: "trackingSource='xgoogle_relatorio': 'google' aparece sem borda à esquerda, não deve virar Google Ads",
    origem: 'rodada 8',
    channel: null,
    platform: null,
    trackingSource: 'xgoogle_relatorio',
    phone: '5511900019191',
    esperado: 'whatsapp',
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

const CONTAINER_NAME = 'inbox_channel_filter_reconcile_test'

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

async function startDisposablePostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
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

  // Espera o banco aceitar conexão (retry simples, até 30s).
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
      spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
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
    console.log('[setup] criando tabela mínima recovery_leads (só as colunas que a heurística usa)...')
    // Colunas mínimas, com os MESMOS nomes que src/lib/db/schema.ts mapeia
    // pra recoveryLeads.{id,phone,channel,platform,trackingSource}. Não
    // precisa das ~30 outras colunas notNull da tabela real: drizzle só
    // referencia (SELECT/WHERE) as colunas que a query realmente usa.
    await client`
      CREATE TABLE recovery_leads (
        id serial PRIMARY KEY,
        phone text NOT NULL,
        channel text,
        platform text,
        tracking_source text
      )
    `

    console.log(`[setup] inserindo ${FIXTURES.length} leads de fixture (todos os casos de borda das rodadas cobertas)...`)
    const ids: number[] = []
    for (const f of FIXTURES) {
      const [row] = await client<{ id: number }[]>`
        INSERT INTO recovery_leads (phone, channel, platform, tracking_source)
        VALUES (${f.phone}, ${f.channel}, ${f.platform}, ${f.trackingSource})
        RETURNING id
      `
      ids.push(row.id)
    }
    const idByIndex = new Map(FIXTURES.map((f, i) => [i, ids[i]]))
    const fixtureByIndexId = new Map(ids.map((id, i) => [id, FIXTURES[i]]))

    // ── 1. Caso a caso: SQL bate com a descrição, e memória bate com o SQL ──
    for (let i = 0; i < FIXTURES.length; i++) {
      const f = FIXTURES[i]
      const id = idByIndex.get(i)!

      await caso(`[${f.origem}] SQL classifica "${f.descricao}" como '${f.esperado}'`, async () => {
        const cond = channelWhereCondition(f.esperado)!
        const rows = await db
          .select({ id: recoveryLeads.id })
          .from(recoveryLeads)
          .where(sql`${recoveryLeads.id} = ${id} and ${cond}`)
        assert.equal(rows.length, 1, `lead ${id} deveria bater na condição SQL de '${f.esperado}'`)
      })

      await caso(`[${f.origem}] SQL NÃO classifica "${f.descricao}" nas outras categorias`, async () => {
        const outras: Categoria[] = (['mineracao', 'anuncio', 'email', 'instagram', 'whatsapp'] as Categoria[]).filter(
          c => c !== f.esperado
        )
        for (const outra of outras) {
          const cond = channelWhereCondition(outra)!
          const rows = await db
            .select({ id: recoveryLeads.id })
            .from(recoveryLeads)
            .where(sql`${recoveryLeads.id} = ${id} and ${cond}`)
          assert.equal(rows.length, 0, `lead ${id} NÃO deveria bater em '${outra}' (esperado só '${f.esperado}')`)
        }
      })

      await caso(`[${f.origem}] memória (classifyChannelInMemory) bate com o esperado para "${f.descricao}"`, () => {
        const classificacao = classifyChannelInMemory(f)
        const chave = (`is${f.esperado[0].toUpperCase()}${f.esperado.slice(1)}` as keyof ChannelClassification)
        assert.equal(classificacao[chave], true, `classifyChannelInMemory deveria marcar ${String(chave)}=true`)
        const totalTrue = Object.values(classificacao).filter(Boolean).length
        assert.equal(totalTrue, 1, 'classifyChannelInMemory deveria marcar exatamente UMA categoria como true')
      })
    }

    // ── 2. Reconciliação agregada: soma dos buckets == total, sem overlap ───
    await caso(`reconciliação agregada: soma dos 5 buckets == total (${FIXTURES.length} leads), sem overlap, sem buraco`, async () => {
      const [row] = await db
        .select({
          total: sql<number>`count(*)`,
          mineracao: sql<number>`count(*) filter (where ${channelWhereCondition('mineracao')})`,
          anuncio: sql<number>`count(*) filter (where ${channelWhereCondition('anuncio')})`,
          email: sql<number>`count(*) filter (where ${channelWhereCondition('email')})`,
          instagram: sql<number>`count(*) filter (where ${channelWhereCondition('instagram')})`,
          whatsapp: sql<number>`count(*) filter (where ${channelWhereCondition('whatsapp')})`,
        })
        .from(recoveryLeads)

      const total = Number(row.total)
      const soma = Number(row.mineracao) + Number(row.anuncio) + Number(row.email) + Number(row.instagram) + Number(row.whatsapp)

      assert.equal(total, FIXTURES.length, 'total de leads na tabela deveria ser igual ao total de fixtures')
      assert.equal(soma, total, `soma dos 5 buckets (${soma}) deveria ser IGUAL ao total (${total}) — overlap ou buraco`)
    })

    // ── 3. Nenhum lead aparece em mais de um bucket (overlap direto, id a id) ─
    await caso('nenhum lead aparece em mais de uma categoria SQL ao mesmo tempo (overlap direto)', async () => {
      const categorias: Categoria[] = ['mineracao', 'anuncio', 'email', 'instagram', 'whatsapp']
      const contagemPorId = new Map<number, string[]>()
      for (const categoria of categorias) {
        const cond = channelWhereCondition(categoria)!
        const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(cond)
        for (const r of rows) {
          contagemPorId.set(r.id, [...(contagemPorId.get(r.id) ?? []), categoria])
        }
      }
      const comOverlap = [...contagemPorId.entries()].filter(([, cats]) => cats.length > 1)
      const semCategoria = ids.filter(id => !contagemPorId.has(id))
      if (comOverlap.length > 0) {
        const detalhe = comOverlap
          .map(([id, cats]) => `lead ${id} (${fixtureByIndexId.get(id)?.descricao}) em [${cats.join(', ')}]`)
          .join('; ')
        assert.fail(`overlap encontrado: ${detalhe}`)
      }
      if (semCategoria.length > 0) {
        const detalhe = semCategoria
          .map(id => `lead ${id} (${fixtureByIndexId.get(id)?.descricao})`)
          .join('; ')
        assert.fail(`buraco encontrado (lead em NENHUMA categoria): ${detalhe}`)
      }
    })

    // ── 4. SQL e memória concordam célula por célula, pra TODOS os leads ────
    await caso('SQL e classifyChannelInMemory concordam célula por célula pra todos os leads', async () => {
      const categorias: Categoria[] = ['mineracao', 'anuncio', 'email', 'instagram', 'whatsapp']
      const categoriaSqlPorId = new Map<number, Categoria>()
      for (const categoria of categorias) {
        const cond = channelWhereCondition(categoria)!
        const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(cond)
        for (const r of rows) categoriaSqlPorId.set(r.id, categoria)
      }

      const divergencias: string[] = []
      for (let i = 0; i < FIXTURES.length; i++) {
        const f = FIXTURES[i]
        const id = idByIndex.get(i)!
        const categoriaSql = categoriaSqlPorId.get(id)
        const classificacao = classifyChannelInMemory(f)
        const categoriaMemoria: Categoria = classificacao.isMineracao
          ? 'mineracao'
          : classificacao.isAnuncio
          ? 'anuncio'
          : classificacao.isEmail
          ? 'email'
          : classificacao.isInstagram
          ? 'instagram'
          : 'whatsapp'

        if (categoriaSql !== categoriaMemoria) {
          divergencias.push(`lead ${id} (${f.descricao}): SQL='${categoriaSql}' memória='${categoriaMemoria}'`)
        }
      }
      if (divergencias.length > 0) {
        assert.fail(`SQL e memória divergiram:\n${divergencias.join('\n')}`)
      }
    })

    // ── 5. Subcategoria (canal real dentro de mineracao): caso a caso ───────
    const fixturesComSub = FIXTURES.map((f, i) => ({ f, id: idByIndex.get(i)! })).filter(
      ({ f }) => f.esperado === 'mineracao' && f.esperadoSub !== undefined
    )

    for (const { f, id } of fixturesComSub) {
      const subEsperado = f.esperadoSub!

      await caso(`[${f.origem}] classifyMineracaoSubchannel classifica "${f.descricao}" como '${subEsperado}'`, () => {
        const sub = classifyMineracaoSubchannel(f)
        assert.equal(sub, subEsperado, `esperava sub='${subEsperado}', veio '${sub}'`)
      })

      await caso(`[${f.origem}] channelWhereCondition('mineracao_${subEsperado}') bate no lead de "${f.descricao}"`, async () => {
        const cond = channelWhereCondition(`mineracao_${subEsperado}`)!
        const rows = await db
          .select({ id: recoveryLeads.id })
          .from(recoveryLeads)
          .where(sql`${recoveryLeads.id} = ${id} and ${cond}`)
        assert.equal(rows.length, 1, `lead ${id} deveria bater em mineracao_${subEsperado}`)
      })

      await caso(`[${f.origem}] "${f.descricao}" NÃO bate nas outras 2 subcategorias de mineracao`, async () => {
        const outrasSubs: MineracaoSubchannel[] = (['email', 'whatsapp', 'instagram'] as MineracaoSubchannel[]).filter(
          s => s !== subEsperado
        )
        for (const outraSub of outrasSubs) {
          const cond = channelWhereCondition(`mineracao_${outraSub}`)!
          const rows = await db
            .select({ id: recoveryLeads.id })
            .from(recoveryLeads)
            .where(sql`${recoveryLeads.id} = ${id} and ${cond}`)
          assert.equal(rows.length, 0, `lead ${id} NÃO deveria bater em mineracao_${outraSub}`)
        }
      })
    }

    // ── 6. Reconciliação agregada da subcategoria: soma dos 3 sub-buckets ===
    // categoria principal 'mineracao' (empresa toda, não só os fixtures com
    // esperadoSub), sem overlap nem buraco DENTRO do universo mineracao.
    await caso('reconciliação da subcategoria: soma de mineracao_email + mineracao_whatsapp + mineracao_instagram == mineracao', async () => {
      const [row] = await db
        .select({
          mineracao: sql<number>`count(*) filter (where ${channelWhereCondition('mineracao')})`,
          mineracaoEmail: sql<number>`count(*) filter (where ${channelWhereCondition('mineracao_email')})`,
          mineracaoWhatsapp: sql<number>`count(*) filter (where ${channelWhereCondition('mineracao_whatsapp')})`,
          mineracaoInstagram: sql<number>`count(*) filter (where ${channelWhereCondition('mineracao_instagram')})`,
        })
        .from(recoveryLeads)

      const mineracao = Number(row.mineracao)
      const somaSub = Number(row.mineracaoEmail) + Number(row.mineracaoWhatsapp) + Number(row.mineracaoInstagram)

      assert.equal(
        somaSub,
        mineracao,
        `soma dos 3 sub-buckets (${somaSub}) deveria ser IGUAL ao total de mineracao (${mineracao}) — overlap ou buraco na subcategoria`
      )
    })

    // ── 7. Overlap direto da subcategoria: nenhum lead em 2 sub-buckets ao mesmo tempo
    await caso('nenhum lead aparece em mais de uma subcategoria de mineracao ao mesmo tempo (overlap direto)', async () => {
      const subs: MineracaoSubchannel[] = ['email', 'whatsapp', 'instagram']
      const contagemPorId = new Map<number, string[]>()
      for (const sub of subs) {
        const cond = channelWhereCondition(`mineracao_${sub}`)!
        const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(cond)
        for (const r of rows) {
          contagemPorId.set(r.id, [...(contagemPorId.get(r.id) ?? []), sub])
        }
      }
      const comOverlap = [...contagemPorId.entries()].filter(([, cats]) => cats.length > 1)
      if (comOverlap.length > 0) {
        const detalhe = comOverlap
          .map(([id, cats]) => `lead ${id} (${fixtureByIndexId.get(id)?.descricao}) em [${cats.join(', ')}]`)
          .join('; ')
        assert.fail(`overlap de subcategoria encontrado: ${detalhe}`)
      }
    })

    // ── 8. Subcategoria de Anúncio: caso a caso ───────────────────────────
    const fixturesComAnuncioSub = FIXTURES.map((f, i) => ({ f, id: idByIndex.get(i)! })).filter(
      ({ f }) => f.esperado === 'anuncio' && f.esperadoAnuncioSub !== undefined
    )

    for (const { f, id } of fixturesComAnuncioSub) {
      const subEsperado = f.esperadoAnuncioSub!

      await caso(`[${f.origem}] classifyAnuncioSubcategory classifica "${f.descricao}" como '${subEsperado}'`, () => {
        const sub = classifyAnuncioSubcategory(f)
        assert.equal(sub, subEsperado, `esperava sub='${subEsperado}', veio '${sub}'`)
      })

      await caso(`[${f.origem}] channelWhereCondition('anuncio_${subEsperado}') bate no lead de "${f.descricao}"`, async () => {
        const cond = channelWhereCondition(`anuncio_${subEsperado}`)!
        const rows = await db
          .select({ id: recoveryLeads.id })
          .from(recoveryLeads)
          .where(sql`${recoveryLeads.id} = ${id} and ${cond}`)
        assert.equal(rows.length, 1, `lead ${id} deveria bater em anuncio_${subEsperado}`)
      })

      await caso(`[${f.origem}] "${f.descricao}" NÃO bate na outra subcategoria de anuncio`, async () => {
        const outrasSubs: AnuncioSubcategory[] = (['meta_ads', 'google_ads'] as AnuncioSubcategory[]).filter(
          s => s !== subEsperado
        )
        for (const outraSub of outrasSubs) {
          const cond = channelWhereCondition(`anuncio_${outraSub}`)!
          const rows = await db
            .select({ id: recoveryLeads.id })
            .from(recoveryLeads)
            .where(sql`${recoveryLeads.id} = ${id} and ${cond}`)
          assert.equal(rows.length, 0, `lead ${id} NÃO deveria bater em anuncio_${outraSub}`)
        }
      })
    }

    await caso('reconciliação da subcategoria: soma de anuncio_meta_ads + anuncio_google_ads == anuncio', async () => {
      const [row] = await db
        .select({
          anuncio: sql<number>`count(*) filter (where ${channelWhereCondition('anuncio')})`,
          anuncioMetaAds: sql<number>`count(*) filter (where ${channelWhereCondition('anuncio_meta_ads')})`,
          anuncioGoogleAds: sql<number>`count(*) filter (where ${channelWhereCondition('anuncio_google_ads')})`,
        })
        .from(recoveryLeads)

      const anuncio = Number(row.anuncio)
      const somaSub = Number(row.anuncioMetaAds) + Number(row.anuncioGoogleAds)

      assert.equal(
        somaSub,
        anuncio,
        `soma dos 2 sub-buckets (${somaSub}) deveria ser IGUAL ao total de anuncio (${anuncio}) — overlap ou buraco na subcategoria`
      )
    })

    await caso('nenhum lead aparece em mais de uma subcategoria de anuncio ao mesmo tempo (overlap direto)', async () => {
      const subs: AnuncioSubcategory[] = ['meta_ads', 'google_ads']
      const contagemPorId = new Map<number, string[]>()
      for (const sub of subs) {
        const cond = channelWhereCondition(`anuncio_${sub}`)!
        const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(cond)
        for (const r of rows) {
          contagemPorId.set(r.id, [...(contagemPorId.get(r.id) ?? []), sub])
        }
      }
      const comOverlap = [...contagemPorId.entries()].filter(([, cats]) => cats.length > 1)
      if (comOverlap.length > 0) {
        const detalhe = comOverlap
          .map(([id, cats]) => `lead ${id} (${fixtureByIndexId.get(id)?.descricao}) em [${cats.join(', ')}]`)
          .join('; ')
        assert.fail(`overlap de subcategoria de anuncio encontrado: ${detalhe}`)
      }
    })

    // ── 9. Rodada 6: inbox-channel-filter.ts concorda com origins.ts pros
    // termos novos ('miner'/'mining'/'places'). É a prova direta de que as
    // duas heurísticas de texto livre, escritas à mão em arquivos separados
    // pro mesmo conceito de negócio, não divergem mais pro achado real do
    // CRM ("Minerador").
    const fixturesRodada6 = FIXTURES.map((f, i) => ({ f, id: idByIndex.get(i)! })).filter(
      ({ f }) => f.origem === 'rodada 6'
    )

    for (const { f } of fixturesRodada6) {
      await caso(
        `[rodada 6] normalizeOrigin (src/lib/origins.ts) também classifica "${f.descricao}" como categoria 'mineracao'`,
        () => {
          const meta = normalizeOrigin(f.trackingSource, null, f.platform, null, f.channel)
          assert.equal(
            meta.category,
            'mineracao',
            `normalizeOrigin deveria classificar trackingSource='${f.trackingSource}' como categoria 'mineracao', veio '${meta.category}'`
          )
        }
      )

      await caso(
        `[rodada 6] classifyChannelInMemory (inbox-channel-filter.ts) concorda com normalizeOrigin (origins.ts) para "${f.descricao}"`,
        () => {
          const classificacaoInbox = classifyChannelInMemory(f)
          const metaOrigins = normalizeOrigin(f.trackingSource, null, f.platform, null, f.channel)
          assert.equal(classificacaoInbox.isMineracao, true, 'inbox-channel-filter.ts deveria marcar isMineracao=true')
          assert.equal(metaOrigins.category, 'mineracao', 'origins.ts deveria marcar category=mineracao')
          assert.equal(
            classificacaoInbox.isMineracao,
            metaOrigins.category === 'mineracao',
            `as duas heurísticas divergiram para trackingSource='${f.trackingSource}'`
          )
        }
      )
    }

    // ── 10. Rodada 8: inbox-channel-filter.ts concorda com origins.ts para
    // Anúncio e suas subcategorias Meta/Google.
    const fixturesRodada8Anuncio = FIXTURES.map((f, i) => ({ f, id: idByIndex.get(i)! })).filter(
      ({ f }) => f.origem === 'rodada 8' && f.esperado === 'anuncio'
    )

    for (const { f } of fixturesRodada8Anuncio) {
      await caso(
        `[rodada 8] normalizeOrigin (src/lib/origins.ts) classifica "${f.descricao}" como category='anuncio'`,
        () => {
          const meta = normalizeOrigin(f.trackingSource, null, f.platform, null, f.channel)
          assert.equal(
            meta.category,
            'anuncio',
            `normalizeOrigin deveria classificar trackingSource='${f.trackingSource}' como category='anuncio', veio '${meta.category}'`
          )
          assert.equal(
            meta.subcategory,
            f.esperadoAnuncioSub,
            `normalizeOrigin deveria classificar trackingSource='${f.trackingSource}' como subcategory='${f.esperadoAnuncioSub}', veio '${meta.subcategory}'`
          )
        }
      )

      await caso(
        `[rodada 8] classifyChannelInMemory concorda com normalizeOrigin para "${f.descricao}"`,
        () => {
          const classificacaoInbox = classifyChannelInMemory(f)
          const subInbox = classifyAnuncioSubcategory(f)
          const metaOrigins = normalizeOrigin(f.trackingSource, null, f.platform, null, f.channel)
          assert.equal(classificacaoInbox.isAnuncio, true, 'inbox-channel-filter.ts deveria marcar isAnuncio=true')
          assert.equal(metaOrigins.category, 'anuncio', 'origins.ts deveria marcar category=anuncio')
          assert.equal(subInbox, metaOrigins.subcategory)
        }
      )
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
