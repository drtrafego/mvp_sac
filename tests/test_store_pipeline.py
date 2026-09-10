import tempfile
import threading
import unittest
from pathlib import Path

from backend import SQLiteStore
from multicanal import ChannelIdentity, build_envelope


def envelope(event="evt-1", channel="whatsapp", account="waba", user="5511", acquisition=None):
    return build_envelope(
        channel=channel, provider="meta", provider_event_id=event, account_id=account,
        external_user_id=user, direction="inbound", occurred_at="2026-09-08T17:00:00Z",
        received_at="2026-09-08T17:00:01Z", message={"type": "text", "text": "oi"},
        acquisition=acquisition,
    )


class StorePipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SQLiteStore(Path(self.tmp.name) / "homolog.sqlite3")

    def tearDown(self):
        self.tmp.cleanup()

    def test_ingest_persiste_grafo_e_outbox(self):
        result = self.store.ingest("bella", envelope(acquisition={"campaign": "x"}))
        self.assertTrue(result.accepted)
        self.assertIsNotNone(self.store.fetchone("SELECT 1 FROM contacts WHERE id=?", (result.contact_id,)))
        self.assertIsNotNone(self.store.fetchone("SELECT 1 FROM acquisition_sources WHERE message_id=?", (result.message_id,)))
        self.assertIsNotNone(self.store.fetchone("SELECT 1 FROM outbox WHERE aggregate_id=?", (result.conversation_id,)))

    def test_dedupe_atomico_em_threads(self):
        barrier = threading.Barrier(8)
        accepted = []
        def run():
            barrier.wait()
            accepted.append(self.store.ingest("bella", envelope()).accepted)
        threads = [threading.Thread(target=run) for _ in range(8)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(accepted.count(True), 1)
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM messages")["n"], 1)

    def test_mesma_identidade_reutiliza_contato_e_conversa(self):
        first = self.store.ingest("bella", envelope("evt-1"))
        second = self.store.ingest("bella", envelope("evt-2"))
        self.assertEqual(first.contact_id, second.contact_id)
        self.assertEqual(first.conversation_id, second.conversation_id)

    def test_nao_funde_mesmo_nome_entre_canais(self):
        first = self.store.ingest("bella", envelope("wa", user="ana"))
        second = self.store.ingest("bella", envelope("ig", "instagram", "ig", "ana"))
        self.assertNotEqual(first.contact_id, second.contact_id)

    def test_vinculo_cross_channel_e_explicito_e_nao_move_identidade(self):
        first = self.store.ingest("bella", envelope("wa"))
        instagram = ChannelIdentity("instagram", "ig", "ana")
        identity_id = self.store.link_identity("bella", first.contact_id, instagram)
        self.assertTrue(identity_id)
        other = self.store.ingest("bella", envelope("other", user="outro"))
        with self.assertRaises(ValueError):
            self.store.link_identity("bella", other.contact_id, instagram)

    def test_pipeline_avanca_sem_regredir(self):
        contact = self.store.ingest("bella", envelope()).contact_id
        self.assertEqual(self.store.advance_pipeline("bella", contact, "qualificado"), "qualificado")
        self.assertEqual(self.store.advance_pipeline("bella", contact, "em_atendimento"), "qualificado")
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM pipeline_history")["n"], 1)


if __name__ == "__main__":
    unittest.main()
