import io
import json
import os
import tempfile
import sys
import unittest
from collections import deque
from pathlib import Path

from backend import runtime_v2
from backend.panel_api import PanelAgent
from backend.runtime_v2 import (
    AgentScope, MultiTenantWorkerScheduler, PostgresStoreFactory, ReadinessProbe,
    ProductionReadiness, RuntimeApplication, RuntimeSettings, TenantPostgresSink,
    build_panel,
)
from backend.secret_resolver import DirectorySecretResolver
from backend.tenant_registry import TenantBinding
from backend.tenant_registry import PostgresTenantRegistry
from multicanal import build_envelope


class Cursor:
    def __init__(self, rows=()): self.rows, self.executions = deque(rows), []
    def execute(self, sql, params=()): self.executions.append((sql, params))
    def fetchone(self): return self.rows.popleft() if self.rows else None
    def fetchall(self): return self.rows.popleft() if self.rows else []
    def close(self): pass


class Connection:
    def __init__(self, rows=()): self.cur = Cursor(rows); self.closed = False
    def cursor(self): return self.cur
    def close(self): self.closed = True


class Gateway:
    def __call__(self, environ, start_response):
        start_response("418 Teapot", [])
        return [b"gateway"]


class Probe:
    def __init__(self, ready): self.value = ready
    def ready(self): return self.value


class RuntimeV2Tests(unittest.TestCase):
    def call(self, app, path):
        status = []
        body = b"".join(app({"PATH_INFO": path}, lambda value, _: status.append(value)))
        return int(status[0].split()[0]), json.loads(body)

    def test_readiness_e_real_e_liveness_nao_depende_do_banco(self):
        app = RuntimeApplication(Gateway(), Probe(False))
        self.assertEqual(self.call(app, "/livez")[0], 200)
        self.assertEqual(self.call(app, "/readyz"), (503, {"status": "unavailable"}))
        app.readiness.value = True
        self.assertEqual(self.call(app, "/readyz")[0], 200)

    def test_probe_confere_tabelas_e_fecha_conexao(self):
        connection = Connection([(True,)])
        self.assertTrue(ReadinessProbe(lambda: connection).ready())
        self.assertIn("to_regclass", connection.cur.executions[0][0])
        self.assertTrue(connection.closed)

    def test_settings_nao_aceita_runtime_sem_postgres_ou_cofre(self):
        with self.assertRaises(ValueError): RuntimeSettings.from_env({})
        settings = RuntimeSettings.from_env({"DATABASE_URL": "postgresql://db/sac",
                                             "SECRET_DIR": "/run/secrets"})
        self.assertEqual(settings.port, 8080)
        self.assertEqual(settings.readiness_mode, "production")
        database_only = RuntimeSettings.from_env({"DATABASE_URL": "postgresql://db/sac",
                                                  "SECRET_DIR": "/run/secrets",
                                                  "READINESS_MODE": "database"})
        self.assertEqual(database_only.readiness_mode, "database")
        with self.assertRaises(ValueError):
            RuntimeSettings.from_env({"DATABASE_URL": "postgresql://db/sac",
                                      "SECRET_DIR": "/run/secrets",
                                      "READINESS_MODE": "relaxed"})

    def test_secret_resolver_impede_traversal_symlink_e_permissao_aberta(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            safe = root / "tenant-a"
            safe.mkdir()
            secret = safe / "meta"
            secret.write_text("valor\n")
            secret.chmod(0o600)
            resolver = DirectorySecretResolver(root)
            self.assertEqual(resolver.resolve("tenant-a/meta"), "valor")
            with self.assertRaises(LookupError): resolver.resolve("../fora")
            link = root / "link"
            link.symlink_to(secret)
            with self.assertRaises(LookupError): resolver.resolve("link")
            secret.chmod(0o644)
            with self.assertRaises(LookupError): resolver.resolve("tenant-a/meta")

    def test_sink_recusa_envelope_com_conta_de_outro_binding(self):
        class Stores:
            def for_binding(self, binding): raise AssertionError("nao deveria criar store")
        binding = TenantBinding("opaque_endpoint_123", "t", "a", "whatsapp", "meta",
                                "internal-a", "external-a", "sig", schema_name="sac_t_a")
        envelope = build_envelope(channel="whatsapp", provider="meta", provider_event_id="m",
            account_id="internal-b", external_user_id="5511", direction="inbound",
            occurred_at="2026-09-09T10:00:00Z", message={"text": "oi"})
        with self.assertRaises(ValueError):
            TenantPostgresSink(Stores()).persist_for_tenant(binding, (envelope,))

    def test_sink_recusa_identidade_canal_ou_provedor_adulterados(self):
        from dataclasses import replace
        class Stores:
            def for_binding(self, binding): raise AssertionError("nao deveria criar store")
        binding = TenantBinding("opaque_endpoint_123", "t", "a", "whatsapp", "meta",
                                "internal-a", "external-a", "sig", schema_name="sac_t_a")
        valid = build_envelope(channel="whatsapp", provider="meta", provider_event_id="m",
            account_id="internal-a", external_user_id="5511", direction="inbound",
            occurred_at="2026-09-09T10:00:00Z", message={"text": "oi"})
        cases = (
            replace(valid, provider="outro"),
            replace(valid, channel="instagram"),
            replace(valid, identity=replace(valid.identity, account_id="internal-b")),
            replace(valid, identity=replace(valid.identity, channel="instagram")),
        )
        for envelope in cases:
            with self.subTest(envelope=envelope):
                with self.assertRaises(ValueError):
                    TenantPostgresSink(Stores()).persist_for_tenant(binding, (envelope,))

    def test_scheduler_faz_uma_rodada_justa_por_escopo(self):
        scopes = (AgentScope("t1", "a1", "sac_t1_a1"), AgentScope("t2", "a2", "sac_t2_a2"))
        class Catalog:
            def list_active(self): return scopes
        stores_seen, workers_seen = [], []
        class Stores:
            def for_scope(self, scope): stores_seen.append(scope); return object()
        class Worker:
            def process_inbound_once(self): return True
            def dispatch_once(self): return False
        class Workers:
            def build(self, scope, store): workers_seen.append(scope); return Worker()
        count = MultiTenantWorkerScheduler(Catalog(), Stores(), Workers()).run_cycle()
        self.assertEqual(count, 2)
        self.assertEqual(stores_seen, list(scopes))
        self.assertEqual(workers_seen, list(scopes))

    def test_store_factory_vincula_scope_no_construtor(self):
        scope = AgentScope("tenant-a", "gabi", "sac_tenant_a_gabi")
        store = PostgresStoreFactory(lambda: None).for_scope(scope)
        self.assertEqual((store.tenant_id, store.agent_id), ("tenant-a", "gabi"))
        self.assertEqual(store._schema, "sac_tenant_a_gabi")

    def test_registry_resolve_join_control_plane_e_binding_completo(self):
        row = ("opaque_endpoint_123", "tenant-a", "gabi", "whatsapp", "meta",
               "account-row", "phone-provider", "sig/ref", "verify/ref",
               "X-Signature", "sac_tenant_a_gabi")
        connection = Connection([row])
        binding = PostgresTenantRegistry(lambda: connection).resolve("opaque_endpoint_123")
        self.assertEqual(binding.account_id, "account-row")
        self.assertEqual(binding.external_account_id, "phone-provider")
        self.assertEqual(binding.schema_name, "sac_tenant_a_gabi")
        sql, params = connection.cur.executions[0]
        self.assertIn("public.sac_channel_accounts", sql)
        self.assertIn("public.sac_agents", sql)
        self.assertEqual(params, ("opaque_endpoint_123",))

    def test_readiness_producao_reprova_config_ou_secret_ref_invalida(self):
        scope = AgentScope("t", "a", "sac_t_a")
        class Catalog:
            def list_active(self): return (scope,)
        class Stores:
            def for_scope(self, value): return object()
        class Workers:
            def build(self, value, store): raise LookupError("segredo ausente")
        self.assertFalse(ProductionReadiness(Probe(True), Catalog(), Stores(), Workers()).ready())

    def test_readiness_producao_exige_ao_menos_um_agente(self):
        class Catalog:
            def list_active(self): return ()
        self.assertFalse(ProductionReadiness(Probe(True), Catalog(), object(), object()).ready())

    def test_scheduler_isola_falha_de_um_tenant_e_processa_o_seguinte(self):
        first = AgentScope("tenant-a", "a", "sac_t_a")
        second = AgentScope("tenant-b", "b", "sac_t_b")
        class Catalog:
            def list_active(self): return (first, second)
        class Stores:
            def for_scope(self, scope): return object()
        class Worker:
            def __init__(self, fails): self.fails = fails
            def process_inbound_once(self):
                if self.fails: raise RuntimeError("falhou")
                return True
            def dispatch_once(self): return not self.fails
        class Workers:
            def build(self, scope, store): return Worker(scope == first)
        errors = []
        scheduler = MultiTenantWorkerScheduler(Catalog(), Stores(), Workers(),
            on_error=lambda scope, phase, error: errors.append((scope, phase, type(error))))
        self.assertEqual(scheduler.run_cycle(), 2)
        self.assertEqual(errors, [(first, "inbound", RuntimeError)])


class RuntimeV2PainelTests(unittest.TestCase):
    """O painel e montado dentro do runtime e falha fechado sem cadastro."""

    class Panel:
        PREFIX = "/api/v1/panel"

        def __call__(self, environ, start_response):
            start_response("200 OK", [])
            return [b"painel"]

    def call(self, app, path):
        status = []
        body = b"".join(app({"PATH_INFO": path, "REQUEST_METHOD": "GET"},
                            lambda value, _: status.append(value)))
        return int(status[0].split()[0]), body

    def test_runtime_encaminha_o_prefixo_do_painel_e_preserva_o_gateway(self):
        app = RuntimeApplication(Gateway(), Probe(True), self.Panel())
        self.assertEqual(self.call(app, "/api/v1/panel/agents"), (200, b"painel"))
        self.assertEqual(self.call(app, "/api/v1/panel"), (200, b"painel"))
        self.assertEqual(self.call(app, "/webhooks/v2/abc")[0], 418)
        self.assertEqual(self.call(app, "/livez")[0], 200)

    def test_sem_cadastro_de_operadores_o_painel_responde_503(self):
        app = RuntimeApplication(Gateway(), Probe(True))
        status, body = self.call(app, "/api/v1/panel/agents")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "panel_disabled")

    def test_settings_leem_a_configuracao_do_painel_do_ambiente(self):
        base = {"DATABASE_URL": "postgresql://db/sac", "SECRET_DIR": "/run/secrets"}
        padrao = RuntimeSettings.from_env(base)
        self.assertFalse(padrao.panel_enabled)
        self.assertTrue(padrao.panel_cookie_secure)
        ligado = RuntimeSettings.from_env({**base, "PANEL_OPERATORS_REF": "painel/operadores.json",
                                           "PANEL_COOKIE_SECURE": "false",
                                           "PANEL_COOKIE_PATH": "/sac/api/",
                                           "PANEL_SESSION_TTL_SECONDS": "3600",
                                           "PANEL_SESSION_IDLE_SECONDS": "600"})
        self.assertTrue(ligado.panel_enabled)
        self.assertFalse(ligado.panel_cookie_secure)
        self.assertEqual(ligado.panel_cookie_path, "/sac/api/")
        for invalido in ({"PANEL_COOKIE_SECURE": "talvez"}, {"PANEL_COOKIE_PATH": "sac"},
                         {"PANEL_SESSION_TTL_SECONDS": "10"},
                         {"PANEL_SESSION_IDLE_SECONDS": "999999"}):
            with self.subTest(invalido=invalido):
                with self.assertRaises(ValueError):
                    RuntimeSettings.from_env({**base, **invalido})

    def test_build_panel_desligado_sem_referencia_de_cadastro(self):
        settings = RuntimeSettings.from_env({"DATABASE_URL": "postgresql://db/sac",
                                             "SECRET_DIR": "/run/secrets"})
        painel = build_panel(settings, lambda: None, object())
        status = []
        painel({"PATH_INFO": "/api/v1/panel/agents", "REQUEST_METHOD": "GET"},
               lambda value, _: status.append(value))
        self.assertEqual(status[0], "503 Service Unavailable")

    def test_store_do_painel_usa_o_schema_do_control_plane(self):
        agent = PanelAgent("dr-lucas", "atendimento", "sac_dr_lucas", "Dr. Lucas",
                           "Atendimento", "provisioned")
        store = PostgresStoreFactory(lambda: None).for_panel_agent(agent)
        self.assertEqual((store.tenant_id, store.agent_id, store._schema),
                         ("dr-lucas", "atendimento", "sac_dr_lucas"))
        with self.assertRaises(ValueError):
            PostgresStoreFactory(lambda: None).for_panel_agent(
                PanelAgent("t", "a", "", "T", "A", "active"))


if __name__ == "__main__": unittest.main()


class PoolerTransacionalTests(unittest.TestCase):
    """Supabase serve o pooler transacional na 6543 e a conexao direta na 5432.

    Sem desligar o prepared statement, a fila comeca a falhar com "prepared
    statement does not exist" so DEPOIS da quinta execucao de cada consulta.
    """

    def test_detecta_pooler_por_porta_host_e_parametro(self):
        for url in (
            "postgresql://u:s@aws-0-sa-east-1.pooler.supabase.com:6543/postgres",
            "postgresql://u:s@db.exemplo.supabase.co:6543/postgres",
            "postgresql://u:s@host:5432/postgres?pgbouncer=true",
        ):
            with self.subTest(url=url):
                self.assertTrue(runtime_v2.usa_pooler_transacional(url))

    def test_conexao_direta_mantem_prepared_statement(self):
        for url in (
            "postgresql://u:s@db.exemplo.supabase.co:5432/postgres",
            "postgresql://u:s@127.0.0.1:5432/sac_homologacao",
            "",
        ):
            with self.subTest(url=url):
                self.assertFalse(runtime_v2.usa_pooler_transacional(url))

    def test_factory_desliga_prepared_statement_so_no_pooler(self):
        chamadas = []

        class PsycopgFalso:
            @staticmethod
            def connect(url, **kwargs):
                chamadas.append((url, kwargs))
                return object()

        original = sys.modules.get("psycopg")
        sys.modules["psycopg"] = PsycopgFalso
        try:
            runtime_v2.psycopg_connection_factory("postgresql://u:s@h.pooler.supabase.com:6543/p")()
            runtime_v2.psycopg_connection_factory("postgresql://u:s@h:5432/p")()
        finally:
            if original is None:
                sys.modules.pop("psycopg", None)
            else:
                sys.modules["psycopg"] = original

        self.assertEqual(chamadas[0][1], {"prepare_threshold": None})
        self.assertEqual(chamadas[1][1], {})
