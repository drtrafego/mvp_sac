import unittest

from backend.production_worker import (
    AccountRuntimeConfig, AgentRuntimeConfig, ProductionTenantWorker,
    PostgresRuntimeConfigRepository, ProductionWorkerFactory,
)
from backend.runtime_v2 import AgentScope
from backend.postgres_store import ClaimedDomainEvent, ClaimedOutbound


class Secrets:
    def __init__(self): self.refs = []
    def resolve(self, ref): self.refs.append(ref); return "secret:" + ref


class Repository:
    def __init__(self, config): self.config = config
    def load(self, scope): return self.config


class Store:
    pass


class ProductionWorkerTests(unittest.TestCase):
    def test_repository_le_config_publica_e_refs_de_colunas_separadas(self):
        class Cursor:
            def __init__(self): self.calls, self.step = [], 0
            def execute(self, sql, params=()): self.calls.append((sql, params))
            def fetchone(self):
                return ({"hermes": {"base_url": "https://hermes.example.com"}}, "refs/hermes")
            def fetchall(self):
                return [("wa-row", "phone", "whatsapp", "meta", {"graph_url": "https://graph.facebook.com/v23.0"},
                         "refs/meta", None, None, None, "refs/signature", "refs/verify")]
            def close(self): pass
        class Connection:
            def __init__(self): self.cur = Cursor()
            def cursor(self): return self.cur
            def close(self): pass
        connection = Connection()
        runtime = PostgresRuntimeConfigRepository(lambda: connection).load(
            AgentScope("tenant-a", "gabi", "sac_tenant_a_gabi"))
        self.assertEqual(runtime.hermes_api_key_secret_ref, "refs/hermes")
        self.assertEqual(runtime.accounts[0].access_token_secret_ref, "refs/meta")
        self.assertEqual(runtime.accounts[0].signature_secret_ref, "refs/signature")
        sql = " ".join(call[0] for call in connection.cur.calls)
        self.assertIn("runtime_config,hermes_api_key_secret_ref", sql)
        self.assertIn("access_token_secret_ref", sql)
        self.assertNotIn("api_key_secret_ref'", repr(runtime.accounts[0].config))

    def test_factory_resolve_refs_de_colunas_e_nao_do_json_publico(self):
        config = AgentRuntimeConfig(
            {"base_url": "https://hermes.example.com", "model": "Hermes"}, "refs/hermes",
            (AccountRuntimeConfig("wa-row", "phone-id", "whatsapp", "meta",
                {"graph_url": "https://graph.facebook.com/v23.0"},
                "refs/meta", None, None, None),)
        )
        secrets = Secrets()
        worker = ProductionWorkerFactory(Repository(config), secrets).build(
            AgentScope("tenant-a", "gabi", "sac_tenant_a_gabi"), Store())
        self.assertEqual(secrets.refs, ["refs/hermes", "refs/meta"])
        self.assertEqual(worker.connectors["wa-row"][:2], ("whatsapp", "phone-id"))

    def test_factory_falha_fechado_para_conta_sem_ref(self):
        config = AgentRuntimeConfig({"base_url": "https://hermes.example.com"}, "refs/hermes",
            (AccountRuntimeConfig("wa", "phone", "whatsapp", "meta", {},
                                  None, None, None, None),))
        with self.assertRaises(ValueError):
            ProductionWorkerFactory(Repository(config), Secrets()).build(
                AgentScope("t", "a", "sac_t_a"), Store())

    def test_factory_rejeita_url_com_credencial_ou_sem_tls(self):
        for url in ("http://hermes.internal", "https://user:pass@hermes.example.com",
                    "https://hermes.example.com?access_token=vazou"):
            config = AgentRuntimeConfig({"base_url": url}, "refs/hermes",
                (AccountRuntimeConfig("wa", "phone", "whatsapp", "meta", {},
                                      "refs/meta", None, None, None),))
            with self.assertRaises(ValueError):
                ProductionWorkerFactory(Repository(config), Secrets()).build(
                    AgentScope("t", "a", "sac_t_a"), Store())

    def test_dispatch_traduz_id_interno_para_conta_externa(self):
        item = ClaimedOutbound("job", "lease", "tenant-a", "gabi", "whatsapp",
                               "wa-row", "5511", "ola", "Mensagem", 1)
        class FakeStore:
            def __init__(self): self.finished = []
            def claim_outbound(self): return item
            def finish_outbound(self, value, **result): self.finished.append((value, result))
        class Connector:
            def __init__(self): self.kwargs = None
            def send(self, **kwargs): self.kwargs = kwargs
        store, connector = FakeStore(), Connector()
        worker = ProductionTenantWorker(AgentScope("tenant-a", "gabi", "sac_t_a"),
            store, object(), {"wa-row": ("whatsapp", "phone-provider", connector)})
        self.assertTrue(worker.dispatch_once())
        self.assertEqual(connector.kwargs["account_id"], "phone-provider")
        self.assertEqual(store.finished[0][1], {"success": True})

    def test_worker_detecta_lease_perdido_ao_confirmar(self):
        item = ClaimedOutbound("job", "lease", "tenant-a", "gabi", "email",
                               "mail-row", "lead@example.com", "ola", "Oi", 1)
        class FakeStore:
            def claim_outbound(self): return item
            def finish_outbound(self, value, **result): return False
        class Connector:
            def send(self, **kwargs): pass
        worker = ProductionTenantWorker(AgentScope("tenant-a", "gabi", "sac_t_a"),
            FakeStore(), object(), {"mail-row": ("email", "mailbox", Connector())})
        with self.assertRaisesRegex(RuntimeError, "lease outbound perdido"):
            worker.dispatch_once()

    def test_publica_evento_interno_e_confirma_lease(self):
        item = ClaimedDomainEvent("job", "lease", "tenant-a", "gabi",
            "contact.tagged", "contact-1", {"tag": "vip"}, 1)
        class FakeStore:
            def __init__(self): self.finished = []
            def claim_domain_event(self): return item
            def finish_domain_event(self, value, **result):
                self.finished.append((value, result)); return True
        class Sink:
            def __init__(self): self.events = []
            def publish(self, **event): self.events.append(event)
        store, sink = FakeStore(), Sink()
        worker = ProductionTenantWorker(AgentScope("tenant-a", "gabi", "sac_t_a"),
            store, object(), {}, sink)
        self.assertTrue(worker.publish_domain_once())
        self.assertEqual(sink.events[0]["topic"], "contact.tagged")
        self.assertEqual(store.finished[0][1], {"success": True})

    def test_falha_do_sink_reagenda_evento_sem_tocar_filas_reservadas(self):
        item = ClaimedDomainEvent("job", "lease", "tenant-a", "gabi",
            "pipeline.advanced", "contact-1", {}, 1)
        class FakeStore:
            def __init__(self): self.finished = []
            def claim_domain_event(self): return item
            def finish_domain_event(self, value, **result):
                self.finished.append(result); return True
        class Sink:
            def publish(self, **event): raise RuntimeError("indisponivel")
        store = FakeStore()
        worker = ProductionTenantWorker(AgentScope("tenant-a", "gabi", "sac_t_a"),
            store, object(), {}, Sink())
        with self.assertRaisesRegex(RuntimeError, "indisponivel"):
            worker.publish_domain_once()
        self.assertFalse(store.finished[0]["success"])

    def test_smtp_rejeita_booleano_textual_e_porta_fora_do_limite(self):
        base = {"host": "smtp.example.com", "sender_email": "sac@example.com"}
        for account_config in ({**base, "starttls": "false"},
                               {**base, "port": 70000}, {**base, "port": True}):
            config = AgentRuntimeConfig({"base_url": "https://hermes.example.com"}, "refs/hermes",
                (AccountRuntimeConfig("mail", "mail", "email", "smtp", account_config,
                                      None, None, None, "refs/smtp"),))
            with self.subTest(account_config=account_config):
                with self.assertRaises(ValueError):
                    ProductionWorkerFactory(Repository(config), Secrets()).build(
                        AgentScope("t", "a", "sac_t_a"), Store())


if __name__ == "__main__": unittest.main()
