import hashlib
import hmac
import io
import json
import tempfile
import unittest
from pathlib import Path

from backend import AppConfig, BackendService, SQLiteStore, WebhookApplication
from backend.connectors import HermesClient, SendResult


class MockConnector:
    def __init__(self): self.calls = []
    def send(self, **kwargs):
        self.calls.append(kwargs)
        return SendResult("provider-1")


class FlakyHermes:
    def __init__(self): self.calls = 0
    def reply(self, **kwargs):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("temporario")
        return {"text": "resposta"}


class StructuredHermes:
    def __init__(self): self.context = None
    def reply(self, **kwargs):
        self.context = kwargs["context"]
        return {"text": "Vamos agendar.", "tags": ["Lead Quente"],
                "data": {"email": "Pessoa@Example.com", "campo_ignorado": "x"},
                "pipeline_stage": "agendado", "subject": None}


class BackendE2ETests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SQLiteStore(Path(self.tmp.name) / "e2e.sqlite3")
        self.connector = MockConnector()
        # Sem chave: Hermes obrigatoriamente fica dry-run, sem rede.
        hermes = HermesClient("http://nao-acessar", None)
        self.service = BackendService("bella", self.store, hermes, {"whatsapp": self.connector})
        config = AppConfig("meta-secret", "verify", "brevo-secret")
        self.app = WebhookApplication(config, self.service)

    def tearDown(self): self.tmp.cleanup()

    def call(self, body):
        signature = hmac.new(b"meta-secret", body, hashlib.sha256).hexdigest()
        status = []
        env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/webhooks/meta", "QUERY_STRING": "",
               "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body),
               "HTTP_X_HUB_SIGNATURE_256": "sha256=" + signature}
        response = b"".join(self.app(env, lambda value, _: status.append(value)))
        return int(status[0].split()[0]), response

    def payload(self):
        return json.dumps({"entry": [{"id": "page", "changes": [{"value": {
            "metadata": {"phone_number_id": "phone"}, "contacts": [{"wa_id": "5511"}],
            "messages": [{"id": "wamid.1", "from": "5511", "timestamp": "1788880000",
                          "type": "text", "text": {"body": "oi"}}]}}]}]}).encode()

    def test_assinado_persiste_chama_hermes_enfileira_e_envia(self):
        self.assertEqual(self.call(self.payload())[0], 200)
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM messages")["n"], 1)
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM outbox WHERE topic='outbound.send'")["n"], 0)
        self.assertTrue(self.service.process_inbound_once())
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM outbox WHERE topic='outbound.send'")["n"], 1)
        self.assertTrue(self.service.dispatch_once())
        self.assertEqual(self.connector.calls[0]["text"], "oi")
        self.assertEqual(self.connector.calls[0]["recipient_id"], "5511")
        self.assertIsNotNone(self.store.fetchone("SELECT published_at FROM outbox WHERE topic='outbound.send'")["published_at"])

    def test_replay_nao_duplica_nem_reenvia(self):
        self.call(self.payload())
        self.call(self.payload())
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM messages")["n"], 1)
        self.assertTrue(self.service.process_inbound_once())
        self.assertFalse(self.service.process_inbound_once())
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM outbox WHERE topic='outbound.send'")["n"], 1)
        self.assertTrue(self.service.dispatch_once())
        self.assertFalse(self.service.dispatch_once())
        self.assertEqual(len(self.connector.calls), 1)

    def test_hermes_falha_e_inbound_pode_ser_retentado_sem_saida_duplicada(self):
        flaky = FlakyHermes()
        self.service.hermes = flaky
        self.call(self.payload())
        with self.assertRaises(RuntimeError):
            self.service.process_inbound_once()
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM outbox WHERE topic='outbound.send'")["n"], 0)
        self.assertTrue(self.service.process_inbound_once())
        self.assertEqual(flaky.calls, 2)
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM outbox WHERE topic='outbound.send'")["n"], 1)

    def test_claim_abandonado_por_crash_expira_e_pode_ser_recuperado(self):
        self.call(self.payload())
        claimed = self.store.claim_inbound("bella")
        self.assertIsNotNone(claimed)
        self.assertIsNone(self.store.claim_inbound("bella"))
        with self.store._connection() as conn:
            conn.execute("UPDATE outbox SET claimed_at=datetime('now','-6 minutes') WHERE id=?",
                         (claimed.outbox_id,))
        recovered = self.store.claim_inbound("bella")
        self.assertEqual(recovered.outbox_id, claimed.outbox_id)
        self.assertEqual(self.store.fetchone("SELECT attempts FROM outbox WHERE id=?",
                                             (claimed.outbox_id,))["attempts"], 2)

    def test_contexto_rico_e_acoes_crm_sao_atomicas_auditadas_e_idempotentes(self):
        hermes = StructuredHermes()
        self.service.hermes = hermes
        self.call(self.payload())
        self.assertTrue(self.service.process_inbound_once())
        self.assertEqual(hermes.context["pipeline_stage"], "novo_contato")
        self.assertEqual(hermes.context["recent_messages"][-1]["text"], "oi")
        self.assertEqual(self.store.fetchone("SELECT pipeline_stage FROM contacts")["pipeline_stage"], "agendado")
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM tags WHERE name='lead quente'")["n"], 1)
        self.assertEqual(self.store.fetchone("SELECT normalized_value FROM contact_points WHERE kind='email'")["normalized_value"],
                         "pessoa@example.com")
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM contact_profile_fields WHERE field_name='campo_ignorado'")["n"], 0)
        log = self.store.fetchone("SELECT decision_json,applied_json FROM crm_action_log")
        self.assertIn("Lead Quente", log["decision_json"])
        self.assertIn("agendado", log["applied_json"])
        self.assertFalse(self.store.apply_hermes_decision(
            tenant_id="bella", message_id=self.store.fetchone("SELECT id FROM messages")["id"],
            channel="whatsapp", account_id="phone", recipient_id="5511",
            decision={"text": "duplicada", "tags": [], "data": {}}))
        self.assertEqual(self.store.fetchone("SELECT count(*) n FROM outbox WHERE topic='outbound.send'")["n"], 1)


if __name__ == "__main__": unittest.main()
