import unittest

from multicanal import ChannelIdentity, IdempotencyGuard, PersonIdentityIndex, build_envelope


def envelope(**overrides):
    values = dict(
        channel="whatsapp", provider="meta", provider_event_id="evt-1",
        account_id="conta-a", external_user_id="5511999999999",
        direction="inbound", occurred_at="2026-09-08T17:00:00Z",
        received_at="2026-09-08T17:00:01Z", message={"type": "text", "text": "oi"},
    )
    values.update(overrides)
    return build_envelope(**values)


class EnvelopeTests(unittest.TestCase):
    def test_reentrega_gera_mesmas_chaves(self):
        first, second = envelope(), envelope()
        self.assertEqual(first.event_id, second.event_id)
        self.assertEqual(first.dedupe_key, second.dedupe_key)

    def test_mesmo_evento_em_contas_distintas_nao_colide(self):
        self.assertNotEqual(envelope().dedupe_key, envelope(account_id="conta-b").dedupe_key)

    def test_guard_aceita_so_primeira_entrega(self):
        guard = IdempotencyGuard()
        self.assertTrue(guard.claim(envelope()))
        self.assertFalse(guard.claim(envelope()))

    def test_evento_sem_id_e_rejeitado(self):
        with self.assertRaises(ValueError):
            envelope(provider_event_id=" ")

    def test_data_sem_fuso_e_rejeitada(self):
        with self.assertRaises(ValueError):
            envelope(occurred_at="2026-09-08T17:00:00")

    def test_email_e_canonizado_sem_fundir_canais(self):
        mail = ChannelIdentity("email", "caixa", "Pessoa@Example.COM")
        instagram = ChannelIdentity("instagram", "ig-a", "Pessoa@Example.COM")
        self.assertEqual(mail.external_user_id, "pessoa@example.com")
        self.assertNotEqual(mail.canonical_key, instagram.canonical_key)

    def test_ligacao_cross_channel_exige_acao_explicita(self):
        index = PersonIdentityIndex()
        whatsapp = ChannelIdentity("whatsapp", "waba", "5511999999999", "Ana")
        instagram = ChannelIdentity("instagram", "ig", "ana", "Ana")
        self.assertIsNone(index.resolve(whatsapp))
        self.assertIsNone(index.resolve(instagram))
        index.link("person-1", whatsapp)
        index.link("person-1", instagram)
        self.assertEqual(index.resolve(instagram), "person-1")

    def test_identidade_nao_pode_mudar_de_pessoa(self):
        index = PersonIdentityIndex()
        identity = ChannelIdentity("instagram", "ig", "user-1")
        index.link("person-1", identity)
        with self.assertRaises(ValueError):
            index.link("person-2", identity)


if __name__ == "__main__":
    unittest.main()
