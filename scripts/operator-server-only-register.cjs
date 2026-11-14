/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require('node:module')
const path = require('node:path')
const original = Module._resolveFilename

Module._resolveFilename = function resolveOperatorServerOnly(request, parent, isMain, options) {
  if (request === 'server-only') return path.join(__dirname, 'operator-server-only-stub.cjs')
  return original.call(this, request, parent, isMain, options)
}
