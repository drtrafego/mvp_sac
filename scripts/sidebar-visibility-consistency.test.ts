import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolveSidebarVisibility } from '../src/components/layout/sidebar'

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
