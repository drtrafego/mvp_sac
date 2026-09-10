from __future__ import annotations

import hashlib
import hmac
import io
import json
import unittest
from collections import deque

from backend.multitenant_service import BindingServiceFactory, MultiTenantBackend
from backend.multitenant_app import MultiTenantWebhookApplication
from backend.postgres_store import PostgresStore
from backend.service import AccountConnectorResolver, BackendService, ConnectorTarget
from backend.tenant_registry import MappingSecretResolver, TenantBinding
from multicanal import build_envelope


class Cursor:
    def __init__(self, results):
        self.results = deque(results)
        self.executions = []
        self.rowcount = 1

    def execute(self, sql, params=()):
        self.executions.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self.results.popleft() if self.results else None

    def fetchall(self):
        value = self.results.popleft() if self.results else []
        return value

    def close(self): pass


class Connection:
    def __init__(self, results):
        self.cursor_value = Cursor(results)
        self.committed = self.rolled_back = False

    def cursor(self): return self.cursor_value
    def commit(self): self.committed = True
    def rollback(self): self.rolled_back = True
    def close(self): pass


class NoopHermes:
    def reply(self, **kwargs): return {"text": "ok"}


class RecordingBoundStore:
    tenant_bound = True

    def __init__(self, tenant_id="tenant-a", agent_id="gabi"):
        self.tenant_id, self.agent_id = tenant_id, agent_id
        self.finished = []
        self.inbound = None
        self.outbound = None

    def ingest(self, envelope): pass
    def claim_inbound(self): return self.inbound
    def claim_outbound(self): return self.outbound
    def hermes_context(self, message_id): return {}
    def apply_hermes_decision(self, **kwargs): return True
    def finish_inbound(self, item, **kwargs): self.finished.append((item, kwargs))
    def finish_outbound(self, item, **kwargs): self.finished.append((item, kwargs))


class MultiTenantServiceTests(unittest.TestCase):
    def setUp(self):
        self.binding = TenantBinding("endpoint_123456789", "tenant-a", "gabi",
                                     "whatsapp", "meta", "account-internal",
                                     "account-external", "secret/ref",
                                     schema_name="sac_gabi")

    @staticmethod
    def envelope(account="account-internal"):
        return build_envelope(
            channel="whatsapp", provider="meta", provider_event_id="provider-1",
            account_id=account, external_user_id="5511999999999", direction="inbound",
            occurred_at="2026-09-09T10:00:00Z", received_at="2026-09-09T10:00:01Z",
            message={"text": "oi"})

    def test_binding_factory_persists_through_real_postgres_store_sql(self):
        connection = Connection([{"id": "event"}, None, None,
                                 {"id": "tag_channel"}, {"tag_id": "tag_channel"}])
        stores = []

        def store_factory(binding):
            store = PostgresStore(lambda: connection, tenant_id=binding.tenant_id,
                                  agent_id=binding.agent_id, schema="sac_gabi",
                                  close_connections=False)
            stores.append(store)
            return store

        factory = BindingServiceFactory(store_factory, lambda _: NoopHermes(), lambda _: {})
        backend = MultiTenantBackend(factory)
        backend.persist_for_tenant(self.binding, (self.envelope(),))
        self.assertTrue(connection.committed)
        sql = "\n".join(statement for statement, _ in connection.cursor_value.executions)
        self.assertIn('"sac_gabi"."sac_messages"', sql)
        # Scope is always supplied by the constructed store, not the envelope.
        scoped = [params for _, params in connection.cursor_value.executions
                  if len(params) >= 3 and params[1:3] == ("tenant-a", "gabi")]
        self.assertTrue(scoped)
        self.assertIs(factory.service_for(self.binding), factory.service_for(self.binding))

    def test_signed_webhook_e2e_normalizes_external_account_before_postgres(self):
        connection = Connection([{"id": "event"}, None, None,
                                 {"id": "tag_channel"}, {"tag_id": "tag_channel"}])
        factory = BindingServiceFactory(
            lambda binding: PostgresStore(
                lambda: connection, tenant_id=binding.tenant_id, agent_id=binding.agent_id,
                schema=binding.schema_name, close_connections=False),
            lambda _: NoopHermes(), lambda _: {})
        backend = MultiTenantBackend(factory)

        class Registry:
            def resolve(inner_self, endpoint):
                return self.binding if endpoint == self.binding.public_endpoint_id else None

        app = MultiTenantWebhookApplication(
            Registry(), MappingSecretResolver({"secret/ref": "signing-secret"}), backend)
        payload = {"entry": [{"id": "account-external", "changes": [{"value": {
            "metadata": {"phone_number_id": "account-external"},
            "messages": [{"id": "wamid.1", "from": "5511999999999",
                          "timestamp": "1788880000", "type": "text",
                          "text": {"body": "oi"}}]}}]}]}
        body = json.dumps(payload).encode()
        signature = hmac.new(b"signing-secret", body, hashlib.sha256).hexdigest()
        environ = {"REQUEST_METHOD": "POST",
                   "PATH_INFO": "/webhooks/v2/" + self.binding.public_endpoint_id,
                   "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body),
                   "HTTP_X_HUB_SIGNATURE_256": "sha256=" + signature}
        status = []
        response = b"".join(app(environ, lambda value, _: status.append(value)))
        self.assertEqual((status[0], response), ("200 OK", b'{"status":"persisted"}'))
        identity_insert = next(params for sql, params in connection.cursor_value.executions
                               if "INSERT INTO" in sql and "sac_identities" in sql)
        self.assertIn("account-internal", identity_insert)
        self.assertNotIn("account-external", identity_insert)

    def test_sink_fails_closed_on_binding_mismatch(self):
        store = RecordingBoundStore()
        backend = MultiTenantBackend(BindingServiceFactory(
            lambda _: store, lambda _: NoopHermes(), lambda _: {}))
        with self.assertRaises(ValueError):
            backend.persist_for_tenant(self.binding, (self.envelope("foreign-account"),))

    def test_service_passes_whole_claim_to_finish_for_lease_token(self):
        from backend.postgres_store import ClaimedInbound
        store = RecordingBoundStore()
        item = ClaimedInbound("ob", "lease-token", "tenant-a", "gabi", "msg", "thread",
                              "whatsapp", "account-internal", "5511", "oi", 1)
        store.inbound = item
        service = BackendService.from_bound_store(store, NoopHermes(), {})
        self.assertTrue(service.process_inbound_once())
        self.assertIs(store.finished[0][0], item)
        self.assertEqual(store.finished[0][1], {"success": True})

    def test_dispatch_translates_internal_account_to_provider_account(self):
        from backend.postgres_store import ClaimedOutbound
        store = RecordingBoundStore()
        store.outbound = ClaimedOutbound(
            "ob", "lease", "tenant-a", "gabi", "whatsapp", "account-internal",
            "5511", "ola", "Mensagem", 1)

        class Connector:
            def __init__(self): self.calls = []
            def send(self, **kwargs): self.calls.append(kwargs)

        connector = Connector()
        resolver = AccountConnectorResolver({
            ("whatsapp", "account-internal"):
                ConnectorTarget(connector, "phone-number-provider")})
        service = BackendService.from_bound_store(store, NoopHermes(), resolver)
        self.assertTrue(service.dispatch_once())
        self.assertEqual(connector.calls[0]["account_id"], "phone-number-provider")
        self.assertNotEqual(connector.calls[0]["account_id"], store.outbound.account_id)
        self.assertIs(store.finished[0][0], store.outbound)

    def test_factory_rejects_cross_tenant_store(self):
        factory = BindingServiceFactory(lambda _: RecordingBoundStore("tenant-b", "gabi"),
                                        lambda _: NoopHermes(), lambda _: {})
        with self.assertRaises(ValueError):
            factory.service_for(self.binding)

    def test_cached_service_rejects_schema_change(self):
        store = RecordingBoundStore()
        factory = BindingServiceFactory(lambda _: store, lambda _: NoopHermes(), lambda _: {})
        factory.service_for(self.binding)
        from dataclasses import replace
        with self.assertRaises(ValueError):
            factory.service_for(replace(self.binding, schema_name="sac_evil"))


if __name__ == "__main__":
    unittest.main()
