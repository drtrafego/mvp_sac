import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { audioPlayerUrl, extractAudioMedia, extractAudioMediaId } from '../src/lib/whatsapp/audio-media'

mock.module('@/lib/db', { namedExports: { db: {} } })

test('extrai somente ids de mídia de áudio Meta válidos', () => {
  assert.equal(extractAudioMedia({ id: '12345' }), '12345')
  assert.equal(extractAudioMedia({ id: '9'.repeat(60) }), '9'.repeat(60))
  assert.equal(extractAudioMedia({ id: '1234' }), null)
  assert.equal(extractAudioMedia({ id: '12abc34' }), null)
  assert.equal(extractAudioMedia({ id: 123456 }), null)
  assert.equal(extractAudioMedia(null), null)
  assert.equal(extractAudioMediaId('wa-media:12345'), '12345')
  assert.equal(extractAudioMediaId('wa-media:invalid'), null)
})

test('monta URL do player somente para mensagem e marcador Meta válidos', () => {
  assert.equal(audioPlayerUrl(42, 'wa-media:12345'), '/api/inbox/messages/42/audio')
  assert.equal(audioPlayerUrl(0, 'wa-media:12345'), null)
  assert.equal(audioPlayerUrl(-1, 'wa-media:12345'), null)
  assert.equal(audioPlayerUrl(42.5, 'wa-media:12345'), null)
  assert.equal(audioPlayerUrl(42, 'wa-media:invalido'), null)
  assert.equal(audioPlayerUrl(42, 'https://example.test/audio.ogg'), null)
})

async function main() {
  const { buildBridgeRequestBody } = await import('../src/lib/ai/ai-bridge')

  test('monta o contrato de áudio da ponte sem acrescentar campos em texto normal', () => {
    const base = {
      bot: 'nina' as const,
      mensagem: '[áudio recebido]',
      historico: [],
      audioMediaId: '1234567890',
      phoneNumberId: '10987654321',
    }
    assert.deepEqual(buildBridgeRequestBody(base), {
      bot: 'nina',
      mensagem: '[áudio recebido]',
      historico: [],
      nome_contato: undefined,
      wa_id: undefined,
      agendamento_atual: null,
      audio_media_id: '1234567890',
      phone_number_id: '10987654321',
    })

    const plain = buildBridgeRequestBody({ bot: 'nina', mensagem: 'Olá', historico: [] })
    assert.equal('audio_media_id' in plain, false)
    assert.equal('phone_number_id' in plain, false)
  })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
