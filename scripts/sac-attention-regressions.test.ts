// Real PostgreSQL WASM SQL + actual API/auth handlers, isolated from external services.
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { createRequire } from 'node:module'
import { delimiter, dirname } from 'node:path'
import { NextRequest } from 'next/server'
import { createSacTestDatabase } from './sac-test-pglite'
import * as schema from '../src/lib/db/schema'

type Row = Record<string, unknown>
let session: Row | null = { id:'operator',primaryEmail:'operator@example.test',primaryEmailVerified:true,isAdmin:false }
let database: Awaited<ReturnType<typeof createSacTestDatabase>>
const proxy = new Proxy({}, { get(_target,key) {
  const value = Reflect.get(database.db,key)
  return typeof value === 'function' ? value.bind(database.db) : value
} })
const mockModule = (specifier: string, namedExports: Record<string,unknown>) => (mock as unknown as {
  module: (specifier:string,options:{namedExports:Record<string,unknown>}) => unknown
}).module(specifier,{namedExports})
const require = createRequire(import.meta.url)
const runtime = require('node:module')
process.env.NODE_PATH = [dirname(dirname(require.resolve('next/dist/compiled/server-only/package.json'))),process.env.NODE_PATH].filter(Boolean).join(delimiter)
runtime._initPaths()
mockModule(require.resolve('server-only'),{})
mockModule('@/lib/db',{ db:proxy })
mockModule('@/stack',{ stackServerApp:{getUser:async()=>session} })
mockModule('next/headers',{cookies:async()=>({get:()=>undefined})})
mockModule('@/lib/agent-session',{verifyAgentSessionCookie:async()=>null})

const NOW = new Date('2026-10-09T02:30:00Z') // still October 8 in São Paulo
async function main() {
  database = await createSacTestDatabase([schema.companies,schema.settings,schema.companyMembers,
    schema.recoveryLeads,schema.whatsappMessages,schema.sacPendingItems,schema.sacRuleStates,schema.sacAuditEvents])
  const { pg, db } = database
  const { loadSacAttention,parseAttentionQuery } = await import('../src/lib/sac-attention')
  const { GET } = await import('../src/app/api/inbox/attention/route')
  const load = (view: 'all'|'human'|'unassigned'|'overdue'|'today'|'mine' = 'all',page=1,pageSize=25,userId='operator') =>
    loadSacAttention({ companyId:1,userId,view,page,pageSize,now:NOW },db)
  const seed = async () => {
    await pg.exec('TRUNCATE companies,settings,company_members,recovery_leads,whatsapp_messages,sac_pending_items,sac_rule_states,sac_audit_events RESTART IDENTITY')
    await db.insert(schema.companies).values([{id:1,name:'One',slug:'one',stackAuthUserId:'owner'},{id:2,name:'Other',slug:'other',stackAuthUserId:'other-owner'}])
    await db.insert(schema.settings).values([{companyId:1},{companyId:2}])
    await db.insert(schema.companyMembers).values([
      {id:1,companyId:1,stackAuthUserId:'operator',email:'operator@example.test',name:'Ana',role:'membro',status:'ativo'},
      {id:2,companyId:2,stackAuthUserId:'other-user',email:'other@example.test',name:'Other tenant secret',role:'membro',status:'ativo'},
      {id:3,companyId:1,stackAuthUserId:'inactive',email:'inactive@example.test',name:'Inactive',role:'membro',status:'pending'},
    ])
    const at = (day:string) => new Date(`${day}T15:00:00Z`)
    await db.insert(schema.recoveryLeads).values([
      {id:1,companyId:1,phone:'111',name:'Overdue',platform:'sac',eventType:'atendimento',status:'converted',nextAction:'Entregar contrato',nextActionDueAt:at('2026-10-07'),humanOwnerMemberId:1},
      {id:2,companyId:1,phone:'222',name:'Today',platform:'sac',eventType:'atendimento',nextAction:'Enviar orçamento',nextActionDueAt:at('2026-10-08')},
      {id:3,companyId:1,phone:'333',name:'Handoff',platform:'sac',eventType:'atendimento',sacCaseState:'transbordo',botPaused:true,botPausedAt:at('2026-10-01')},
      {id:4,companyId:1,phone:'444',name:'Silent bot pause',platform:'sac',eventType:'atendimento',botPaused:true,botPausedAt:at('2026-10-01')},
      {id:5,companyId:1,phone:'555',name:'Resolved with stale alert',platform:'sac',eventType:'atendimento',sacCaseState:'resolvido',nextActionDueAt:at('2026-10-06')},
      {id:6,companyId:1,phone:'666',name:'Human',platform:'sac',eventType:'atendimento',sacCaseState:'em_atendimento',humanOwnerMemberId:1},
      {id:7,companyId:1,phone:'777',name:'Action no date',platform:'sac',eventType:'atendimento',nextAction:'Conferir pagamento'},
      {id:8,companyId:1,phone:'888',name:'Foreign owner corruption',platform:'sac',eventType:'atendimento',nextActionDueAt:at('2026-10-10'),humanOwnerMemberId:2},
      {id:9,companyId:2,phone:'999',name:'Other tenant secret',platform:'sac',eventType:'atendimento',nextActionDueAt:at('2026-10-05'),humanOwnerMemberId:2},
      {id:10,companyId:1,phone:'1010',name:'Active alerts',platform:'sac',eventType:'atendimento'},
      {id:11,companyId:1,phone:'1111',name:'Inactive owner',platform:'sac',eventType:'atendimento',nextActionDueAt:at('2026-10-10'),humanOwnerMemberId:3},
    ])
    await db.insert(schema.sacPendingItems).values([
      {companyId:1,leadId:5,ruleType:'retorno_vencido',sourceKey:'stale',reason:'Stale resolved alert'},
      {companyId:1,leadId:10,ruleType:'etapa_sem_retorno',sourceKey:'one',reason:'Acompanhar etapa'},
      {companyId:1,leadId:10,ruleType:'retorno_vencido',sourceKey:'two',reason:'Acompanhar etapa'},
      {companyId:2,leadId:7,ruleType:'retorno_vencido',sourceKey:'foreign',reason:'Foreign pending secret'},
    ])
  }
  try {
    await seed()
    await test('actionable queue excludes paused-only, other tenants and resolved cases; multiple alerts yield one contact',async()=>{
      let calls=0
      const result=await loadSacAttention({companyId:1,userId:'operator',view:'all',page:1,pageSize:25,now:NOW},{execute(query){calls++;return db.execute(query)}})
      assert.equal(calls,1)
      assert.deepEqual(result.items.map(i=>i.leadId),[1,3,2,6,8,11,7,10])
      assert.equal(result.total,8)
      assert.equal(result.currentMemberId,1)
      assert.deepEqual(result.counts,{all:8,human:2,unassigned:4,overdue:1,today:1,mine:2})
      assert.equal(result.items.find(i=>i.leadId===3)?.dueAt,null)
      assert.equal(result.items.find(i=>i.leadId===1)?.humanOwnerName,'Ana')
      assert.equal(result.items.find(i=>i.leadId===8)?.humanOwnerName,null)
      assert.equal(result.items.find(i=>i.leadId===11)?.humanOwnerName,null)
      assert.deepEqual(result.items.find(i=>i.leadId===10)?.reasons,['Acompanhar etapa'])
      assert.ok(!JSON.stringify(result).includes('secret'))
    })
    await test('calendar deadlines use São Paulo day and the earliest actual action/return deadline',async()=>{
      assert.equal((await load('today')).items[0].leadId,2)
      assert.deepEqual((await load('overdue')).items.map(i=>i.leadId),[1])
      await pg.exec("UPDATE recovery_leads SET follow_up_date='2026-10-06 15:00:00' WHERE id=2")
      const result=await load('overdue')
      assert.equal(result.items[0].leadId,2)
      assert.equal(result.items[0].dueAt,'2026-10-06T15:00:00.000Z')
      await pg.exec("UPDATE recovery_leads SET follow_up_date=NULL WHERE id=2")
    })
    await test('all server views are scoped; mine requires a real active membership',async()=>{
      assert.deepEqual((await load('human')).items.map(i=>i.leadId),[3,6])
      assert.deepEqual((await load('unassigned')).items.map(i=>i.leadId),[3,2,7,10])
      assert.deepEqual((await load('mine')).items.map(i=>i.leadId),[1,6])
      for(const user of ['inactive','other-user','no-membership']){
        const result=await load('mine',1,25,user)
        assert.equal(result.currentMemberId,null)
        assert.equal(result.counts.mine,0)
        assert.deepEqual(result.items,[])
      }
    })
    await test('stable pages retain counters and total even when the requested page is empty',async()=>{
      const first=await load('all',1,3),second=await load('all',2,3),last=await load('all',3,3),empty=await load('all',4,3)
      assert.deepEqual([...first.items,...second.items,...last.items].map(i=>i.leadId),[1,3,2,6,8,11,7,10])
      assert.equal(first.hasMore,true);assert.equal(second.hasMore,true);assert.equal(last.hasMore,false)
      assert.equal(empty.total,8);assert.equal(empty.hasMore,false);assert.deepEqual(empty.counts,first.counts)
    })
    await test('acknowledging overdue alerts does not hide the still outstanding promise',async()=>{
      await db.insert(schema.sacPendingItems).values({companyId:1,leadId:1,ruleType:'proxima_acao_vencida',sourceKey:'ack',reason:'Prazo da próxima ação vencido',state:'descartado'})
      assert.equal((await load('overdue')).items.some(i=>i.leadId===1),true)
    })
    await test('input limits reject malformed, fractional, negative and excessive page/query values',()=>{
      for(const query of ['view=other','page=0','page=-1','page=1.5','page=1e2','page=100001','pageSize=0','pageSize=101','pageSize=NaN','pageSize=']){
        assert.throws(()=>parseAttentionQuery(new URLSearchParams(query)))
      }
      assert.deepEqual(parseAttentionQuery(new URLSearchParams()),{view:'all',page:1,pageSize:25})
    })
    await test('real attention API uses session company and active member, ignores forged tenant/member parameters and disables caching',async()=>{
      session={id:'operator',primaryEmail:'operator@example.test',primaryEmailVerified:true,isAdmin:false}
      const response=await GET(new NextRequest('http://localhost/api/inbox/attention?companyId=2&memberId=2&view=mine&pageSize=1'))
      assert.equal(response.status,200)
      assert.match(response.headers.get('cache-control')??'',/no-store/)
      const body=await response.json()
      assert.equal(body.currentMemberId,1)
      assert.equal(body.total,2)
      assert.equal(body.items[0].leadId,1)
      assert.equal(body.hasMore,true)
    })
    await test('real API returns 400 before reconciliation for invalid parameters and 401 without login',async()=>{
      for(const query of ['view=invalid','page=0','pageSize=101']){
        assert.equal((await GET(new NextRequest(`http://localhost/api/inbox/attention?${query}`))).status,400)
      }
      session=null
      assert.equal((await GET(new NextRequest('http://localhost/api/inbox/attention'))).status,401)
    })
  } finally { await database.close() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
