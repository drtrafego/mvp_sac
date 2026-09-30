// Teste de paginação de listMetaTemplates() (src/lib/whatsapp/meta.ts).
// A função buscava só os primeiros 100 templates via limit=100 sem seguir
// paging.next da Graph API (item 3 da investigação de 30/09/2026 sobre
// "frontend não aparece as msg aprovada na meta"). O fix segue paging.next
// até esgotar, com teto de segurança de 10 páginas e detecção de cursor
// repetido, e agora também avisa (console.warn) quando o teto corta uma
// lista que ainda tinha mais página pendente, pra não repetir o mesmo
// defeito de limite invisível (100 -> 1000).
//
// Mesmo padrão de scripts/mass-dispatch.test.ts (node:test + tsx). fetch é
// monkey-patchado via globalThis.fetch, igual scripts/lead-tags.test.ts,
// já que listMetaTemplates usa fetch global direto sem import de módulo
// próprio (não precisa de --experimental-test-module-mocks pra isso).
//
// Uso: npx tsx --test scripts/meta-templates-pagination.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listMetaTemplates, type MetaTemplate } from '../src/lib/whatsapp/meta'

const WABA_ID = '999888777'
const TOKEN = 'fake-token'

function template(name: string, status: string): MetaTemplate {
  return { name, status, language: 'pt_BR', category: 'MARKETING', components: [] }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('múltiplas páginas somam corretamente (3 páginas, 250 templates, status misto)', async () => {
  const originalFetch = globalThis.fetch
  const calledUrls: string[] = []
  try {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      calledUrls.push(url)

      if (!url.includes('after=')) {
        return jsonResponse({
          data: Array.from({ length: 100 }, (_, i) =>
            template(`t_page1_${i}`, i % 7 === 0 ? 'REJECTED' : 'APPROVED')),
          paging: { next: 'https://graph.facebook.com/v19.0/999888777/message_templates?limit=100&after=CURSOR_2' },
        })
      }
      if (url.includes('after=CURSOR_2')) {
        return jsonResponse({
          data: Array.from({ length: 100 }, (_, i) =>
            template(`t_page2_${i}`, i % 5 === 0 ? 'PENDING' : 'APPROVED')),
          paging: { next: 'https://graph.facebook.com/v19.0/999888777/message_templates?limit=100&after=CURSOR_3' },
        })
      }
      if (url.includes('after=CURSOR_3')) {
        return jsonResponse({
          data: Array.from({ length: 50 }, (_, i) =>
            template(`t_page3_${i}`, i % 3 === 0 ? 'REJECTED' : 'APPROVED')),
          paging: {},
        })
      }
      throw new Error(`URL inesperada no mock: ${url}`)
    }) as typeof fetch

    const result = await listMetaTemplates(WABA_ID, TOKEN)

    const expectedApproved =
      Array.from({ length: 100 }, (_, i) => i).filter(i => i % 7 !== 0).length +
      Array.from({ length: 100 }, (_, i) => i).filter(i => i % 5 !== 0).length +
      Array.from({ length: 50 }, (_, i) => i).filter(i => i % 3 !== 0).length

    assert.equal(result.length, expectedApproved)
    assert.ok(result.every(t => t.status === 'APPROVED'), 'só templates APPROVED sobrevivem ao filtro')
    assert.equal(calledUrls.length, 3, 'as 3 páginas foram buscadas, sem parar cedo nem repetir')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('cursor repetido (paging.next === url atual) para o loop sem re-fetch infinito', async () => {
  const originalFetch = globalThis.fetch
  let fetchCount = 0
  const SAME_URL = 'https://graph.facebook.com/v19.0/999888777/message_templates?fields=name,status,language,category,components&limit=100'
  try {
    globalThis.fetch = (async (input: unknown) => {
      fetchCount += 1
      const url = String(input)
      // A API devolve o MESMO url de novo em paging.next (bug real de cursor
      // que não avança). O loop tem que reconhecer isso e parar, não repetir.
      return jsonResponse({
        data: [template('t_unico', 'APPROVED')],
        paging: { next: url },
      })
    }) as typeof fetch
    void SAME_URL

    const result = await listMetaTemplates(WABA_ID, TOKEN)

    assert.equal(fetchCount, 1, 'cursor igual ao url atual não pode gerar um segundo fetch')
    assert.equal(result.length, 1)
    assert.equal(result[0].name, 't_unico')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('teto de 10 páginas contém o pior caso e dispara o warn de resultado incompleto', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  let fetchCount = 0
  const warnCalls: unknown[][] = []
  try {
    // Pior caso: a API SEMPRE devolve um paging.next novo (nunca esgota
    // sozinha). Sem o teto de segurança isso seria um loop infinito.
    globalThis.fetch = (async () => {
      fetchCount += 1
      return jsonResponse({
        data: [template(`t_${fetchCount}`, 'APPROVED')],
        paging: { next: `https://graph.facebook.com/v19.0/999888777/message_templates?limit=100&after=CURSOR_${fetchCount}` },
      })
    }) as typeof fetch
    console.warn = ((...args: unknown[]) => { warnCalls.push(args) }) as typeof console.warn

    const result = await listMetaTemplates(WABA_ID, TOKEN)

    assert.equal(fetchCount, 10, 'o teto de segurança para em 10 páginas, nunca entra em loop infinito')
    assert.equal(result.length, 10)
    assert.equal(warnCalls.length, 1, 'o teto atingido com paging.next ainda pendente tem que avisar exatamente uma vez')
    const [message] = warnCalls[0]
    assert.match(String(message), /listMetaTemplates/)
    assert.match(String(message), /teto de 10 páginas/)
    assert.match(String(message), new RegExp(WABA_ID))
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})

test('lista que esgota antes do teto NÃO dispara o warn (só o corte real avisa)', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnCalls: unknown[][] = []
  try {
    globalThis.fetch = (async () => jsonResponse({
      data: [template('t_unico', 'APPROVED')],
      paging: {},
    })) as typeof fetch
    console.warn = ((...args: unknown[]) => { warnCalls.push(args) }) as typeof console.warn

    await listMetaTemplates(WABA_ID, TOKEN)

    assert.equal(warnCalls.length, 0, 'paginação que esgota sozinha (sem next pendente) não deve avisar nada')
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})
