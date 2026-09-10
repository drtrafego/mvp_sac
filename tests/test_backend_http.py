import hashlib
import hmac
import io
import json
import unittest

from backend import AppConfig, InMemoryEnvelopeSink, WebhookApplication


class FailingSink:
    def persist(self, envelopes):
        raise RuntimeError("database offline")


class BackendHttpTests(unittest.TestCase):
    def setUp(self):
        self.config = AppConfig("meta-secret", "verify-token", "brevo-secret", email_account_id="inbox-1")
        self.sink = InMemoryEnvelopeSink()
        self.app = WebhookApplication(self.config, self.sink)

    def call(self, method, path, body=b"", query="", headers=None, app=None):
        status = []
        environ = {"REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": query,
                   "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body)}
        environ.update(headers or {})
        response = b"".join((app or self.app)(environ, lambda value, _: status.append(value)))
        return int(status[0].split()[0]), response

    def meta_header(self, body):
        digest = hmac.new(b"meta-secret", body, hashlib.sha256).hexdigest()
        return {"HTTP_X_HUB_SIGNATURE_256": "sha256=" + digest}

    def test_health_nao_expoe_segredos(self):
        status, body = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertNotIn(b"secret", body)

    def test_meta_challenge(self):
        query = "hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=123"
        self.assertEqual(self.call("GET", "/webhooks/meta", query=query), (200, b"123"))
        self.assertEqual(self.call("GET", "/webhooks/meta", query=query.replace("verify-token", "bad"))[0], 403)

    def test_meta_rejeita_antes_de_persistir(self):
        body = b'{"entry":[]}'
        self.assertEqual(self.call("POST", "/webhooks/meta", body)[0], 401)
        self.assertEqual(self.sink.envelopes, [])

    def test_whatsapp_e_instagram_sao_normalizados(self):
        payload = {"entry": [{"id": "page-1", "changes": [{"value": {
            "metadata": {"phone_number_id": "phone-1"}, "contacts": [{"wa_id": "5511", "profile": {"name": "Ana"}}],
            "messages": [{"id": "wamid.1", "from": "5511", "timestamp": "1788880000", "type": "text", "text": {"body": "oi"}}]
        }}], "messaging": [{"sender": {"id": "ig-user"}, "recipient": {"id": "ig-account"},
                            "timestamp": 1788880000000, "message": {"mid": "mid.1", "text": "olá"}}]}]}
        body = json.dumps(payload).encode()
        self.assertEqual(self.call("POST", "/webhooks/meta", body, headers=self.meta_header(body))[0], 200)
        self.assertEqual([e.channel for e in self.sink.envelopes], ["whatsapp", "instagram"])
        self.assertEqual(self.sink.envelopes[0].identity.display_name, "Ana")

    def test_brevo_valida_segredo_e_persiste(self):
        body = json.dumps({"event": "inbound", "message-id": "mail-1", "email": "Pessoa@Example.com",
                           "date": "2026-09-08T17:00:00Z", "text": "oi"}).encode()
        headers = {"HTTP_X_BREVO_SIGNATURE": "brevo-secret"}
        self.assertEqual(self.call("POST", "/webhooks/brevo", body, headers=headers)[0], 200)

    def test_webhook_email_canonico_preserva_provedor_configurado(self):
        config = AppConfig("meta-secret", "verify-token", "mail-secret",
                           brevo_signature_header="X-Email-Signature",
                           email_account_id="caixa-bella", email_provider="imap_smtp")
        sink = InMemoryEnvelopeSink()
        app = WebhookApplication(config, sink)
        body = json.dumps({"event": "inbound", "message-id": "mail-generic-1",
                           "from": {"email": "Pessoa@Example.com"}, "text": "Oi"}).encode()
        status, _ = self.call("POST", "/webhooks/email", body,
                              headers={"HTTP_X_EMAIL_SIGNATURE": "mail-secret"}, app=app)
        self.assertEqual(status, 200)
        self.assertEqual(sink.envelopes[0].provider, "imap_smtp")
        self.assertEqual(sink.envelopes[0].identity.external_user_id, "pessoa@example.com")

    def test_nao_da_ack_quando_persistencia_falha(self):
        body = json.dumps({"event": "inbound", "message-id": "mail-1", "email": "a@b.com", "timestamp": 1788880000}).encode()
        app = WebhookApplication(self.config, FailingSink())
        status, _ = self.call("POST", "/webhooks/brevo", body, headers={"HTTP_X_BREVO_SIGNATURE": "brevo-secret"}, app=app)
        self.assertEqual(status, 503)

    def test_reentrega_e_idempotente_no_sink_de_teste(self):
        body = json.dumps({"event": "inbound", "message-id": "mail-1", "email": "a@b.com", "timestamp": 1788880000}).encode()
        headers = {"HTTP_X_BREVO_SIGNATURE": "brevo-secret"}
        self.call("POST", "/webhooks/brevo", body, headers=headers)
        self.call("POST", "/webhooks/brevo", body, headers=headers)
        self.assertEqual(len(self.sink.envelopes), 1)


if __name__ == "__main__":
    unittest.main()
