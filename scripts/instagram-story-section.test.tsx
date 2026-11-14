import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { StoryAutomationsSection } from '../src/components/instagram/story-automations-section'

test('Resposta ao Story não renderiza antes de confirmar a conta piloto', () => {
  const html = renderToStaticMarkup(<StoryAutomationsSection />)
  assert.equal(html, '')
})
