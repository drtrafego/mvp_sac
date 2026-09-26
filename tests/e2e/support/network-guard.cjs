/* eslint-disable @typescript-eslint/no-require-imports -- preload CommonJS exigido por node --require */
// Aplicado só ao processo Next descartável, inclusive seus subprocessos Node.
const net = require('node:net')
const http = require('node:http')
const https = require('node:https')
function assertLocal(host) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('E2E bloqueou conexão externa')
  }
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof first === 'object') {
    if (first.path) throw new Error('E2E bloqueou socket Unix')
    assertLocal(first.host || 'localhost')
  } else if (typeof first === 'number') {
    assertLocal(typeof args[1] === 'string' ? args[1] : 'localhost')
  } else {
    throw new Error('E2E bloqueou conexão desconhecida')
  }
  return connect.apply(this, args)
}
for (const mod of [http, https]) {
  for (const key of ['request', 'get']) {
    const original = mod[key]
    mod[key] = function (target, ...args) {
      const options = typeof target === 'string' || target instanceof URL ? new URL(target) : target
      assertLocal(options.hostname || options.host || 'localhost')
      return original.call(this, target, ...args)
    }
  }
}
const originalFetch = globalThis.fetch
globalThis.fetch = function (input, options) {
  assertLocal(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname)
  return originalFetch(input, options)
}
