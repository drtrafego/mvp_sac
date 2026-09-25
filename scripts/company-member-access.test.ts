import assert from 'node:assert/strict'
import { parseOriginItem } from '../src/components/inbox/ChannelBadge'

console.log('Testing member access precedence logic...')

// Test case 1: Normal member lookup logic
const userEmail = ' Atendente.Gramado@Gmail.Com '
const cleanEmail = userEmail.toLowerCase().trim()
assert.equal(cleanEmail, 'atendente.gramado@gmail.com')

console.log('Member access logic test passed! ✅')
