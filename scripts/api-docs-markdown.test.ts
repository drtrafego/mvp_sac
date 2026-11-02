import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const contractPath = new URL('../API_DOCS.md', import.meta.url)
const routePath = new URL('../src/app/docs/API_AGENTE_SAC.md/route.ts', import.meta.url)
const proxyPath = new URL('../src/proxy.ts', import.meta.url)

test('Markdown da API é servido pelo contrato existente e com tipo correto', async () => {
  const contract = await readFile(contractPath, 'utf8')
  const routeSource = await readFile(routePath, 'utf8')
  const proxySource = await readFile(proxyPath, 'utf8')

  assert.match(contract, /^# .*Documentação Oficial da API/m)
  assert.match(routeSource, /readFile\(join\(process\.cwd\(\), 'API_DOCS\.md'\), 'utf8'\)/)
  assert.match(routeSource, /Content-Type': 'text\/markdown; charset=utf-8'/)
  assert.match(proxySource, /PUBLIC_MARKDOWN_PATHS = new Set\(\['\/docs\/API_AGENTE_SAC\.md'\]\)/)
})
