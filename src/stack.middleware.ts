import { StackServerApp } from '@stackframe/stack'

const projectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID || process.env.STACK_PROJECT_ID
const publishableKey = process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY || process.env.STACK_PUBLISHABLE_CLIENT_KEY
const secretKey = process.env.STACK_SECRET_SERVER_KEY

// Mesmo guard de src/stack.ts: sem projectId o construtor do StackServerApp
// lança na hora ("haven't provided a project ID"), e este módulo é importado
// sem condição por src/proxy.ts, que roda em toda request. Isso derrubava com
// 500 QUALQUER rota em qualquer ambiente sem as chaves do Stack Auth
// configuradas (preview sem os secrets de produção, dev local sem .env),
// mesmo o próprio proxy.ts já só chamando stackMiddlewareApp.getUser() quando
// stackProjectId existe.
export const stackMiddlewareApp = projectId
  ? new StackServerApp({
      tokenStore: 'nextjs-cookie',
      urls: {
        afterSignIn: '/',
        afterSignUp: '/',
        afterSignOut: '/handler/sign-in',
      },
      projectId,
      ...(publishableKey ? { publishableClientKey: publishableKey } : {}),
      ...(secretKey ? { secretServerKey: secretKey } : {}),
    })
  : (null as unknown as StackServerApp)
