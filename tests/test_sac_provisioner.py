import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from backend.sac_provisioner import (
    Manifest, Provisioner, ProvisionStatus, ProvisioningError,
    load_manifest, make_schema_name, render_plan, validate_offline_registry,
)


ROOT = Path(__file__).resolve().parents[1]


class FakeBackend:
    def __init__(self, *, registered=True, status=None):
        self.registered = registered
        self.current = status or ProvisionStatus(registered, False, False, False, False, False, 0)
        self.control_calls = 0
        self.agent_calls = 0
        self.fail_after_ready = False

    def registry_agent_exists(self, key):
        return self.registered

    def inspect(self, manifest):
        return self.current

    def apply_control_plane(self, sql):
        self.control_calls += 1
        self.current = ProvisionStatus(self.registered, True, False, False, False, False, 0)

    def provision_agent(self, manifest):
        self.agent_calls += 1
        self.current = ProvisionStatus(self.registered, True, True, True, True, True, 17)
        if self.fail_after_ready:
            raise RuntimeError("corrida")


def manifest(**changes):
    raw = {
        "tenant_id": "cliente-a", "tenant_name": "Cliente A",
        "agent_id": "gabi", "agent_name": "Gabi",
        "owner_role": "sac_owner", "app_role": "sac_app",
        "worker_role": "sac_worker", "registry_key": "gramadoplazza",
    }
    raw.update(changes)
    return Manifest.from_mapping(raw)


class ManifestTests(unittest.TestCase):
    def test_schema_deterministico_e_limitado(self):
        self.assertEqual(make_schema_name("cliente-a", "gabi"), make_schema_name("cliente-a", "gabi"))
        self.assertNotEqual(make_schema_name("cliente-a", "gabi"), make_schema_name("cliente_a", "gabi"))
        long_name = make_schema_name("a" + "x" * 61, "b" + "y" * 61)
        self.assertLessEqual(len(long_name), 63)
        self.assertTrue(long_name.startswith("sac_"))

    def test_aceita_schema_configuravel_seguro_e_recusa_injecao(self):
        self.assertEqual(manifest(schema_name="sac_outro_cliente").schema_name, "sac_outro_cliente")
        with self.assertRaisesRegex(ProvisioningError, "schema_name invalido"):
            manifest(schema_name='sac_ok";drop_schema')

    def test_manifesto_nao_aceita_campos_surpresa(self):
        with self.assertRaisesRegex(ProvisioningError, "desconhecidos"):
            manifest(password="segredo")

    def test_config_publica_recusa_chaves_de_segredo_aninhadas(self):
        for key in ("access_token", "passphrase", "authorization", "private_key", "apiKey"):
            with self.subTest(key=key), self.assertRaisesRegex(ProvisioningError, "reservada"):
                manifest(runtime_config={"hermes": {"base_url": "https://h", key: "valor"}})

    def test_status_distingue_schema_pronto_de_runtime_pronto(self):
        structural = ProvisionStatus(True, True, True, True, True, True, 17,
                                     runtime_configured=False, active_channel_accounts=0)
        operational = ProvisionStatus(True, True, True, True, True, True, 17,
                                      runtime_configured=True, active_channel_accounts=1)
        self.assertTrue(structural.ready)
        self.assertFalse(structural.operational_ready)
        self.assertTrue(operational.operational_ready)

    def test_registry_offline_exige_agente_existente(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "agents.json"
            path.write_text(json.dumps({"agents": [{"slug": "gramadoplazza"}]}))
            self.assertTrue(validate_offline_registry(path, "gramadoplazza"))
            self.assertFalse(validate_offline_registry(path, "inexistente"))

    def test_plano_cita_literal_e_inclui_migration(self):
        item = manifest(tenant_name="Cliente d'Água")
        plan = render_plan(item, include_control_plane=True, migration_sql="BEGIN;\nCOMMIT;")
        self.assertIn("BEGIN;\nCOMMIT;", plan)
        self.assertIn("Cliente d''Água", plan)
        self.assertNotIn("password", plan.casefold())


class ProvisionerTests(unittest.TestCase):
    def test_aplica_control_plane_e_agente(self):
        backend = FakeBackend()
        status = Provisioner(backend).apply(
            manifest(), "BEGIN; COMMIT;", apply_control_plane=True, apply_agent=True
        )
        self.assertTrue(status.ready)
        self.assertEqual((backend.control_calls, backend.agent_calls), (1, 1))

    def test_reexecucao_pronta_e_noop(self):
        ready = ProvisionStatus(True, True, True, True, True, True, 17)
        backend = FakeBackend(status=ready)
        result = Provisioner(backend).apply(
            manifest(), "nao executar", apply_control_plane=True, apply_agent=True
        )
        self.assertTrue(result.ready)
        self.assertEqual((backend.control_calls, backend.agent_calls), (0, 0))

    def test_recusa_agente_ausente_antes_de_escrever(self):
        backend = FakeBackend(registered=False)
        with self.assertRaisesRegex(ProvisioningError, "nao existe"):
            Provisioner(backend).apply(
                manifest(), "sql", apply_control_plane=True, apply_agent=True
            )
        self.assertEqual((backend.control_calls, backend.agent_calls), (0, 0))

    def test_recusa_estado_parcial(self):
        partial = ProvisionStatus(True, True, True, False, True, False, 0)
        with self.assertRaisesRegex(ProvisioningError, "parcial"):
            Provisioner(FakeBackend(status=partial)).apply(
                manifest(), "sql", apply_control_plane=False, apply_agent=True
            )

    def test_corrida_idempotente_so_e_sucesso_se_estado_ficou_pronto(self):
        backend = FakeBackend()
        backend.fail_after_ready = True
        result = Provisioner(backend).apply(
            manifest(), "sql", apply_control_plane=True, apply_agent=True
        )
        self.assertTrue(result.ready)


class CliTests(unittest.TestCase):
    def test_dry_run_nao_exige_dsn_e_nao_imprime_inventario(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            config = tmp / "manifest.json"
            inventory = tmp / "agents.json"
            config.write_text(json.dumps({
                "tenant_id": "cliente-a", "tenant_name": "Cliente A",
                "agent_id": "gabi", "agent_name": "Gabi",
                "owner_role": "sac_owner", "app_role": "sac_app",
                "worker_role": "sac_worker", "registry_key": "gramadoplazza",
            }))
            inventory.write_text(json.dumps({"agents": [{"slug": "gramadoplazza",
                                                           "private": "NAO_VAZAR"}]}))
            run = subprocess.run(
                [sys.executable, str(ROOT / "scripts/provision-sac-v2.py"),
                 "--manifest", str(config), "--registry-json", str(inventory), "--dry-run"],
                text=True, capture_output=True, env={}, check=False,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("sac_provision_agent", run.stdout)
            self.assertNotIn("NAO_VAZAR", run.stdout + run.stderr)

    def test_apply_exige_confirmacao_exata_antes_de_conectar(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "manifest.json"
            config.write_text(json.dumps({
                "tenant_id": "cliente-a", "tenant_name": "Cliente A",
                "agent_id": "gabi", "agent_name": "Gabi",
                "owner_role": "sac_owner", "app_role": "sac_app",
                "worker_role": "sac_worker", "registry_key": "gramadoplazza",
            }))
            run = subprocess.run(
                [sys.executable, str(ROOT / "scripts/provision-sac-v2.py"),
                 "--manifest", str(config), "--apply-agent", "--confirm", "errado"],
                text=True, capture_output=True, env={}, check=False,
            )
            self.assertEqual(run.returncode, 2)
            self.assertIn("--confirm cliente-a/gabi", run.stderr)
            self.assertNotIn("SAC_DATABASE_URL", run.stderr)


if __name__ == "__main__":
    unittest.main()
