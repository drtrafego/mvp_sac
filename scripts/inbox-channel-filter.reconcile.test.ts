// Teste de RECONCILIAÇÃO do filtro de canal do Inbox (src/lib/inbox-channel-filter.ts).
//
// Contexto: esta é a 4ª rodada de correção da mesma heurística. As rodadas
// anteriores acharam overlap com WhatsApp, buraco de NULL/vazio e overlap
// textual entre instagram/email/mineracao (dois padrões de `ilike` batendo
// no mesmo tracking_source). Este teste sobe um Postgres DESCARTÁVEL de
// verdade (Docker), roda channelWhereCondition() e classifyChannelInMemory()
// exatamente como o produto roda, e afirma pra CADA caso de borda das 4
// rodadas: soma dos 4 buckets == total, sem overlap, sem buraco, e SQL bate
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
import { channelWhereCondition, classifyChannelInMemory, type ChannelClassification } from '../src/lib/inbox-channel-filter'

type Categoria = 'mineracao' | 'email' | 'instagram' | 'whatsapp'

type LeadFixture = {
  descricao: string
  // origem do bug (rodada em que foi encontrado, pra rastrear regressão)
  origem: string
  channel: string | null
  platform: string | null
  trackingSource: string | null
  phone: string
  esperado: Categoria
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
    descricao: "channel=NULL, trackingSource de outro canal (instagram)",
    origem: 'rodada 2',
    channel: null,
    platform: null,
    trackingSource: 'instagram_ads_agosto',
    phone: '5511922221111',
    esperado: 'instagram',
  },
  {
    descricao: "channel=NULL, platform de outro canal (mineracao)",
    origem: 'rodada 2',
    channel: null,
    platform: 'mineracao',
    trackingSource: null,
    phone: '5511933334444',
    esperado: 'mineracao',
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
    descricao: 'lead comum de WhatsApp com tracking_source de anúncio de tráfego pago (não deve virar nenhum dos 3 outros)',
    origem: 'controle',
    channel: null,
    platform: 'hotmart',
    trackingSource: 'fb_ads_campanha_x',
    phone: '5511900006666',
    esperado: 'whatsapp',
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

    console.log(`[setup] inserindo ${FIXTURES.length} leads de fixture (todos os casos de borda das 4 rodadas)...`)
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

      await caso(`[${f.origem}] SQL NÃO classifica "${f.descricao}" nas outras 3 categorias`, async () => {
        const outras: Categoria[] = (['mineracao', 'email', 'instagram', 'whatsapp'] as Categoria[]).filter(
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
    await caso(`reconciliação agregada: soma dos 4 buckets == total (${FIXTURES.length} leads), sem overlap, sem buraco`, async () => {
      const [row] = await db
        .select({
          total: sql<number>`count(*)`,
          mineracao: sql<number>`count(*) filter (where ${channelWhereCondition('mineracao')})`,
          email: sql<number>`count(*) filter (where ${channelWhereCondition('email')})`,
          instagram: sql<number>`count(*) filter (where ${channelWhereCondition('instagram')})`,
          whatsapp: sql<number>`count(*) filter (where ${channelWhereCondition('whatsapp')})`,
        })
        .from(recoveryLeads)

      const total = Number(row.total)
      const soma = Number(row.mineracao) + Number(row.email) + Number(row.instagram) + Number(row.whatsapp)

      assert.equal(total, FIXTURES.length, 'total de leads na tabela deveria ser igual ao total de fixtures')
      assert.equal(soma, total, `soma dos 4 buckets (${soma}) deveria ser IGUAL ao total (${total}) — overlap ou buraco`)
    })

    // ── 3. Nenhum lead aparece em mais de um bucket (overlap direto, id a id) ─
    await caso('nenhum lead aparece em mais de uma categoria SQL ao mesmo tempo (overlap direto)', async () => {
      const categorias: Categoria[] = ['mineracao', 'email', 'instagram', 'whatsapp']
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
      const categorias: Categoria[] = ['mineracao', 'email', 'instagram', 'whatsapp']
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
