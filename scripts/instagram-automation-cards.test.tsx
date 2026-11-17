import { before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AutomationRule } from '../src/components/instagram/automation-rule-card'
import type { Totals } from '../src/lib/instagram-automation-reporting'
let slots: unknown[] = [], cursor = 0
let effects: Array<() => unknown> = []
const exports = Object.fromEntries(Object.entries(React).filter(([key]) => key !== 'default'))
function state(initial: unknown) {
  const index = cursor++
  if (!(index in slots)) slots[index] = initial
  return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
}
mock.module('react', { defaultExport: exports, namedExports: { ...exports,
  useState: state, useRef: (initial: unknown) => state({current:initial})[0],
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = cursor++; const previous = slots[index] as unknown[] | undefined
    if (!previous || deps.some((v,i) => v !== previous[i])) { slots[index]=deps; effects.push(effect) }
  },
} })
let Card: typeof import('../src/components/instagram/automation-rule-card').AutomationRuleCard
let History: typeof import('../src/components/instagram/automation-history').AutomationHistory
let label: typeof import('../src/components/instagram/automation-history').deliveryLabel
before(async () => {
  Card = (await import('../src/components/instagram/automation-rule-card')).AutomationRuleCard
  const history = await import('../src/components/instagram/automation-history')
  History = history.AutomationHistory; label = history.deliveryLabel
})
const rule: AutomationRule = { id:7, name:'Palavra QUERO', keywords:'QUERO, LINK', matchType:'contains', isActive:true, mediaId:null, mediaUrl:null, mediaCaption:null, triggerType:'comment', dmMessage:'Aqui está seu material.', publicReply:null, hideCommentAfterReply:false, activeHoursStart:null, activeHoursEnd:null, requireFollowCheck:false, autoTag:null, totalTriggered:999, createdAt:'2026-11-16' }
const totals = { disparos:12, enviados:8, falhas:1, ignorados:2, ultimoDisparo:'2026-11-16T12:00:00Z' } as Totals
const noop = () => {}
function reset() { slots=[]; cursor=0; effects=[] }
test('mesmo card, STORY somente no Story, métricas reais e correspondência em português', () => {
  for (const type of ['comment','story'] as const) {
    reset()
    const html = renderToStaticMarkup(<Card rule={rule} type={type} totals={totals} onEdit={noop} onToggle={noop} onDelete={noop} />)
    assert.equal(html.includes('STORY'),type === 'story')
    assert.match(html,/Disparos[\s\S]*12[\s\S]*Enviados[\s\S]*8[\s\S]*Falhas[\s\S]*1[\s\S]*Ignorados[\s\S]*2/)
    assert.match(html,/Última vez/); assert.match(html,/Contém/)
    assert.match(html,/role="switch" aria-checked="true"/)
    assert.doesNotMatch(html,/999|visualizou|clicou|Sem regra|Histórico recente|contains/)
    assert.match(html,/Editar Palavra QUERO/); assert.match(html,/Excluir Palavra QUERO/)
  }
})
test('mapa único traduz todos os status e descarta códigos/motivos crus', () => {
  for (const [status, expected] of Object.entries({sent:'Enviado',failed:'Falhou',skipped:'Ignorado',observed:'Teste',reserved:'Em processamento',unknown:'Resultado não confirmado'})) assert.equal(label(status,null),expected)
  assert.equal(label('skipped','Limite de envios atingido.'),'Ignorado: Limite de envios atingido.')
  assert.equal(label('raw_status','token=segredo'),'Resultado não confirmado')
})
type El = React.ReactElement<{children?:React.ReactNode; onClick?:()=>void; disabled?:boolean; 'aria-expanded'?:boolean}>
function all(node: React.ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(all)
  if (!React.isValidElement(node)) return []
  const el=node as El
  return [el,...all(el.props.children)]
}
function button(tree: React.ReactNode, label: string) {
  const found=all(tree).find(el=>el.type === 'button' && renderToStaticMarkup(<>{el.props.children}</>).includes(label))
  assert.ok(found, label); return found
}
const flush = () => new Promise(resolve=>setTimeout(resolve,5))
test('histórico abre sob demanda, pagina, recolhe e mostra erro recuperável', async () => {
  reset()
  const requests:string[]=[]
  let fail=false
  const fetch=mock.method(globalThis,'fetch', async (url: RequestInfo | URL) => {
    requests.push(String(url))
    if (fail) return Response.json({}, {status:500})
    const page=Number(new URL(String(url),'http://localhost').searchParams.get('page'))
    return Response.json({page,limit:10,total:11, logs:[{ id:page, createdAt:'2026-11-16T12:00:00Z', commenterUsername:page===1?'ana':null, senderId:'****1234', status:page===1?'skipped':'observed', reason:page===1?'Limite de envios atingido.':'Modo teste: nenhum envio realizado.' }]})
  })
  function draw() { cursor=0; const tree=History({type:'story',id:7}); for(const effect of effects.splice(0)) effect(); return tree }
  try {
    let tree=draw(); assert.equal(requests.length,0)
    button(tree,'Ver histórico').props.onClick!(); draw(); await flush(); tree=draw()
    assert.equal(requests.length,1); assert.match(requests[0],/\/story\/7\/logs\?page=1&limit=10/)
    let html=renderToStaticMarkup(tree)
    assert.match(html,/@ana/); assert.match(html,/Ignorado: Limite de envios atingido/)
    assert.doesNotMatch(html,/skipped|sem regra|Nenhuma regra/i)
    assert.equal(button(tree,'Anterior').props.disabled,true)
    button(tree,'Próxima').props.onClick!(); draw(); await flush(); tree=draw()
    html=renderToStaticMarkup(tree); assert.match(html,/Teste/); assert.match(html,/\*{4}1234/)
    assert.match(html,/Página 2 de 2/); assert.equal(button(tree,'Próxima').props.disabled,true)
    button(tree,'Recolher histórico').props.onClick!(); tree=draw()
    assert.doesNotMatch(renderToStaticMarkup(tree),/\*{4}1234/)
    fail=true; button(tree,'Ver histórico').props.onClick!(); draw(); await flush(); tree=draw()
    assert.match(renderToStaticMarkup(tree),/role="alert"/)
    fail=false; button(tree,'Tentar novamente').props.onClick!(); draw(); await flush(); tree=draw()
    assert.doesNotMatch(renderToStaticMarkup(tree),/role="alert"/)
  } finally {fetch.mock.restore()}
})
