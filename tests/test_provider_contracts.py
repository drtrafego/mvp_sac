import hashlib
import hmac
import io
import json
import unittest
from pathlib import Path

from backend import AppConfig, InMemoryEnvelopeSink, WebhookApplication
from backend.connectors import HttpResponse, MetaConnector, SMTPConnector


FIXTURES = Path(__file__).parent / "fixtures"


class ProviderContractTests(unittest.TestCase):
    def post_meta(self, payload):
        raw = json.dumps(payload, separators=(",", ":")).encode()
        signature = "sha256=" + hmac.new(b"secret", raw, hashlib.sha256).hexdigest()
        sink = InMemoryEnvelopeSink()
        app = WebhookApplication(AppConfig("secret", "verify", "mail"), sink)
        status = []
        env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/webhooks/meta",
               "CONTENT_LENGTH": str(len(raw)), "wsgi.input": io.BytesIO(raw),
               "HTTP_X_HUB_SIGNATURE_256": signature}
        app(env, lambda value, headers: status.append(value))
        self.assertEqual(status[0], "200 OK")
        return sink.envelopes

    def fixture(self, name):
        return json.loads((FIXTURES / name).read_text())

    def test_whatsapp_status_nao_vira_mensagem_do_cliente(self):
        envelopes = self.post_meta(self.fixture("meta_whatsapp_messages.json"))
        self.assertEqual(len(envelopes), 1)
        self.assertEqual(envelopes[0].provider_event_id, "wamid.ABC")
        self.assertEqual(envelopes[0].message["body"], "Olá")

    def test_instagram_ignora_echo_e_read_e_preserva_referral(self):
        envelopes = self.post_meta(self.fixture("meta_instagram_messaging.json"))
        self.assertEqual(len(envelopes), 1)
        self.assertEqual(envelopes[0].provider_event_id, "mid.IG1")
        self.assertEqual(envelopes[0].acquisition["ad_id"], "ad-42")

    def test_instagram_profile_somente_campos_publicos_permitidos(self):
        calls = []
        def transport(method, url, headers, body):
            calls.append((method, url, headers, body))
            return HttpResponse(200, b'{"id":"igsid-user","name":"Ana","username":"ana","profile_pic":"https://img","email":"nao@expor"}')
        profile = MetaConnector("token", graph_url="https://graph.test/v1", transport=transport).instagram_profile("igsid-user")
        self.assertEqual(set(profile), {"id", "name", "username", "profile_pic"})
        self.assertIn("fields=id,name,username,profile_pic", calls[0][1])

    def test_email_canonico_preserva_metadados_sem_acoplar_provedor(self):
        raw = json.dumps({"id":"mail-1","from":{"email":"PESSOA@example.com"},
                          "timestamp":1788880000,"subject":"Oi","textContent":"Corpo",
                          "headers":{"Message-ID":"mail-1"},"attachments":[{"name":"a.pdf"}]}).encode()
        sink = InMemoryEnvelopeSink()
        app = WebhookApplication(AppConfig("s", "v", "mail-secret", "X-Mail-Signature",
                                           "inbox", email_provider="smtp_relay"), sink)
        status=[]
        env={"REQUEST_METHOD":"POST","PATH_INFO":"/webhooks/email","CONTENT_LENGTH":str(len(raw)),
             "wsgi.input":io.BytesIO(raw),"HTTP_X_MAIL_SIGNATURE":"mail-secret"}
        app(env, lambda value, headers: status.append(value))
        self.assertEqual(status[0], "200 OK")
        self.assertEqual(sink.envelopes[0].provider, "smtp_relay")
        self.assertEqual(sink.envelopes[0].identity.external_user_id, "pessoa@example.com")
        self.assertEqual(sink.envelopes[0].message["attachments"][0]["name"], "a.pdf")

    def test_smtp_outbound_tem_contrato_neutro(self):
        instances = []
        class SMTPFake:
            def __init__(self, *args, **kwargs): self.calls=[]; instances.append(self)
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def starttls(self): self.calls.append("tls")
            def login(self, username, password): self.calls.append((username, password))
            def send_message(self, message): self.message=message; return {}
        connector = SMTPConnector("smtp.example", 587, "user", "pass", "bella@example.com",
                                  smtp_factory=SMTPFake)
        result = connector.send(recipient_id="pessoa@example.com", text="Olá", subject="Assunto")
        self.assertFalse(result.dry_run)
        self.assertEqual(instances[0].message["To"], "pessoa@example.com")
        self.assertEqual(instances[0].calls, ["tls", ("user", "pass")])


if __name__ == "__main__":
    unittest.main()
