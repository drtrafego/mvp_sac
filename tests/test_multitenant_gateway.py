import hashlib
import hmac
import io
import json
import unittest

from backend.multitenant_app import MultiTenantWebhookApplication
from backend.tenant_registry import MappingSecretResolver, TenantBinding


class Registry:
    def __init__(self, bindings): self.bindings = bindings
    def resolve(self, endpoint): return self.bindings.get(endpoint)


class Sink:
    def __init__(self): self.batches = []
    def persist_for_tenant(self, binding, envelopes): self.batches.append((binding, envelopes))


class MultiTenantGatewayTests(unittest.TestCase):
    endpoint = "opaque_endpoint_123456"

    def setUp(self):
        self.binding = TenantBinding(self.endpoint, "tenant-a", "gabi", "whatsapp", "meta",
                                     "account-row-a", "phone-a", "sig/a", "verify/a",
                                     schema_name="sac_tenant_a_gabi")
        self.registry = Registry({self.endpoint: self.binding})
        self.secrets = MappingSecretResolver({"sig/a": "secret-a", "verify/a": "token-a"})
        self.sink = Sink()
        self.app = MultiTenantWebhookApplication(self.registry, self.secrets, self.sink)

    def call(self, body, *, endpoint=None, signature_secret="secret-a"):
        endpoint = endpoint or self.endpoint
        signature = hmac.new(signature_secret.encode(), body, hashlib.sha256).hexdigest()
        env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/webhooks/v2/" + endpoint,
               "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body),
               "HTTP_X_HUB_SIGNATURE_256": "sha256=" + signature}
        status = []
        response = b"".join(self.app(env, lambda value, _: status.append(value)))
        return int(status[0].split()[0]), response

    @staticmethod
    def payload(account="phone-a", **extra):
        value = {"metadata": {"phone_number_id": account},
                 "messages": [{"id": "m1", "from": "5511", "timestamp": "1788880000",
                               "type": "text", "text": {"body": "oi"}}]}
        result = {"entry": [{"id": account, "changes": [{"value": value}]}]}
        result.update(extra)
        return json.dumps(result).encode()

    def test_resolve_tenant_somente_pelo_endpoint_e_ignora_payload(self):
        status, _ = self.call(self.payload(tenant_id="tenant-b", agent_id="outro"))
        self.assertEqual(status, 200)
        self.assertEqual(self.sink.batches[0][0].tenant_id, "tenant-a")
        envelope = self.sink.batches[0][1][0]
        self.assertEqual(envelope.account_id, "account-row-a")
        self.assertEqual(envelope.identity.account_id, "account-row-a")

    def test_endpoint_desconhecido_nao_persiste(self):
        self.assertEqual(self.call(self.payload(), endpoint="unknown_endpoint_1234")[0], 404)
        self.assertEqual(self.sink.batches, [])

    def test_rejeita_conta_cruzada_mesmo_com_assinatura_valida(self):
        self.assertEqual(self.call(self.payload("phone-b"))[0], 403)
        self.assertEqual(self.sink.batches, [])

    def test_rejeita_assinatura_de_outro_tenant(self):
        self.assertEqual(self.call(self.payload(), signature_secret="secret-b")[0], 401)
        self.assertEqual(self.sink.batches, [])

    def test_falha_fechado_quando_segredo_nao_existe(self):
        app = MultiTenantWebhookApplication(self.registry, MappingSecretResolver({}), self.sink)
        original = self.app
        self.app = app
        try:
            self.assertEqual(self.call(self.payload())[0], 503)
        finally:
            self.app = original
        self.assertEqual(self.sink.batches, [])

    def test_rejeita_canal_cruzado_no_mesmo_payload_meta(self):
        payload = json.loads(self.payload())
        payload["entry"][0]["messaging"] = [{"sender": {"id": "u"},
            "recipient": {"id": "ig-a"}, "timestamp": 1788880000000,
            "message": {"mid": "ig1", "text": "oi"}}]
        self.assertEqual(self.call(json.dumps(payload).encode())[0], 403)
        self.assertEqual(self.sink.batches, [])

    def test_challenge_usa_token_da_vinculacao(self):
        env = {"REQUEST_METHOD": "GET", "PATH_INFO": "/webhooks/v2/" + self.endpoint,
               "QUERY_STRING": "hub.mode=subscribe&hub.verify_token=token-a&hub.challenge=42"}
        status = []
        body = b"".join(self.app(env, lambda value, _: status.append(value)))
        self.assertEqual((int(status[0].split()[0]), body), (200, b"42"))

    def test_email_tambem_normaliza_conta_externa_para_interna(self):
        binding = TenantBinding(self.endpoint, "tenant-a", "isabella", "email", "brevo",
                                "mail-row", "inbox@example.com", "sig/mail",
                                signature_header="X-Mail-Signature", schema_name="sac_t_a")
        sink = Sink()
        app = MultiTenantWebhookApplication(Registry({self.endpoint: binding}),
            MappingSecretResolver({"sig/mail": "mail-secret"}), sink)
        body = json.dumps({"event": "inbound", "message-id": "mail-1",
                           "email": "lead@example.com", "timestamp": 1788880000}).encode()
        env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/webhooks/v2/" + self.endpoint,
               "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body),
               "HTTP_X_MAIL_SIGNATURE": "mail-secret"}
        status = []
        app(env, lambda value, _: status.append(value))
        self.assertEqual(int(status[0].split()[0]), 200)
        self.assertEqual(sink.batches[0][1][0].account_id, "mail-row")


if __name__ == "__main__":
    unittest.main()
