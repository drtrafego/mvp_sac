import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import * as React from 'react'
import type { ReactNode } from 'react'


// Mesmo padrão das suítes de UI do operador: JSX e handlers reais,
// com estados isolados por componente e efeitos de montagem controlados.
type Hooks = { slots: unknown[]; cursor: number; effects: Array<() => unknown> }
let active: Hooks
function hooks(): Hooks { return { slots: [], cursor: 0, effects: [] } }
function state(initial: unknown) {
  const owner = active; const index = owner.cursor++
  if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial
  return [owner.slots[index], (next: unknown) => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next }]
}
const exports = Object.fromEntries(Object.entries(React).filter(([key]) => key !== 'default'))
mock.module('react', { defaultExport: exports, namedExports: { ...exports,
  useState: state,
  useRef: (initial: unknown) => state({ current: initial })[0],
  useEffect: (effect: () => unknown, deps?: unknown[]) => {
    const index = active.cursor++
    const previous = active.slots[index] as unknown[] | undefined
    if (!deps || !previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
      active.slots[index] = deps
      active.effects.push(effect)
    }
  },
  useImperativeHandle: (ref: React.Ref<unknown> | undefined, create: () => unknown) => {
    if (typeof ref === 'function') ref(create())
    else if (ref) ref.current = create()
  },
} })
let Page: typeof import('../src/app/(dashboard)/comentarios-instagram/page').default
let Section: typeof import('../src/components/instagram/story-automations-section').StoryAutomationsSection
let StoryAutomationsSectionContent: typeof import('../src/components/instagram/story-automations-section').StoryAutomationsSectionContent
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
before(async () => {
  Page = (await import('../src/app/(dashboard)/comentarios-instagram/page')).default
  const section = await import('../src/components/instagram/story-automations-section')
  Section = section.StoryAutomationsSection
  StoryAutomationsSectionContent = section.StoryAutomationsSectionContent
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } })
})
after(() => {
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

const render = (loading: boolean, loadError: string | null, children: ReactNode) => renderToStaticMarkup(<StoryAutomationsSectionContent loading={loading} loadError={loadError} onRetry={() => {}}>{children}</StoryAutomationsSectionContent>)

test('Resposta ao Story mantém carregamento, erro, vazio e regras visíveis no estado correto', () => {
  const loading = render(true, null, <p>Nenhuma regra de resposta ao Story criada.</p>)
  assert.match(loading, /Carregando automações de Story/)
  assert.doesNotMatch(loading, /Nenhuma regra|Nova regra/)

  const error = render(false, 'Não foi possível carregar as automações de Story.', <p>Nenhuma regra de resposta ao Story criada.</p>)
  assert.match(error, /Não foi possível carregar as automações de Story/)
  assert.match(error, /Tentar de novo/)
  assert.doesNotMatch(error, /Nenhuma regra/)

  const empty = render(false, null, <><h2>Resposta ao Story</h2><button>Nova regra</button><p>Nenhuma regra de resposta ao Story criada.</p></>)
  assert.match(empty, /Nova regra/)
  assert.match(empty, /Nenhuma regra de resposta ao Story criada/)

  const withRules = render(false, null, <><h2>Resposta ao Story</h2><button>Nova regra</button><p>Regra para Story</p></>)
  assert.match(withRules, /Regra para Story/)
})

type Element = React.ReactElement<{
  children?: ReactNode; actions?: ReactNode; className?: string; title?: string
  role?: string; 'aria-label'?: string; 'aria-labelledby'?: string; id?: string; disabled?: boolean; value?: string; checked?: boolean
  ref?: React.Ref<unknown>; onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onClick?: () => void; onChange?: (event: { target: { value: string } }) => void
}>
function all(node: ReactNode, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap(child => all(child, predicate))
  if (!React.isValidElement(node)) return []
  const el = node as Element
  if (el.type === StoryAutomationsSectionContent) return all(StoryAutomationsSectionContent(el.props as React.ComponentProps<typeof StoryAutomationsSectionContent>), predicate)
  return [...(predicate(el) ? [el] : []), ...all(el.props.children, predicate), ...all(el.props.actions, predicate)]
}
function text(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join('')
  if (React.isValidElement(node)) return text((node as Element).props.children)
  return ''
}
function button(tree: ReactNode, name: string) {
  const found = all(tree, el => el.type === 'button' && text(el.props.children) === name)
  assert.equal(found.length, 1, `Deve haver um único botão ${name}`)
  return found[0]
}
function field(tree: ReactNode, label: string) {
  const wrapper = all(tree, el => el.type === 'label' && text(el.props.children).trim().startsWith(label))[0]
  assert.ok(wrapper, `Campo ${label}`)
  return all(wrapper, el => ['input', 'textarea', 'select'].includes(String(el.type)))[0]
}
function assertManualForm(tree: ReactNode) {
  const dialogs = all(tree, el => el.props.role === 'dialog')
  assert.equal(dialogs.length, 1)
  const dialog = dialogs[0]
  const markup = renderToStaticMarkup(dialog)
  assert.doesNotMatch(markup, /Modo|Ativar regra agora/)
  assert.equal(all(dialog, el => el.type === 'input' && el.props.checked !== undefined).length, 2, 'Só os rádios de alcance do Story')
  assert.equal(all(dialog, el => el.type === 'select').length, 1, 'Só o tipo de correspondência')
  assert.match(markup, /últimas 24 horas/)
  assert.match(markup, /DM vai apenas para quem responder por texto ou emoji e corresponder à regra/)
  assert.match(markup, /Curtidas com coração não geram DM/)
  assert.match(markup, /Ao salvar, a regra fica ativa e valendo/)
  for (const label of ['Nome', 'Resposta', 'Mensagem do Direct']) field(dialog, label)
  assert.match(markup, /Todos os Stories|Um Story específico/)
}
const flush = () => new Promise(resolve => setTimeout(resolve, 5))
const existing = { id: 7, name: 'Regra existente', keywords: ['quero'], matchType: 'contains', storyId: null, dmMessage: 'Olá', mode: 'send', isActive: true, enabledAt: null }
function setup(rules: unknown[] = []) {
  const pageHooks = hooks(); const sectionHooks = hooks()
  // Pequeno adaptador de foco para os handlers reais. A navegação nativa de Tab
  // também é verificada no Chromium, pois este renderizador não monta um DOM.
  type FocusNode = { isConnected: boolean; focus: () => void; contains?: (node: unknown) => boolean; querySelectorAll?: () => FocusNode[] }
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const documentStub = { activeElement: null as FocusNode | null }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })
  const nodes = new Map<string, FocusNode>()
  const elements = new WeakMap<Element, FocusNode>()
  const bind = (tree: ReactNode, prefix: string) => {
    const rendered = all(tree, el => typeof el.type === 'string')
    for (const [index, el] of rendered.entries()) {
      const key = `${prefix}:${el.type}:${el.props.role ?? text(el.props.children)}:${index}`
      let node = nodes.get(key)
      if (!node) {
        node = { isConnected: true, focus() { documentStub.activeElement = this } }
        nodes.set(key, node)
      }
      node.isConnected = true
      elements.set(el, node)
      if (typeof el.props.ref === 'function') el.props.ref(node)
      else if (el.props.ref) el.props.ref.current = node
    }
    for (const dialog of rendered.filter(el => el.props.role === 'dialog')) {
      const children = all(dialog.props.children, () => true)
      const node = elements.get(dialog)!
      node.contains = target => children.some(el => elements.get(el) === target)
      node.querySelectorAll = () => children.filter(el => ['button', 'input', 'textarea', 'select'].includes(String(el.type)) && !el.props.disabled).map(el => elements.get(el)!)
    }
  }
  const requests: Array<{ url: string; method: string; body?: unknown }> = []
  const responses = { listError: false, storiesError: false, saveError: false, holdSave: null as Promise<void> | null }
  const fetch = mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url); const method = init?.method ?? 'GET'
    requests.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if ((path === '/api/story-automations' && method === 'POST') || (path === `/api/story-automations/${existing.id}` && method === 'PATCH')) {
      await responses.holdSave
      return responses.saveError ? Response.json({ error: 'Falha ao salvar de teste.' }, { status: 400 }) : Response.json({ automation: existing }, { status: 201 })
    }
    if (path === '/api/story-automations') return responses.listError ? Response.json({ error: 'Falha ao carregar de teste.' }, { status: 503 }) : Response.json({ automations: rules })
    if (path === '/api/story-automations/stories') return responses.storiesError ? Response.json({ error: 'Falha nos Stories de teste.' }, { status: 502 }) : Response.json({ stories: [] })
    if (['/api/story-automations/logs', '/api/comment-automations/all/logs'].includes(path)) return Response.json({ logs: [] })
    if (path === '/api/comment-automations') return Response.json({ automations: [] })
    if (path === '/api/instagram-tag-rules') return Response.json({ rules: [] })
    if (path === '/api/comment-automations/media') return Response.json({ ok: true, media: [] })
    assert.fail(`Requisição inesperada: ${method} ${path}`)
  })
  let page: ReactNode; let section: ReactNode
  const draw = () => {
    active = pageHooks; active.cursor = 0; page = Page()
    const child = all(page, el => el.type === Section)[0]
    assert.ok(child, 'Uma seção de Story real deve estar montada na página')
    active = sectionHooks; active.cursor = 0
    section = Section(child.props as React.ComponentProps<typeof Section>)
    for (const node of nodes.values()) node.isConnected = false
    bind(page, 'page'); bind(section, 'section')
    for (const owner of [pageHooks, sectionHooks]) {
      for (const effect of owner.effects.splice(0)) effect()
    }
    return { page, section }
  }
  const mount = async () => {
    draw()
    await flush()
    return draw()
  }
  return { draw, mount, requests, responses, node: (el: Element) => elements.get(el)!,
    focused: () => documentStub.activeElement,
    restore: () => {
      fetch.mock.restore()
      if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore)
      else Reflect.deleteProperty(globalThis, 'document')
    },
  }
}

for (const rules of [[], [existing]]) {
  test(`Cabeçalho abre Story ao lado de Nova Automação, com ${rules.length} regra(s), e ambos os acessos usam o mesmo submit`, async () => {
    const ui = setup(rules)
    try {
      let tree = await ui.mount()
      const headers = all(tree.page, el => el.props.actions !== undefined)
      assert.equal(headers.length, 1, 'Cabeçalho único da página')
      const newComment = button(headers[0].props.actions, 'Nova Automação')
      const newStory = button(headers[0].props.actions, 'Resposta ao Story')
      const group = all(tree.page, el => el.type === 'div' && Array.isArray(el.props.children) && el.props.children.includes(newComment) && el.props.children.includes(newStory))
      assert.equal(group.length, 1, 'Os botões devem ser irmãos no cabeçalho')
      const siblings = group[0].props.children as ReactNode[]
      assert.equal(siblings.indexOf(newStory), siblings.indexOf(newComment) + 1)
      assert.equal(newStory.props.className, newComment.props.className)
      assert.match(newStory.props['aria-label']!, /Story.*nova regra/)
      assert.match(newStory.props.title!, /Criar regra/)
      assert.match(group[0].props.className!, /flex-wrap/)
      assert.match(button(tree.section, 'Nova regra').props.className!, /btn-secondary/)
      assert.match(renderToStaticMarkup(tree.section), /últimas 24 horas/)
      for (const entry of ['header', 'card']) {
        tree = ui.draw()
        button(entry === 'header' ? tree.page : tree.section, entry === 'header' ? 'Resposta ao Story' : 'Nova regra').props.onClick!()
        await flush(); tree = ui.draw()
        assert.equal(all(tree.section, el => el.props.role === 'dialog').length, 1)
        assert.match(renderToStaticMarkup(tree.section), /Nova regra de Story/)
        assert.equal(all(tree.page, el => el.type === 'form').length, 1, 'Não deve abrir o modal de comentário')
        assert.equal(ui.requests.filter(r => r.url === '/api/comment-automations/media').length, 0)
        assertManualForm(tree.section)
        for (const [label, value] of [['Nome', 'Teste'], ['Palavras,', ' QUERO, LINK '], ['Mensagem do Direct', 'Olá!']]) {
          field(ui.draw().section, label).props.onChange!({ target: { value } })
        }
        button(ui.draw().section, 'Salvar').props.onClick!()
        await flush(); tree = ui.draw()
        assert.equal(all(tree.section, el => el.props.role === 'dialog').length, 0)
        assert.doesNotMatch(renderToStaticMarkup(tree.section), /Falha|Não foi possível/)
      }
      const posts = ui.requests.filter(r => r.method === 'POST')
      assert.equal(posts.length, 2, 'Uma única submissão por entrada')
      assert.deepEqual(posts[0], posts[1], 'O botão novo deve usar exatamente o mesmo submit')
      assert.deepEqual(posts[0], { url: '/api/story-automations', method: 'POST', body: { name: 'Teste', keywords: ['QUERO', 'LINK'], matchType: 'contains', storyId: null, dmMessage: 'Olá!', mode: 'send', isActive: true } })
      button(tree.page, 'Nova Automação').props.onClick!()
      tree = ui.draw()
      assert.equal(all(tree.page, el => el.type === 'form').length, 2, 'Modal original continua funcionando')
      const trigger = all(tree.page, el => el.type === 'select' && all(el, child => child.type === 'option' && child.props.value === 'comment').length > 0)[0]
      assert.deepEqual(all(trigger, el => el.type === 'option').map(el => el.props.value), ['both', 'direct', 'comment'])
    } finally { ui.restore() }
  })
}

test('Cabeçalho abre formulário durante carregamento e erro; tentar de novo recupera o cartão', async () => {
  const ui = setup()
  try {
    let tree = ui.draw()
    assert.match(renderToStaticMarkup(tree.section), /Carregando automações de Story/)
    const origin = button(tree.page, 'Resposta ao Story')
    ui.node(origin).focus(); origin.props.onClick!()
    tree = ui.draw()
    assert.equal(all(tree.section, el => el.props.role === 'dialog').length, 1)
    assert.equal(ui.focused(), ui.node(field(tree.section, 'Nome')))
    button(tree.section, 'Fechar').props.onClick!()
    tree = ui.draw()
    assert.equal(ui.focused(), ui.node(button(tree.page, 'Resposta ao Story')), 'Retorna ao cabeçalho mesmo com a lista ainda carregando')
    ui.responses.listError = true
    tree = await ui.mount()
    assert.match(renderToStaticMarkup(tree.section), /Falha ao carregar de teste/)
    assert.doesNotMatch(renderToStaticMarkup(tree.section), /Nenhuma regra/)
    button(tree.page, 'Resposta ao Story').props.onClick!()
    await flush(); tree = ui.draw()
    assert.match(renderToStaticMarkup(tree.section), /Nova regra de Story/)
    button(tree.section, 'Cancelar').props.onClick!()
    ui.responses.listError = false
    button(ui.draw().section, 'Tentar de novo').props.onClick!()
    assert.match(renderToStaticMarkup(ui.draw().section), /Carregando automações/)
    await flush(); tree = ui.draw()
    assert.match(renderToStaticMarkup(tree.section), /Nenhuma regra/)
    button(tree.section, 'Nova regra')
  } finally { ui.restore() }
})

test('Falhas de Stories e salvamento continuam visíveis; envio fica desabilitado enquanto salva', async () => {
  const ui = setup()
  try {
    let tree = await ui.mount()
    ui.responses.storiesError = true
    button(tree.page, 'Resposta ao Story').props.onClick!()
    await flush(); tree = ui.draw()
    assert.match(renderToStaticMarkup(tree.section), /Falha nos Stories de teste/)
    ui.responses.saveError = true
    let release!: () => void
    ui.responses.holdSave = new Promise(resolve => { release = resolve })
    button(tree.section, 'Salvar').props.onClick!()
    tree = ui.draw()
    assert.equal(button(tree.section, 'Salvando...').props.disabled, true)
    button(tree.section, 'Salvando...').props.onClick!()
    assert.equal(ui.requests.filter(r => r.method === 'POST').length, 1)
    release(); await flush(); tree = ui.draw()
    assert.match(renderToStaticMarkup(tree.section), /Falha ao salvar de teste/)
    assert.equal(all(tree.section, el => el.props.role === 'dialog').length, 1)
    assert.equal(button(tree.section, 'Salvar').props.disabled, false)
    button(tree.section, 'Cancelar').props.onClick!()
    ui.responses.storiesError = false
    button(ui.draw().page, 'Resposta ao Story').props.onClick!()
    await flush()
    assert.doesNotMatch(renderToStaticMarkup(ui.draw().section), /Falha/)
  } finally { ui.restore() }
})

test('Abrir pelo cabeçalho após editar limpa a regra anterior e cria ativa/valendo', async () => {
  const ui = setup([existing])
  try {
    let tree = await ui.mount()
    button(tree.section, 'Editar').props.onClick!()
    await flush(); tree = ui.draw()
    assert.equal(field(tree.section, 'Nome').props.value, existing.name)
    assertManualForm(tree.section)
    button(tree.section, 'Fechar').props.onClick!()
    button(ui.draw().page, 'Resposta ao Story').props.onClick!()
    await flush(); tree = ui.draw()
    assert.equal(field(tree.section, 'Nome').props.value, '')
    assertManualForm(tree.section)
    button(tree.section, 'Salvar').props.onClick!()
    await flush()
    assert.deepEqual(ui.requests.filter(r => r.method !== 'GET').map(r => [r.url, r.method]), [['/api/story-automations', 'POST']])
  } finally { ui.restore() }
})

for (const old of [
  { mode: 'observe', isActive: false },
  { mode: 'observe', isActive: true },
  { mode: 'send', isActive: false },
  { mode: 'send', isActive: true },
]) {
  test(`Editar regra ${old.mode}/${old.isActive} salva ativa e valendo em um único PATCH`, async () => {
    const legacy = { ...existing, ...old, storyId: '12345678', matchType: 'exact' }
    const ui = setup([legacy])
    try {
      let tree = await ui.mount()
      button(tree.section, old.isActive ? 'Desativar' : 'Ativar')
      button(tree.section, 'Editar').props.onClick!()
      await flush(); tree = ui.draw()
      assertManualForm(tree.section)
      assert.equal(field(tree.section, 'Nome').props.value, legacy.name)
      assert.equal(field(tree.section, 'Resposta').props.value, 'exact')
      assert.equal(field(tree.section, 'Palavras,').props.value, 'quero')
      assert.equal(field(tree.section, 'Mensagem do Direct').props.value, legacy.dmMessage)
      button(tree.section, 'Salvar').props.onClick!()
      await flush(); tree = ui.draw()
      assert.equal(all(tree.section, el => el.props.role === 'dialog').length, 0)
      assert.deepEqual(ui.requests.filter(r => r.method !== 'GET'), [{
        url: `/api/story-automations/${existing.id}`, method: 'PATCH',
        body: { name: legacy.name, keywords: legacy.keywords, matchType: 'exact', storyId: legacy.storyId, dmMessage: legacy.dmMessage, mode: 'send', isActive: true },
      }])
    } finally { ui.restore() }
  })
}

test('Edição mantém erro e carregamento; liga/desliga da lista envia apenas isActive', async () => {
  const ui = setup([{ ...existing, mode: 'observe', isActive: false }])
  try {
    let tree = await ui.mount()
    button(tree.section, 'Ativar').props.onClick!()
    await flush(); tree = ui.draw()
    assert.deepEqual(ui.requests.filter(r => r.method === 'PATCH')[0].body, { isActive: true })
    button(tree.section, 'Editar').props.onClick!()
    await flush(); tree = ui.draw()
    ui.responses.saveError = true
    let release!: () => void
    ui.responses.holdSave = new Promise(resolve => { release = resolve })
    button(tree.section, 'Salvar').props.onClick!()
    assert.equal(button(ui.draw().section, 'Salvando...').props.disabled, true)
    release(); await flush(); tree = ui.draw()
    assert.match(renderToStaticMarkup(tree.section), /Falha ao salvar de teste/)
    assertManualForm(tree.section)
    assert.equal(button(tree.section, 'Salvar').props.disabled, false)
  } finally { ui.restore() }
})


for (const entry of ['header', 'card']) {
  for (const closing of ['Escape', 'Cancelar', 'Fechar', 'Salvar']) {
    test(`Teclado pelo ${entry}: foco inicial, ciclo Tab/Shift+Tab e retorno após ${closing}`, async () => {
      const ui = setup()
      try {
        let tree = await ui.mount()
        const origin = button(entry === 'header' ? tree.page : tree.section, entry === 'header' ? 'Resposta ao Story' : 'Nova regra')
        ui.node(origin).focus()
        origin.props.onClick!()
        tree = ui.draw()
        const dialog = all(tree.section, el => el.props.role === 'dialog')[0]
        assert.equal(ui.focused(), ui.node(field(tree.section, 'Nome')), 'Nome recebe foco ao abrir')
        assert.equal(dialog.props['aria-labelledby'], all(dialog, el => el.type === 'h3')[0].props.id)
        const press = (key: string, shiftKey = false) => {
          let prevented = false
          dialog.props.onKeyDown!({ key, shiftKey, preventDefault: () => { prevented = true }, stopPropagation() {} } as React.KeyboardEvent<HTMLDivElement>)
          return prevented
        }
        const first = ui.node(button(tree.section, 'Fechar'))
        const last = ui.node(button(tree.section, 'Salvar'))
        last.focus()
        assert.equal(press('Tab'), true)
        assert.equal(ui.focused(), first, 'Tab do último volta ao primeiro')
        assert.equal(press('Tab', true), true)
        assert.equal(ui.focused(), last, 'Shift+Tab do primeiro volta ao último')
        ui.node(field(tree.section, 'Nome')).focus()
        assert.equal(press('Tab'), false, 'Navegação interna permanece nativa')
        if (closing === 'Escape') press('Escape')
        else button(tree.section, closing).props.onClick!()
        await flush(); tree = ui.draw()
        assert.equal(all(tree.section, el => el.props.role === 'dialog').length, 0)
        assert.equal(ui.focused(), ui.node(button(entry === 'header' ? tree.page : tree.section, entry === 'header' ? 'Resposta ao Story' : 'Nova regra')), 'Foco volta à origem')
        assert.equal(ui.requests.filter(request => request.method === 'POST').length, closing === 'Salvar' ? 1 : 0, 'Fechar nunca salva')
      } finally { ui.restore() }
    })
  }
  test(`Escape pelo ${entry} aguarda salvamento; Tab ignora Salvar desabilitado`, async () => {
    const ui = setup()
    let release!: () => void
    try {
      let tree = await ui.mount()
      const origin = button(entry === 'header' ? tree.page : tree.section, entry === 'header' ? 'Resposta ao Story' : 'Nova regra')
      ui.node(origin).focus(); origin.props.onClick!()
      tree = ui.draw()
      ui.responses.saveError = true
      ui.responses.holdSave = new Promise(resolve => { release = resolve })
      ui.node(button(tree.section, 'Salvar')).focus()
      button(tree.section, 'Salvar').props.onClick!()
      tree = ui.draw()
      assert.equal(ui.focused(), ui.node(field(tree.section, 'Nome')), 'Foco permanece no modal quando Salvar fica desabilitado')
      const dialog = all(tree.section, el => el.props.role === 'dialog')[0]
      const press = (key: string, shiftKey = false) => dialog.props.onKeyDown!({ key, shiftKey, preventDefault() {}, stopPropagation() {} } as React.KeyboardEvent<HTMLDivElement>)
      ui.node(button(tree.section, 'Cancelar')).focus(); press('Tab')
      assert.equal(ui.focused(), ui.node(button(tree.section, 'Fechar')))
      press('Tab', true)
      assert.equal(ui.focused(), ui.node(button(tree.section, 'Cancelar')))
      press('Escape')
      assert.equal(all(ui.draw().section, el => el.props.role === 'dialog').length, 1, 'Escape não fecha enquanto salva')
      assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1)
      release(); await flush(); tree = ui.draw()
      assert.match(renderToStaticMarkup(tree.section), /Falha ao salvar de teste/)
      all(tree.section, el => el.props.role === 'dialog')[0].props.onKeyDown!({ key: 'Escape', preventDefault() {}, stopPropagation() {} } as React.KeyboardEvent<HTMLDivElement>)
      tree = ui.draw()
      assert.equal(all(tree.section, el => el.props.role === 'dialog').length, 0)
      assert.equal(ui.focused(), ui.node(button(entry === 'header' ? tree.page : tree.section, entry === 'header' ? 'Resposta ao Story' : 'Nova regra')))
    } finally { release?.(); ui.restore() }
  })
}
