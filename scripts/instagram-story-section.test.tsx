import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { StoryAutomationsSectionContent } from '../src/components/instagram/story-automations-section'

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
