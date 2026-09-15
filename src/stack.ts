import 'server-only'
import { StackServerApp } from '@stackframe/stack'

const projectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID || process.env.STACK_PROJECT_ID
const publishableKey = process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY || process.env.STACK_PUBLISHABLE_CLIENT_KEY
const secretKey = process.env.STACK_SECRET_SERVER_KEY

// Inicializa somente quando as env vars existem (suporta com ou sem o prefixo NEXT_PUBLIC_)
export const stackServerApp = projectId
  ? new StackServerApp({
      tokenStore: 'nextjs-cookie',
      urls: {
        afterSignIn: '/',
        afterSignUp: '/',
        afterSignOut: '/handler/sign-in',
      },
      ...(projectId ? { projectId } : {}),
      ...(publishableKey ? { publishableClientKey: publishableKey } : {}),
      ...(secretKey ? { secretServerKey: secretKey } : {}),
    })
  : null as unknown as StackServerApp
