import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { mock, test } from 'node:test'
import * as React from 'react'

let pathname = '/'
let open = false
const reactExports = Object.fromEntries(Object.entries(React).filter(([key]) => key !== 'default'))
mock.module('react', { defaultExport: reactExports, namedExports: { ...reactExports,
  useState: () => [open, (next: boolean) => { open = next }],
} })
mock.module('next/navigation', { namedExports: {
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
} })
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MobileTabBar } = require('../src/components/layout/mobile-tabbar') as typeof import('../src/components/layout/mobile-tabbar')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SidebarNavContent } = require('../src/components/layout/sidebar') as typeof import('../src/components/layout/sidebar')

type Element = React.ReactElement<{
  children?: React.ReactNode; href?: string; className?: string
  'aria-label'?: string; 'aria-current'?: string; 'aria-expanded'?: boolean
  onClick?: () => void; open?: boolean
}>
function all(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all)
  if (!React.isValidElement(node)) return []
  const element = node as Element
  return [element, ...all(element.props.children)]
}
function draw(props: Parameters<typeof MobileTabBar>[0] = {}) {
  // Executa o componente real vinculado à rota, preservando o JSX e os handlers.
  const element = MobileTabBar(props)
  const component = element.type as (props: typeof element.props) => React.ReactNode
  return component(element.props)
}

// Ordem do Gastão em 16/11/2026: CRM substitui Analytics, mantendo quatro links e Mais.
test('barra móvel tem CRM na rota existente e mantém cinco posições e estilo', async () => {
  pathname = '/'
  open = false
  const tree = draw()
  const links = all(tree).filter(el => el.props.href)
  assert.deepEqual(links.map(el => ({ href: el.props.href, labels: all(el).flatMap(child =>
    typeof child.props.children === 'string' ? [child.props.children] : []) })), [
    { href: '/', labels: ['Dashboard'] },
    { href: '/inbox', labels: ['Inbox'] },
    { href: '/leads', labels: ['Leads'] },
    { href: '/pipeline', labels: ['CRM'] },
  ])
  assert.ok(!all(tree).some(el => el.props.children === 'Analytics' || el.props.href === '/analytics-vendas'))
  const buttons = all(tree).filter(el => el.type === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props['aria-label'], 'Abrir menu')
  assert.ok(all(buttons[0]).some(el => el.props.children === 'Mais'))
  const nav = all(tree).find(el => el.type === 'nav')!
  for (const token of ['fixed', 'bottom-0', 'lg:hidden', 'pb-[env(safe-area-inset-bottom)]']) {
    assert.ok(nav.props.className?.split(' ').includes(token))
  }
  for (const el of [...links, ...buttons]) assert.ok(el.props.className?.split(' ').includes('flex-1'))
  await access(new URL('../src/app/(dashboard)/pipeline/page.tsx', import.meta.url))
})

test('CRM é a aba ativa no pipeline e Mais continua abrindo o menu com o contexto da empresa', () => {
  for (const route of ['/pipeline', '/pipeline/etapa']) {
    pathname = route
    open = false
    const links = all(draw()).filter(el => el.props['aria-current'] === 'page')
    assert.deepEqual(links.map(el => el.props.href), ['/pipeline'])
    const more = all(draw()).find(el => el.type === 'button')!
    assert.equal(more.props['aria-expanded'], false)
    assert.ok(!more.props.className?.includes('font-bold'))
  }
  for (const isAdmin of [false, true]) {
    pathname = '/agente'
    open = false
    const props = { isAdmin, activeConnections: { hotmart: true }, sidebarConfig: { showHotmart: false } }
    const more = all(draw(props)).find(el => el.type === 'button')!
    assert.ok(more.props.className?.includes('font-bold'))
    more.props.onClick!()
    const expanded = draw(props)
    assert.equal(all(expanded).find(el => el.type === 'button')!.props['aria-expanded'], true)
    assert.ok(all(expanded).some(el => el.props.open === true))
    assert.deepEqual(all(expanded).find(el => el.type === SidebarNavContent)!.props, props)
  }
})

test('barra móvel continua oculta dentro das conversas e o estado do menu pertence à rota', () => {
  for (const route of ['/inbox/123', '/instagram/123']) {
    pathname = route
    assert.equal(draw(), null)
  }
  for (const route of ['/inbox', '/instagram', '/pipeline']) {
    pathname = route
    assert.ok(draw())
    assert.equal(MobileTabBar({}).key, route)
  }
})
