import { test, expect, login, tenants } from './fixtures'

test('página de login sem credencial real mostra configuração pendente', async ({ page }) => {
  const response = await page.goto('/handler/sign-in')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Configuração do Stack Auth Pendente' })).toBeVisible()
})

test('página protegida exige login', async ({ page }) => {
  await page.goto('/leads')
  await expect(page).toHaveURL(/\/handler\/sign-in/)
  await expect(page.getByRole('heading', { name: 'Configuração do Stack Auth Pendente' })).toBeVisible()
})

test.describe('painel com empresa sintética', () => {
  test.beforeEach(async ({ context }) => { await login(context) })

  for (const [path, heading] of [
    ['/', 'Central de Atendimento & Fechamento'],
    ['/leads', 'Leads'],
    ['/analytics-vendas', 'Analytics Vendas'],
    ['/agente', 'Agente'],
    ['/pipeline', 'Pipeline de Atendimento & Vendas'],
    ['/configuracoes', 'Configurações'],
    ['/comentarios-instagram', 'Comentário vira DM no Instagram'],
    ['/api-followup', 'Follow-up Inteligente'],
    ['/api-campanhas', 'Campanhas & Disparos Ativos'],
    ['/boleto', 'Recuperação de Boleto'],
    ['/pix', 'Recuperação de Pix'],
  ]) {
    test(`carrega ${path}`, async ({ page }) => {
      const response = await page.goto(path)
      expect(response?.status()).toBe(200)
      await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
    })
  }

  test('navega de leads ao inbox e pipeline pelo menu', async ({ page }) => {
    await page.goto('/leads')
    await page.locator('a[href="/inbox"]').filter({ visible: true }).first().click()
    await expect(page).toHaveURL(/\/inbox$/)
    await expect(page.getByText('Selecione uma conversa', { exact: true })).toBeVisible()
    await page.locator('a[href="/pipeline"]').filter({ visible: true }).first().click()
    await expect(page).toHaveURL(/\/pipeline$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('formulário impede telefone vazio e rejeita telefone curto', async ({ page }) => {
    await page.goto('/leads')
    await page.getByRole('button', { name: /Adicionar Lead/ }).click()
    const save = page.getByRole('button', { name: 'Salvar Lead' })
    await expect(save).toBeDisabled()
    await page.getByPlaceholder('Ex: 11 99999-8888').fill('123')
    const response = page.waitForResponse(r => r.url().endsWith('/api/leads') && r.request().method() === 'POST')
    await save.click()
    expect((await response).status()).toBe(400)
    await expect(page.getByText('Número de telefone inválido (mínimo 10 dígitos com DDD).', { exact: true })).toBeVisible()
  })

  test('cadastro manual sem disparo persiste e aparece na busca', async ({ page }) => {
    await page.goto('/leads')
    await page.getByRole('button', { name: /Adicionar Lead/ }).click()
    await page.getByPlaceholder('Ex: João Silva').fill('Cadastro E2E Sintético')
    await page.getByPlaceholder('Ex: 11 99999-8888').fill('00000000000')
    await expect(page.locator('#triggerSequence')).not.toBeChecked()
    const response = page.waitForResponse(r => r.url().endsWith('/api/leads') && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Salvar Lead' }).click()
    expect((await response).ok()).toBeTruthy()
    await expect(page.getByText('Lead cadastrado com sucesso!', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByPlaceholder('Buscar por nome, telefone, email ou produto...').fill('Cadastro E2E Sintético')
    await expect(page.getByText('Cadastro E2E Sintético', { exact: true }).first()).toBeVisible()
  })

  test('inbox abre histórico sintético sem enviar mensagem', async ({ page }) => {
    await page.goto(`/inbox/${tenants.alpha.leadId}`)
    await expect(page.getByText('Mensagem sintética de teste', { exact: true }).last()).toBeVisible()
    await expect(page.getByText(tenants.beta.name, { exact: true })).toHaveCount(0)
  })

  test('tags comuns persistem e são removidas', async ({ page }) => {
    const path = `/api/leads/${tenants.alpha.leadId}/tags`
    const add = await page.request.post(path, { data: { tag: 'smoke-e2e' } })
    expect(add.ok()).toBeTruthy()
    const list = await page.request.get(path)
    expect((await list.json()).tags.map((tag: { tag: string }) => tag.tag)).toContain('smoke-e2e')
    expect((await page.request.delete(`${path}/smoke-e2e`)).ok()).toBeTruthy()
    expect((await (await page.request.get(path)).json()).tags).toEqual([])
  })

  test('empresa Alpha não lê nem altera lead da Beta', async ({ page }) => {
    for (const path of [`/api/inbox/${tenants.beta.leadId}`, `/api/leads/${tenants.beta.leadId}/tags`]) {
      expect((await page.request.get(path)).status()).toBe(404)
    }
    expect((await page.request.post(`/api/leads/${tenants.beta.leadId}/tags`, { data: { tag: 'indevida' } })).status()).toBe(404)
    const crossTenant = await page.request.get(`/api/v1/companies/${tenants.beta.slug}/leads`)
    expect(crossTenant.status()).toBe(403)
  })
})

test('Beta enxerga seu lead e não recebe tag da Alpha', async ({ context, page }) => {
  await login(context, 'beta')
  await page.goto('/leads')
  await expect(page.getByText(tenants.beta.name, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(tenants.alpha.name, { exact: true })).toHaveCount(0)
  const tags = await page.request.get(`/api/leads/${tenants.beta.leadId}/tags`)
  expect((await tags.json()).tags).toEqual([])
})

test('cron e webhooks rejeitam chamada sem credencial', async ({ request }) => {
  expect((await request.get('/api/cron')).status()).toBe(401)
  for (const provider of ['hotmart', 'greenn', 'kiwify', 'zouti']) {
    const response = await request.post(`/api/webhooks/${provider}/e2e-alpha`, { data: {} })
    expect(response.status()).toBe(401)
  }
})
