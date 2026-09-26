import { createHmac } from 'node:crypto'
import { test as base, expect, type BrowserContext } from 'playwright/test'
import { sessionSecret, tenants } from './support/constants'

export async function login(context: BrowserContext, tenant: keyof typeof tenants = 'alpha') {
  const data = tenants[tenant]
  const payload = Buffer.from(JSON.stringify({
    id: data.userId, primaryEmail: `${data.slug}@example.invalid`,
    displayName: `Operador ${tenant}`, isAdmin: false, exp: Date.now() + 3_600_000,
  })).toString('base64url')
  const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url')
  await context.addCookies([{
    name: 'agent_auth_session', value: `${payload}.${signature}`,
    url: 'http://127.0.0.1:3217', httpOnly: true, sameSite: 'Lax',
  }])
}

export const test = base.extend<{ safety: void }>({
  safety: [async ({ context, page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (new URL(response.url()).origin === 'http://127.0.0.1:3217' && response.status() >= 500) {
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
      }
    })
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === 'http://127.0.0.1:3217' ? route.continue() : route.abort('blockedbyclient')
    })
    await use()
    expect(errors, 'Erros JS ou HTTP 5xx durante o fluxo').toEqual([])
  }, { auto: true }],
})
export { expect, tenants }
