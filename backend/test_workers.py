import json
import unittest
from datetime import datetime, timedelta, timezone

from backend.connectors import BrevoConnector, HermesClient, HttpResponse, MetaConnector, SendResult
from backend.workers import MemoryOutbox, OutboxItem, OutboxWorker


NOW = datetime(2026, 9, 8, 17, 0, tzinfo=timezone.utc)


class FakeTransport:
    def __init__(self, response): self.response, self.calls = response, []
    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, json.loads(body)))
        return self.response


class ConnectorTests(unittest.TestCase):
    def test_missing_keys_force_dry_run_and_no_network(self):
        def explode(*args): raise AssertionError("não deveria acessar rede")
        self.assertTrue(MetaConnector(None, transport=explode).send(channel="whatsapp", account_id="a", recipient_id="b", text="oi").dry_run)
        self.assertTrue(BrevoConnector(None, None, transport=explode).send(recipient_id="a@b.com", text="oi").dry_run)
        self.assertTrue(HermesClient("http://hermes", None, transport=explode).reply(tenant_id="t", channel="email", conversation_id="c", text="oi")["dry_run"])

    def test_hermes_reuses_session_per_conversation(self):
        decision = json.dumps({"text": "ok", "tags": [], "data": {}, "pipeline_stage": None})
        transport = FakeTransport(HttpResponse(200, json.dumps({"choices": [{"message": {"content": decision}}]}).encode()))
        client = HermesClient("http://hermes", "key", transport=transport)
        client.reply(tenant_id="t", channel="instagram", conversation_id="c", text="um",
                     context={"pipeline_stage": "novo_contato"})
        client.reply(tenant_id="t", channel="instagram", conversation_id="c", text="dois")
        headers = [call[2] for call in transport.calls]
        self.assertEqual(headers[0]["X-Hermes-Session-Id"], headers[1]["X-Hermes-Session-Id"])
        self.assertNotEqual(headers[0]["X-Hermes-Session-Key"], headers[0]["X-Hermes-Session-Id"])
        self.assertEqual(transport.calls[0][1], "http://hermes/v1/chat/completions")
        sent_context = json.loads(transport.calls[0][3]["messages"][1]["content"])["crm_context"]
        self.assertEqual(sent_context["pipeline_stage"], "novo_contato")

    def test_meta_and_brevo_payloads(self):
        meta_t = FakeTransport(HttpResponse(200, b'{"messages":[{"id":"wamid.1"}]}'))
        result = MetaConnector("token", transport=meta_t).send(channel="whatsapp", account_id="phone", recipient_id="55", text="olá")
        self.assertEqual(result.provider_id, "wamid.1")
        self.assertNotIn("token", str(meta_t.calls[0][3]))
        brevo_t = FakeTransport(HttpResponse(201, b'{"messageId":"mail-1"}'))
        result = BrevoConnector("key", "bot@example.com", transport=brevo_t).send(recipient_id="a@example.com", text="oi")
        self.assertEqual(result.provider_id, "mail-1")


class StubConnector:
    def __init__(self, failures=0): self.failures, self.calls = failures, 0
    def send(self, **kwargs):
        self.calls += 1
        if self.calls <= self.failures: raise RuntimeError("temporário")
        return SendResult("provider-1")


class WorkerTests(unittest.TestCase):
    def test_idempotent_enqueue_and_send(self):
        outbox, connector = MemoryOutbox(), StubConnector()
        item = OutboxItem("same", "email", "mailbox", "a@example.com", "oi", available_at=NOW)
        self.assertTrue(outbox.enqueue(item))
        self.assertFalse(outbox.enqueue(OutboxItem("same", "email", "x", "b@example.com", "duplicada")))
        OutboxWorker(outbox, {"email": connector}, clock=lambda: NOW).run_once()
        self.assertEqual((item.status, item.provider_id, connector.calls), ("sent", "provider-1", 1))
        self.assertIsNone(OutboxWorker(outbox, {"email": connector}, clock=lambda: NOW).run_once())

    def test_retry_with_backoff_then_success(self):
        current = [NOW]
        outbox, connector = MemoryOutbox(), StubConnector(failures=1)
        item = OutboxItem("retry", "instagram", "ig", "user", "oi", available_at=NOW)
        outbox.enqueue(item)
        worker = OutboxWorker(outbox, {"instagram": connector}, clock=lambda: current[0])
        worker.run_once()
        self.assertEqual(item.status, "retry")
        self.assertIsNone(worker.run_once())
        current[0] = item.available_at
        worker.run_once()
        self.assertEqual((item.status, item.attempts), ("sent", 2))

    def test_stops_after_max_attempts(self):
        current = [NOW]
        outbox, connector = MemoryOutbox(), StubConnector(failures=9)
        item = OutboxItem("fail", "email", "mail", "a@b.com", "oi", available_at=NOW)
        outbox.enqueue(item)
        worker = OutboxWorker(outbox, {"email": connector}, max_attempts=2, clock=lambda: current[0])
        worker.run_once(); current[0] = item.available_at; worker.run_once()
        self.assertEqual(item.status, "failed")


if __name__ == "__main__": unittest.main()
