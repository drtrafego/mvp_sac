import { StackServerApp } from '@stackframe/stack'

const projectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID || process.env.STACK_PROJECT_ID
const publishableKey = process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY || process.env.STACK_PUBLISHABLE_CLIENT_KEY
const secretKey = process.env.STACK_SECRET_SERVER_KEY

export const stackMiddlewareApp = new StackServerApp({
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
