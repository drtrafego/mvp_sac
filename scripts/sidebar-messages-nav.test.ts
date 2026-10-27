import assert from 'node:assert/strict'
import test from 'node:test'

// tsx loads this client component as CommonJS in the Node test runner.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sidebar = require('../src/components/layout/sidebar') as typeof import('../src/components/layout/sidebar')

type NavItem = { label: string; href: string }

const sections: Array<[string, readonly NavItem[], string]> = [
  ['API Oficial', sidebar.apiOficialNav, '/inbox?channel=whatsapp'],
  ['Hotmart', sidebar.hotmartNav, '/inbox?source=hotmart'],
  ['Kiwify', sidebar.kiwifyNav, '/inbox?source=kiwify'],
  ['Greenn', sidebar.greennNav, '/inbox?source=greenn'],
  ['Zouti', sidebar.zoutiNav, '/inbox?source=zouti'],
  ['Instagram', sidebar.instagramNav, '/instagram'],
  ['Mineração', sidebar.mineracaoNav, '/inbox?channel=mineracao'],
]

test('cada setor de canal tem Mensagens com filtro próprio', () => {
  const hrefs = sections.map(([, items, expectedHref]) => {
    const messages = items.filter(item => item.label === 'Mensagens')
    assert.equal(messages.length, 1, 'cada setor deve ter exatamente uma entrada Mensagens')
    assert.equal(messages[0].href, expectedHref)
    return messages[0].href
  })

  assert.equal(new Set(hrefs).size, hrefs.length, 'setores não podem apontar todos para o mesmo filtro')
})

test('a navegação existente do SAC continua preservada', () => {
  assert.deepEqual(
    sidebar.apiOficialNav.slice(1).map(item => item.label),
    ['Mensagens aprovadas', 'Campanhas ativas', 'Disparo em massa', 'Follow-up'],
  )
  assert.ok(sidebar.kiwifyNav.some(item => item.label === 'Carrinho Kiwify'))
  assert.ok(sidebar.instagramNav.some(item => item.label === 'Conversas Direct'))
  assert.ok(sidebar.mineracaoNav.some(item => item.label === 'CRM Prospecção'))
})

test('integração desativada pode expor somente Mensagens por setor', () => {
  for (const items of [sidebar.hotmartNav, sidebar.greennNav, sidebar.zoutiNav, sidebar.mineracaoNav]) {
    assert.deepEqual(
      sidebar.getVisibleChannelNavItems(items, false, true),
      [items.find(item => item.label === 'Mensagens')],
    )
    assert.deepEqual(sidebar.getVisibleChannelNavItems(items, false, false), [])
    assert.deepEqual(sidebar.getVisibleChannelNavItems(items, true, false), [...items])
  }
})
