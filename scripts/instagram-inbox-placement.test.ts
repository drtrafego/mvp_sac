import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  includesInstagramInGeneral,
  isInstagramInboxPlacement,
} from '../src/lib/instagram-inbox-placement'

test('preferência preserva o comportamento atual quando ausente e só exclusividade remove o Direct da caixa geral', () => {
  assert.equal(includesInstagramInGeneral(undefined), true)
  assert.equal(includesInstagramInGeneral(null), true)
  assert.equal(includesInstagramInGeneral('general'), true)
  assert.equal(includesInstagramInGeneral('exclusive'), false)
})

test('somente os dois valores persistíveis são aceitos pela API', () => {
  assert.equal(isInstagramInboxPlacement('general'), true)
  assert.equal(isInstagramInboxPlacement('exclusive'), true)
  assert.equal(isInstagramInboxPlacement('all'), false)
  assert.equal(isInstagramInboxPlacement(''), false)
  assert.equal(isInstagramInboxPlacement(null), false)
})
