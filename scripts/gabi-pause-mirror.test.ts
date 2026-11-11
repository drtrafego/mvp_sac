// Teste do espelho da pausa do SAC no banco central que a Gabi (Gramado Plaza) lê.
//
// Incidente de origem (11/11/2026): "Pausar tudo", "Pausar canal" e a pausa por
// lead do SAC só valiam para o que o próprio SAC envia. A Gabi lê a pausa em
// public.agent_pause / public.agent_chat_pause no banco central; o SAC não
// escrevia ali. Este teste roda as rotas de verdade e confere as LINHAS que
// chegam nessas tabelas.
//
// PGlite real (sem Docker, sem rede). Dois bancos descartáveis:
//   - SAC (schema de produção): leads, chaves de pausa;
//   - central dos agentes: agent_pause e agent_chat_pause com a forma de produção.
// Só viram mock: '@/lib/db', '@/lib/db/agents-db' (aponta para o PGlite central),
// auth e next/server.
//
// Casos:
//   (1) Pausar tudo grava agent_pause (paused=true, por 'sac:geral...')
//   (2) Reativar tudo libera, mas SÓ se a linha é do SAC; pausa geral de outra
//       origem (painel antigo) nunca é solta pelo SAC
//   (3) Pausar canal: instagram não alcança a Gabi; whatsapp sim; liberar o
//       whatsapp com a chave geral ligada mantém pausado
//   (4) Pausa por lead grava agent_chat_pause com por 'sac:lead:...'
//   (5) Liberar lead APAGA a linha do SAC e NUNCA grava paused=false (a ponte lê
//       false como "despausou" e apagaria a pausa do dono no celular)
//   (6) Liberar lead sem linha do SAC não toca em linha 'bot (handoff)' da Gabi
//   (7) Lead de Instagram e empresa que não é a Gramado não geram escrita
//   (8) Banco central fora do ar: a rota segue 200 e devolve gabi.ok=false
//   (9) Reconciliação do cron: cria o que falta, apaga linha 'sac:' velha, ignora
//       pausa em massa e nunca toca linha de outra origem
//
// Uso: npm run test:gabi-pause-mirror

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import * as schema from '../src/lib/db/schema'
import { createSacTestDatabase } from './sac-test-pglite'

async function main() {
  const sac = await createSacTestDatabase([schema.companies, schema.settings, schema.recoveryLeads, schema.companyPauseSwitches, schema.sacAuditEvents])
  const central = await createSacTestDatabase([])
  await central.pg.exec(`
    create table public.agent_pause (agent_slug text primary key, paused boolean default false, por text, updated_at timestamptz default now());
    create table public.agent_chat_pause (agent_slug text not null, chat_id text not null, paused boolean default true, por text,
      updated_at timestamptz default now(), primary key (agent_slug, chat_id));
  `)

  let centralFora = false
  const queries: string[] = []
  const company = { id: 12, name: 'Gramado Plaza', slug: 'gramado-plaza' }
  const outra = { id: 13, name: 'Outra Empresa', slug: 'outra-empresa' }
  let ativa = company

  mock.method(globalThis, 'fetch', async () => { throw new Error('Rede proibida no teste') })
  mock.module('@/lib/db', { namedExports: { db: sac.db } })
  mock.module('@/lib/db/agents-db', {
    namedExports: {
      queryAgentsDb: async (q: string, params: unknown[] = []) => {
        queries.push(q)
        if (centralFora) return null
        const r = await central.pg.query(q, params as unknown[])
        return r.rows
      },
    },
  })
  mock.module('next/server', { namedExports: { NextRequest, NextResponse, after: () => undefined } })
  mock.module('@/lib/agent-auth', {
    namedExports: {
      authenticateAgentRequest: async () => ({ context: { company: ativa, agentName: 'Agente Teste', agentId: 'teste' } }),
      logAgentActivity: async () => undefined,
    },
  })
  mock.module('@/lib/auth', {
    namedExports: {
      requireCompany: async () => ativa,
      getCurrentUser: async () => ({ displayName: 'Maria Atendente', primaryEmail: 'maria@teste.local' }),
      requireSacActor: async () => ({ company: ativa, memberId: 1, actorId: 'u1', actorName: 'Maria Atendente' }),
      ForbiddenError: class ForbiddenError extends Error { status = 403 },
      AuthError: class AuthError extends Error { status = 401 },
    },
  })

  const pauseAll = await import('../src/app/api/v1/companies/[idOrSlug]/pause-all/route')
  const pauseChannel = await import('../src/app/api/v1/companies/[idOrSlug]/pause-channel/route')
  const pauseBot = await import('../src/app/api/v1/companies/[idOrSlug]/conversations/[contact]/pause-bot/route')
  const inboxPause = await import('../src/app/api/inbox/[leadId]/pause/route')
  const inboxClaim = await import('../src/app/api/inbox/[leadId]/claim/route')
  const mirror = await import('../src/lib/gabi-pause-mirror')

  const post = (url: string, body: unknown) => new NextRequest(`http://localhost/${url}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })
  const params = () => ({ params: Promise.resolve({ idOrSlug: ativa.slug }) })
  const pAll = (action: 'pause' | 'unpause') => pauseAll.POST(post('pause-all', action === 'pause' ? { action, confirm: true } : { action }), params())
  const pChan = (channel: string, action: 'pause' | 'unpause') => pauseChannel.POST(post('pause-channel', { action, channel, confirm: true }), params())
  const geral = async () => (await central.pg.query('select paused, por from public.agent_pause where agent_slug=$1', ['gramadoplazza'])).rows[0] as { paused: boolean; por: string } | undefined
  const linhas = async () => (await central.pg.query('select chat_id, paused, por from public.agent_chat_pause where agent_slug=$1 order by chat_id', ['gramadoplazza'])).rows as Array<{ chat_id: string; paused: boolean; por: string }>
  const lead = async (phone: string, channel = 'whatsapp', extra: Record<string, unknown> = {}) => {
    const [l] = await sac.db.insert(schema.recoveryLeads).values({ companyId: ativa.id, phone, channel, name: 'Teste', botPaused: false, ...extra } as typeof schema.recoveryLeads.$inferInsert).returning()
    return l
  }
  const reset = async () => {
    await sac.pg.exec('TRUNCATE recovery_leads, company_pause_switches, sac_audit_events RESTART IDENTITY')
    await central.pg.exec('TRUNCATE public.agent_pause, public.agent_chat_pause')
    centralFora = false
    queries.length = 0
    ativa = company
  }
  const inboxCall = (id: number, paused: boolean) => inboxPause.POST(post(`inbox/${id}/pause`, { paused }), { params: Promise.resolve({ leadId: String(id) }) })
  const botCall = (contact: string, pause: boolean) => pauseBot.POST(post('pause-bot', { pause }), { params: Promise.resolve({ idOrSlug: ativa.slug, contact }) })

  try {
    await sac.db.insert(schema.companies).values([company, outra])

    await test('(1) Pausar tudo grava a pausa geral que a Gabi lê', async () => {
      await reset()
      const res = await pAll('pause')
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.gabi.ok, true)
      const g = await geral()
      assert.equal(g?.paused, true)
      assert.match(g!.por, /^sac:geral/)
    })

    await test('(2) Reativar tudo libera a linha do SAC; pausa geral de OUTRA origem nunca é solta', async () => {
      const res = await pAll('unpause')
      assert.equal((await res.json()).gabi.ok, true)
      assert.equal((await geral())?.paused, false)

      await reset()
      await central.pg.query("insert into public.agent_pause (agent_slug, paused, por) values ('gramadoplazza', true, 'dr.trafego')")
      let json = await (await pAll('pause')).json()
      assert.equal(json.gabi.ok, true)
      assert.equal((await geral())?.por, 'dr.trafego', 'quem pausou continua dono da pausa')
      json = await (await pAll('unpause')).json()
      assert.equal((await geral())?.paused, true, 'o SAC não solta a pausa que não é dele')
      assert.match(json.gabi.detail, /OUTRA origem/)
    })

    await test('(3) Pausar canal: instagram não alcança a Gabi, whatsapp sim, e a chave geral segura', async () => {
      await reset()
      await pChan('instagram', 'pause')
      assert.equal(await geral(), undefined, 'canal instagram pausado não escreve nada para a Gabi')
      const res = await pChan('whatsapp', 'pause')
      assert.equal((await res.json()).gabi.ok, true)
      assert.equal((await geral())?.paused, true)

      await pAll('pause')
      await pChan('whatsapp', 'unpause')
      assert.equal((await geral())?.paused, true, 'whatsapp liberado, mas a chave geral continua ligada')
      await pAll('unpause')
      assert.equal((await geral())?.paused, false)
    })

    await test('(4)(5) pausa por lead grava linha do SAC; liberar APAGA e nunca grava paused=false', async () => {
      await reset()
      const l = await lead('5551999000111')
      let json = await (await inboxCall(l.id, true)).json()
      assert.equal(json.gabi.ok, true)
      let rows = await linhas()
      assert.equal(rows.length, 2, 'celular BR: as duas formas do 9')
      assert.equal(rows[1].chat_id, '5551999000111')
      assert.equal(rows[1].paused, true)
      assert.match(rows[1].por, /^sac:lead:Maria Atendente/)

      json = await (await inboxCall(l.id, false)).json()
      assert.equal(json.gabi.ok, true)
      rows = await linhas()
      assert.equal(rows.length, 0, 'a linha do SAC foi apagada')
      assert.ok(!queries.some(q => /set paused\s*=\s*false/i.test(q) && /agent_chat_pause/.test(q)), 'nenhum UPDATE paused=false por conversa')

      // pela API de agentes também
      json = await (await botCall('5551999000111', true)).json()
      assert.equal(json.gabi.ok, true)
      assert.equal((await linhas()).length, 2)
      await botCall('5551999000111', false)
      assert.equal((await linhas()).length, 0)
    })

    await test('(6) pausa do SAC assume uma pausa de handoff da Gabi; liberar sem linha do SAC não toca no handoff', async () => {
      await reset()
      await central.pg.query("insert into public.agent_chat_pause (agent_slug, chat_id, paused, por) values ('gramadoplazza','5551999000111',true,'bot (handoff)'), ('gramadoplazza','5551999000222',true,'bot (handoff)')")
      const a = await lead('5551999000111')
      const b = await lead('5551999000222', 'whatsapp', { botPaused: true })
      await inboxCall(a.id, true)
      let rows = await linhas()
      assert.match(rows.find(r => r.chat_id === '5551999000111')!.por, /^sac:lead/, 'a pausa vira do SAC (deixa de expirar)')
      // lead B: o SAC "libera" um lead que ele nunca pausou na Gabi; o handoff da Gabi fica
      await inboxCall(b.id, false)
      rows = await linhas()
      const handoff = rows.find(r => r.chat_id === '5551999000222')!
      assert.equal(handoff.paused, true)
      assert.equal(handoff.por, 'bot (handoff)')
    })

    await test('(7) lead de Instagram e empresa que não é a Gramado não geram escrita', async () => {
      await reset()
      const ig = await lead('ig_1234567890', 'instagram')
      const json = await (await inboxCall(ig.id, true)).json()
      assert.equal(json.gabi, undefined, 'sem campo gabi quando não se aplica')
      assert.equal((await linhas()).length, 0)

      ativa = outra
      const l = await lead('5551999000333')
      const j2 = await (await inboxCall(l.id, true)).json()
      assert.equal(j2.gabi, undefined)
      const j3 = await (await pAll('pause')).json()
      assert.equal(j3.gabi, undefined)
      assert.equal((await linhas()).length, 0)
      assert.equal(await geral(), undefined)
      ativa = company
    })

    await test('(8) banco central fora do ar: a rota segue 200 e avisa que a Gabi NÃO soube', async () => {
      await reset()
      const l = await lead('5551999000111')
      centralFora = true
      const res = await inboxCall(l.id, true)
      assert.equal(res.status, 200, 'a pausa do SAC não pode falhar por causa da Gabi')
      const json = await res.json()
      assert.equal(json.botPaused, true)
      assert.equal(json.gabi.ok, false)
      assert.match(json.gabi.detail, /NÃO soube/)
      const g = await (await pAll('pause')).json()
      assert.equal(g.gabi.ok, false)
      centralFora = false
      // o cron refaz
      const rec = await mirror.reconcileGabiPause(company, { since: new Date(Date.now() - 3_600_000) })
      assert.equal(rec.ok, true)
      assert.equal((await geral())?.paused, true)
      assert.equal((await linhas()).length, 2, 'o reconcile refez as duas formas')
    })

    await test('(9) reconciliação: só espelha pausa feita DEPOIS da ativação; estoque antigo é medido, não espelhado', async () => {
      await reset()
      const since = new Date('2026-11-12T00:00:00Z')
      const antes = new Date('2026-08-01T00:00:00Z')
      const depois = new Date('2026-11-12T10:00:00Z')
      await lead('5551999000111', 'whatsapp', { botPaused: true, botPausedBy: 'Maria', botPausedAll: false, botPausedAt: depois })
      await lead('5551999000777', 'whatsapp', { botPaused: true, botPausedBy: 'Jose', botPausedAll: false, botPausedAt: antes })
      await lead('5551999000888', 'whatsapp', { botPaused: true, botPausedBy: 'IA', botPausedAll: false, botPausedAt: null })
      await lead('5551999000222', 'whatsapp', { botPaused: true, botPausedBy: 'auto (pausa geral ativa)', botPausedAll: true, botPausedAt: depois })
      await lead('5551999000333', 'whatsapp', { botPaused: true, botPausedBy: 'x', botPausedChannel: 'whatsapp', botPausedAt: depois })
      await lead('5551999000444', 'whatsapp', { botPaused: false })
      await central.pg.query(`insert into public.agent_chat_pause (agent_slug, chat_id, paused, por) values
        ('gramadoplazza','5551999000444',true,'sac:lead:Velha'),
        ('gramadoplazza','5551999000777',true,'sac:lead:feita-pelo-gancho'),
        ('gramadoplazza','5551999000555',true,'bot (handoff)'),
        ('gramadoplazza','5551999000666',true,'dono no celular')`)
      const sec = await mirror.reconcileGabiPause(company, { dryRun: true, since })
      assert.equal(sec.inserted, 2, 'dryRun conta: a pausa nova nas duas formas do 9')
      assert.equal((await linhas()).length, 4, 'dryRun não escreve nada')
      const rec = await mirror.reconcileGabiPause(company, { since })
      assert.equal(rec.ok, true)
      assert.equal(rec.estoqueAntigo, 2, 'a pausa de agosto e a sem data NÃO são espelhadas')
      assert.ok((rec.estoqueAntigoMaisAntigoDias ?? 0) > 90)
      assert.equal(rec.removed, 1, 'só a linha do lead que não está mais pausado; a do gancho (lead ainda pausado) fica')
      const rows = await linhas()
      assert.deepEqual(rows.map(r => r.chat_id).sort(), ['555199000111', '5551999000111', '5551999000555', '5551999000666', '5551999000777'].sort())
      assert.equal(rows.find(r => r.chat_id === '5551999000555')!.por, 'bot (handoff)')
      assert.equal(rows.find(r => r.chat_id === '5551999000666')!.por, 'dono no celular')
      assert.equal(rows.find(r => r.chat_id === '5551999000888'), undefined)
      const again = await mirror.reconcileGabiPause(company, { since })
      assert.equal(again.inserted, 0)
      assert.equal(again.removed, 0)
      assert.equal((await mirror.reconcileGabiPause(outra, { since })).inserted, 0)
    })

    await test('(9b) reconciliação SEM data de ativação não cria nenhuma linha por lead (fail-safe) e só mede', async () => {
      await reset()
      await lead('5551999000111', 'whatsapp', { botPaused: true, botPausedBy: 'Maria', botPausedAll: false, botPausedAt: new Date() })
      const old = process.env.GABI_PAUSE_MIRROR_SINCE
      delete process.env.GABI_PAUSE_MIRROR_SINCE
      try {
        const rec = await mirror.reconcileGabiPause(company)
        assert.equal(rec.inserted, 0)
        assert.equal(rec.estoqueAntigo, 1)
        assert.equal(rec.since, null)
        assert.equal((await linhas()).length, 0)
        process.env.GABI_PAUSE_MIRROR_SINCE = 'lixo'
        assert.equal(mirror.gabiMirrorSince(), null, 'data inválida = sem ativação')
      } finally {
        if (old === undefined) delete process.env.GABI_PAUSE_MIRROR_SINCE
        else process.env.GABI_PAUSE_MIRROR_SINCE = old
      }
    })

    await test('(10) nono dígito: celular BR grava as DUAS formas e liberar apaga as duas; fixo e estrangeiro, uma só', async () => {
      await reset()
      const l13 = await lead('5551999000111')
      await inboxCall(l13.id, true)
      assert.deepEqual((await linhas()).map(r => r.chat_id), ['555199000111', '5551999000111'])
      await inboxCall(l13.id, false)
      assert.equal((await linhas()).length, 0)

      const l12 = await lead('555199000222')
      await inboxCall(l12.id, true)
      assert.deepEqual((await linhas()).map(r => r.chat_id), ['555199000222', '5551999000222'])
      await inboxCall(l12.id, false)
      assert.equal((await linhas()).length, 0)

      assert.deepEqual(mirror.gabiChatIds('whatsapp', '555133334444'), ['555133334444'], 'fixo não ganha 9')
      assert.deepEqual(mirror.gabiChatIds('whatsapp', '5491155551234'), ['5491155551234'], 'estrangeiro: uma forma')
      assert.deepEqual(mirror.gabiChatIds('instagram', '5551999000111'), [])
      assert.ok(!queries.some(q => /set paused\s*=\s*false/i.test(q) && /agent_chat_pause/.test(q)))
    })

    await test('(10b) 13 digitos so gera a forma de 12 se o assinante resultante e celular (6-9); senao seria um FIXO de outra pessoa', () => {
      assert.deepEqual(mirror.gabiChatIds('whatsapp', '5551931234567'), ['5551931234567'], 'sem 9 viraria 555131234567 (fixo)')
      assert.deepEqual(mirror.gabiChatIds('whatsapp', '5551961234567'), ['5551961234567', '555161234567'])
      assert.deepEqual(mirror.gabiChatIds('whatsapp', '5551999000111'), ['5551999000111', '555199000111'])
    })

    await test('(10c) mesma pessoa com 2 leads (13 e 12 digitos): liberar um NAO apaga a forma que o outro, ainda pausado, usa', async () => {
      await reset()
      const a = await lead('5551999000111')
      const b = await lead('555199000111')
      await inboxCall(a.id, true)
      await inboxCall(b.id, true)
      assert.deepEqual((await linhas()).map(r => r.chat_id), ['555199000111', '5551999000111'])
      let json = await (await inboxCall(a.id, false)).json()
      assert.equal(json.gabi.ok, true)
      assert.equal((await linhas()).length, 2, 'o lead B segue pausado: as duas formas ficam')
      json = await (await inboxCall(b.id, false)).json()
      assert.equal((await linhas()).length, 0, 'ultimo lead liberado: as duas formas saem')
      // lead com numero diferente nao segura nada
      const c = await lead('5551999000222')
      await inboxCall(c.id, true)
      const d = await lead('5551999000333')
      await inboxCall(d.id, true)
      await inboxCall(c.id, false)
      assert.deepEqual((await linhas()).map(r => r.chat_id).sort(), ['555199000333', '5551999000333'])
    })

    await test('(9c) GABI_PAUSE_MIRROR_SINCE: so ISO 8601 estrito com hora e fuso; invalida e LOGADA e vale como ausente', () => {
      const erros: string[] = []
      const velho = console.error
      console.error = (...a: unknown[]) => { erros.push(a.join(' ')) }
      try {
        assert.equal(mirror.gabiMirrorSince('12/11/2026'), null, '12/11/2026 o Date do JS leria como 11 de dezembro')
        assert.equal(mirror.gabiMirrorSince('2026-11-12'), null, 'data solta (sem hora/fuso) recusada')
        assert.equal(mirror.gabiMirrorSince('2026-11-12T03:00:00'), null, 'sem fuso recusada')
        assert.equal(mirror.gabiMirrorSince('amanha'), null)
        assert.equal(mirror.gabiMirrorSince('2026-13-45T03:00:00Z'), null, 'data impossivel')
        assert.equal(erros.length, 5, 'cada valor invalido distinto e logado')
        assert.match(erros[0], /GABI_PAUSE_MIRROR_SINCE invalida/)
        mirror.gabiMirrorSince('12/11/2026')
        assert.equal(erros.length, 5, 'o mesmo valor nao inunda o log a cada rodada do cron')
        assert.equal(mirror.gabiMirrorSince('2026-11-12T03:00:00Z')?.toISOString(), '2026-11-12T03:00:00.000Z')
        assert.equal(mirror.gabiMirrorSince('2026-11-12T00:00:00-03:00')?.toISOString(), '2026-11-12T03:00:00.000Z')
        assert.equal(mirror.gabiMirrorSince(undefined), null)
        assert.equal(mirror.gabiMirrorSince(''), null)
      } finally {
        console.error = velho
      }
    })

    await test('(11) assumir (claim) pausa a Gabi pelo gancho; falha do banco central vira gabi.ok=false com 200', async () => {
      await reset()
      const l = await lead('5551999000111')
      const call = () => inboxClaim.POST(post('claim', {}), { params: Promise.resolve({ leadId: String(l.id) }) })
      let res = await call()
      assert.equal(res.status, 200)
      let json = await res.json()
      assert.equal(json.gabi.ok, true)
      assert.match((await linhas())[0].por, /^sac:lead:Maria Atendente/)
      assert.equal((await linhas()).length, 2)

      await reset()
      const l2 = await lead('5551999000222')
      centralFora = true
      res = await inboxClaim.POST(post('claim', {}), { params: Promise.resolve({ leadId: String(l2.id) }) })
      assert.equal(res.status, 200)
      json = await res.json()
      assert.equal(json.gabi.ok, false)
    })

    await test('REGRA: o SAC nunca grava paused=false por conversa e só mexe em linha com por sac:', async () => {
      const { readFileSync } = await import('node:fs')
      const src = readFileSync(new URL('../src/lib/gabi-pause-mirror.ts', import.meta.url), 'utf8')
      const sqls = [...src.matchAll(/`((?:INSERT|UPDATE|DELETE)[^`]*)`/g)].map(m => m[1])
      assert.ok(sqls.length >= 5)
      for (const q of sqls) {
        if (/agent_chat_pause/.test(q)) {
          assert.ok(!/paused\s*=\s*false/i.test(q), 'nenhuma escrita paused=false por conversa')
          if (/^DELETE/.test(q)) assert.match(q, /LIKE \$3/, 'DELETE só de linha sac:')
          if (/^UPDATE/.test(q)) assert.fail('nenhum UPDATE em agent_chat_pause')
        }
        if (/^UPDATE public\.agent_pause/.test(q)) assert.match(q, /LIKE \$3/, 'liberar a geral só linha sac:')
      }
    })

    await test('chatId: só dígitos, sem inventar DDI, só WhatsApp', () => {
      assert.equal(mirror.gabiChatId('whatsapp', '+55 (51) 99900-0111'), '5551999000111')
      assert.equal(mirror.gabiChatId('whatsapp', '5491155551234'), '5491155551234')
      assert.equal(mirror.gabiChatId('whatsapp', '51999000111'), '51999000111', 'não adiciona 55')
      assert.equal(mirror.gabiChatId('instagram', '5551999000111'), null)
      assert.equal(mirror.gabiChatId('whatsapp', 'ig_123'), null)
      assert.equal(mirror.gabiChatId('whatsapp', null), null)
    })
  } finally {
    await sac.close?.()
    await central.close?.()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
