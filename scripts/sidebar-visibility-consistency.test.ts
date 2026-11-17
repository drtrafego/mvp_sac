import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import * as React from 'react'
import type { ActiveConnections, SidebarMenuConfig } from '../src/components/layout/sidebar'
import { isInboxChannelAvailable } from '../src/components/inbox/ConversationList'

// Ordem do Gastão em 16/11/2026: exercita JSX, estado e handlers reais do menu.
let slots: unknown[] = []
let cursor = 0
let effects: Array<() => void> = []
let pathname = '/atender-agora'
const reactExports = Object.fromEntries(Object.entries(React).filter(([key]) => key !== 'default'))
mock.module('react', { defaultExport: reactExports, namedExports: { ...reactExports,
  useState: (initial: unknown) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next: unknown) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next
    }]
  },
  useEffect: (effect: () => void) => { effects.push(effect) },
} })
mock.module('next/navigation', { namedExports: {
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
} })
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveSidebarVisibility, SidebarNavContent } = require('../src/components/layout/sidebar') as typeof import('../src/components/layout/sidebar')

type Element = React.ReactElement<{
  children?: React.ReactNode; href?: string; title?: string
  'aria-label'?: string; 'aria-expanded'?: boolean; onClick?: () => void
}>
function all(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all)
  if (!React.isValidElement(node)) return []
  const element = node as Element
  return [element, ...all(element.props.children)]
}
function draw(props: Parameters<typeof SidebarNavContent>[0] = {}) {
  cursor = 0
  effects = []
  return SidebarNavContent(props)
}
function reset() { slots = []; cursor = 0; effects = []; pathname = '/atender-agora' }
function hrefs(tree: React.ReactNode) { return all(tree).flatMap(el => el.props.href ? [el.props.href] : []) }
function moreButton(tree: React.ReactNode) { return all(tree).find(el => el.type === 'button' && el.props['aria-label'] === 'Mais') }
const allConnections: ActiveConnections = {
  whatsappOfficial: true, hotmart: true, kiwify: true, greenn: true, zouti: true,
  instagram: true, instagramCommentAutomation: true, email: true, mineracao: true,
}

// Ordem do Gastão em 16/11/2026, SAC E2: Principal substitui Atendimento e Análise não existe.
test('cabeçalho Principal substitui Atendimento e continua recolhendo o menu principal', () => {
  for (const isAdmin of [false, true]) {
    reset()
    const tree = draw({ isAdmin })
    const header = all(tree).find(el => el.type === 'button'
      && all(el.props.children).some(child => child.props.children === 'Principal'))
    assert.ok(header, 'o cabeçalho visível deve ser Principal')
    assert.ok(!all(tree).some(el => el.props.children === 'Atendimento'))
    header.props.onClick!()
    assert.ok(!hrefs(draw({ isAdmin })).includes('/atender-agora'))
    header.props.onClick!()
    assert.ok(hrefs(draw({ isAdmin })).includes('/atender-agora'))
  }
})

test('Análise e seus itens não retornam nem com configuração legada habilitada e Mais aberto', () => {
  for (const isAdmin of [false, true]) {
    for (const collapsed of [false, true]) {
      reset()
      const props = { isAdmin, collapsed, activeConnections: allConnections, sidebarConfig: {
        showAnalise: true, showAnalyticsVendas: true, showCanais: true,
        showOrigens: true, showOperacao: true, showRecuperadorAdmin: true,
      } }
      moreButton(draw(props))?.props.onClick!()
      const tree = draw(props)
      for (const label of ['Análise', 'Analytics Vendas', 'Canais', 'Origens', 'Operação & SLA', 'Recuperador Admin']) {
        assert.ok(!all(tree).some(el => el.props.children === label
          || el.props.title === label || el.props['aria-label'] === label), `menu não deve expor ${label}`)
      }
      assert.ok(hrefs(tree).every(href => !/^\/(analytics-vendas|recuperador-admin|origens|operacao|canais)(?:[/?]|$)/.test(href)))
    }
  }
})

test('desktop e menu móvel recebem a mesma configuração de sidebar', async () => {
  const layout = await readFile(new URL('../src/app/(dashboard)/layout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /<MobileTabBar isAdmin activeConnections=\{activeConnections\} sidebarConfig=\{sidebarConfig\} \/>/)
  assert.match(layout, /<MobileTabBar activeConnections=\{activeConnections\} sidebarConfig=\{sidebarConfig\} \/>/)
})

test('Instagram só aparece com conexão operacional e a configuração apenas oculta', () => {
  const withoutConnection = resolveSidebarVisibility(
    { instagram: false },
    { showInstagram: true },
  )
  assert.equal(withoutConnection.instagram, false)

  const visible = resolveSidebarVisibility(
    { instagram: true },
    { showInstagram: true },
  )
  assert.equal(visible.instagram, true)

  const hidden = resolveSidebarVisibility(
    { instagram: true },
    { showInstagram: false },
  )
  assert.equal(hidden.instagram, false)
})

test('configuração visual não cria canais nem reativa Mensagens sem capacidade real', () => {
  const visibility = resolveSidebarVisibility(
    {
      whatsappOfficial: false,
      hotmart: false,
      kiwify: false,
      greenn: false,
      zouti: false,
      instagram: false,
      email: false,
      mineracao: false,
    },
    {
      showApiOficial: true,
      showHotmart: true,
      showKiwify: true,
      showGreenn: true,
      showZouti: true,
      showInstagram: true,
      showEmail: true,
      showMineracao: true,
      showHotmartMessages: true,
      showGreennMessages: true,
      showZoutiMessages: true,
      showMineracaoMessages: true,
    },
  )

  assert.deepEqual(visibility, {
    apiOficial: false,
    hotmart: false,
    kiwify: false,
    greenn: false,
    zouti: false,
    instagram: false,
    email: false,
    mineracao: false,
  })
})

test('capacidade real pode ser ocultada pela configuração da empresa', () => {
  const visibility = resolveSidebarVisibility(
    {
      whatsappOfficial: true,
      hotmart: true,
      kiwify: true,
      greenn: true,
      zouti: true,
      instagram: true,
      email: true,
      mineracao: true,
    },
    {
      showApiOficial: false,
      showHotmart: false,
      showKiwify: false,
      showGreenn: false,
      showZouti: false,
      showInstagram: false,
      showEmail: false,
      showMineracao: false,
    },
  )

  assert.deepEqual(visibility, {
    apiOficial: false,
    hotmart: false,
    kiwify: false,
    greenn: false,
    zouti: false,
    instagram: false,
    email: false,
    mineracao: false,
  })
})

test('menu móvel e desktop calculam a mesma visibilidade a partir do mesmo contexto', () => {
  const activeConnections = { hotmart: false, kiwify: true, instagram: true }
  const sidebarConfig = { showHotmart: false, showKiwify: true, showInstagram: true }
  const desktop = resolveSidebarVisibility(activeConnections, sidebarConfig)
  const mobile = resolveSidebarVisibility(activeConnections, sidebarConfig)
  assert.deepEqual(mobile, desktop)
  assert.equal(desktop.hotmart, false)
  assert.equal(desktop.kiwify, true)
  assert.equal(desktop.instagram, true)
})

test('filtros do inbox seguem as conexões ativas do tenant', () => {
  const inactive = {
    whatsappOfficial: false,
    instagram: true,
    email: false,
    mineracao: false,
  }
  assert.equal(isInboxChannelAvailable('whatsapp', inactive), false)
  assert.equal(isInboxChannelAvailable('email', inactive), false)
  assert.equal(isInboxChannelAvailable('instagram', inactive), true)
  assert.equal(isInboxChannelAvailable('mineracao', inactive), false)

  const active = { whatsappOfficial: true, instagram: true, email: true, mineracao: true }
  assert.equal(isInboxChannelAvailable('whatsapp', active), true)
  assert.equal(isInboxChannelAvailable('email', active), true)
  assert.equal(isInboxChannelAvailable('mineracao', active), true)
})

// Ordem do Gastão em 16/11/2026: Mais não pode ampliar acesso por papel ou empresa.
test('Mais só aparece para admin, inicia fechado e expande inclusive na barra compacta', () => {
  const extraHrefs = ['/api-docs', '/webhooks-log', '/biblioteca', '/aprenda-a-usar']
  for (const collapsed of [false, true]) {
    for (const isAdmin of [undefined, false, true]) {
      reset()
      const props = { isAdmin, collapsed, activeConnections: allConnections }
      const tree = draw(props)
      assert.equal(hrefs(tree).includes('/empresas'), isAdmin === true)
      assert.ok(extraHrefs.every(href => !hrefs(tree).includes(href)))
      const button = moreButton(tree)
      assert.equal(!!button, isAdmin === true)
      if (isAdmin) {
        assert.equal(button!.props['aria-expanded'], false)
        button!.props.onClick!()
        const expanded = draw(props)
        assert.equal(moreButton(expanded)!.props['aria-expanded'], true)
        assert.deepEqual(hrefs(expanded).filter(href => extraHrefs.includes(href)), extraHrefs)
        // Trocar de papel com a seção já aberta também deve fechar o acesso visual.
        const regular = draw({ ...props, isAdmin: false })
        assert.equal(moreButton(regular), undefined)
        assert.ok(extraHrefs.every(href => !hrefs(regular).includes(href)))
        moreButton(expanded)!.props.onClick!()
        assert.ok(extraHrefs.every(href => !hrefs(draw(props)).includes(href)))
      }
    }
  }
})

test('Mais respeita cada filtro da empresa e não deixa grupo vazio', () => {
  const cases = [
    ['showApiDocs', '/api-docs'], ['showWebhooksLog', '/webhooks-log'],
    ['showBiblioteca', '/biblioteca'], ['showAprenda', '/aprenda-a-usar'],
  ] as const
  for (const [key, href] of cases) {
    reset()
    const props = { isAdmin: true, sidebarConfig: { [key]: false } }
    moreButton(draw(props))!.props.onClick!()
    const links = hrefs(draw(props))
    assert.ok(!links.includes(href))
    for (const [, other] of cases) if (other !== href) assert.ok(links.includes(other))
  }
  reset()
  assert.equal(moreButton(draw({ isAdmin: true, sidebarConfig: {
    showApiDocs: false, showWebhooksLog: false, showBiblioteca: false, showAprenda: false,
  } })), undefined)
})

test('principal renderizado mantém ordem, capacidades e filtros de empresa', () => {
  for (const isAdmin of [false, true]) {
    reset()
    const tree = draw({ isAdmin, activeConnections: allConnections })
    const links = all(tree).filter(el => el.props.href && el.props.href !== '/empresas')
    assert.deepEqual(links.slice(0, 9).map(el => el.props.title), [
      'Visão geral', 'Atender agora', 'Conversas', 'CRM', 'Leads', 'Comentário → DM',
      'Disparo em massa', 'Agente', 'Configuração',
    ])
    assert.equal(hrefs(tree).filter(href => href === '/disparo-em-massa').length, 1)
    assert.ok(hrefs(tree).every(href => !/^\/(analytics-vendas|recuperador-admin|origens|operacao|canais)(?:\?|$)/.test(href)))
  }
  for (const [key, href] of [
    ['showVisaoGeral', '/'], ['showConversas', '/inbox'], ['showPipeline', '/pipeline'],
    ['showLeads', '/leads'], ['showAgente', '/agente'], ['showConfiguracoes', '/configuracoes'],
    ['showApiOficial', '/disparo-em-massa'],
  ] as const) {
    reset()
    assert.ok(!hrefs(draw({ activeConnections: allConnections, sidebarConfig: { [key]: false } })).includes(href))
  }
  reset()
  const noConnection = hrefs(draw({ sidebarConfig: { showApiOficial: true } }))
  assert.ok(!noConnection.includes('/disparo-em-massa'))
  assert.ok(!noConnection.includes('/comentarios-instagram'))
  reset()
  assert.ok(!hrefs(draw({ activeConnections: { instagram: true, instagramCommentAutomation: false } })).includes('/comentarios-instagram'))
})

test('cada plataforma só renderiza suas seis entradas com integração ativa e configuração permitida', () => {
  const cases = [
    ['hotmart', 'showHotmart'], ['kiwify', 'showKiwify'],
    ['greenn', 'showGreenn'], ['zouti', 'showZouti'],
  ] as const
  for (const [platform, key] of cases) {
    for (const isAdmin of [false, true]) {
      for (const connected of [undefined, false, true]) {
        for (const configured of [undefined, false, true]) {
          reset()
          const activeConnections: ActiveConnections = { [platform]: connected }
          const sidebarConfig: SidebarMenuConfig = { [key]: configured }
          const visible = connected === true && configured !== false
          assert.equal(resolveSidebarVisibility(activeConnections, sidebarConfig)[platform], visible)
          const links = hrefs(draw({ isAdmin, activeConnections, sidebarConfig }))
          assert.equal(links.filter(href => href.endsWith(`=${platform}`)).length, visible ? 6 : 0)
          for (const [other] of cases) {
            if (other !== platform) assert.ok(links.every(href => !href.endsWith(`=${other}`)))
          }
        }
      }
    }
  }
})

test('preferência antiga de Ajustes não expande Mais; navegar para recurso auxiliar abre Mais', () => {
  reset()
  const storage = new Map([['sac_sidebar_sections_open', JSON.stringify({ ajustes: true })]])
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } })
  try {
    draw({ isAdmin: true })
    effects.forEach(effect => effect())
    assert.equal(moreButton(draw({ isAdmin: true }))!.props['aria-expanded'], false)
    moreButton(draw({ isAdmin: true }))!.props.onClick!()
    assert.equal(JSON.parse(storage.get('sac_sidebar_sections_open')!).mais, true)
    reset()
    draw({ isAdmin: true })
    effects.forEach(effect => effect())
    assert.equal(moreButton(draw({ isAdmin: true }))!.props['aria-expanded'], true)
    reset()
    storage.clear()
    pathname = '/api-docs'
    draw({ isAdmin: true })
    effects.forEach(effect => effect())
    assert.equal(moreButton(draw({ isAdmin: true }))!.props['aria-expanded'], true)
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
