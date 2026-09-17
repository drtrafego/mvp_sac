import { proxy, config as proxyConfig } from './proxy'
import { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  return proxy(request)
}

export const config = proxyConfig
