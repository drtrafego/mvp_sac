import tempfile
import unittest
from pathlib import Path
from threading import Event

from backend.cli import Settings, build_application, build_service, main, run_worker


class CliTests(unittest.TestCase):
    def test_tenant_e_obrigatorio_e_limites_sao_validados(self):
        with self.assertRaises(ValueError):
            Settings.from_env({})
        with self.assertRaises(ValueError):
            Settings.from_env({"TENANT_ID": "bella", "BACKEND_PORT": "99999"})

    def test_composition_root_sem_chaves_forca_todos_os_clientes_em_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings.from_env({
                "TENANT_ID": "bella", "DATABASE_PATH": str(Path(tmp) / "db.sqlite3"),
                "EMAIL_PROVIDER": "generic",
            })
            service = build_service(settings)
            self.assertTrue(service.hermes.dry_run)
            self.assertTrue(service.connectors["whatsapp"].dry_run)
            self.assertTrue(service.connectors["instagram"].dry_run)
            self.assertTrue(service.connectors["email"].dry_run)
            app = build_application(settings, service)
            self.assertEqual(app.config.email_provider, "generic")

    def test_force_dry_run_prevalece_mesmo_com_chaves(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings.from_env({
                "TENANT_ID": "bella", "DATABASE_PATH": str(Path(tmp) / "db.sqlite3"),
                "DRY_RUN": "true", "HERMES_API_KEY": "h", "WHATSAPP_ACCESS_TOKEN": "w",
                "INSTAGRAM_ACCESS_TOKEN": "i", "EMAIL_PROVIDER": "brevo",
                "BREVO_API_KEY": "b", "EMAIL_SENDER": "bella@example.com",
            })
            service = build_service(settings)
            self.assertTrue(all(client.dry_run for client in
                                [service.hermes, *service.connectors.values()]))

    def test_worker_para_graciosamente_e_so_dorme_quando_ocioso(self):
        stop, calls, sleeps = Event(), [], []
        def operation():
            calls.append(1)
            if len(calls) == 2:
                stop.set()
            return len(calls) == 1
        run_worker(operation, stop, 0.5, sleeps.append)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [0.5])

    def test_main_falha_fechado_sem_configuracao(self):
        self.assertEqual(main(["worker-inbound"], {}), 2)

    def test_strict_config_falha_fechado_fora_de_dry_run(self):
        with self.assertRaisesRegex(ValueError, "HERMES_API_KEY"):
            Settings.from_env({"TENANT_ID": "bella", "STRICT_CONFIG": "true"})

    def test_strict_config_permite_homologacao_em_dry_run(self):
        settings = Settings.from_env({"TENANT_ID": "bella", "STRICT_CONFIG": "true",
                                      "DRY_RUN": "true"})
        self.assertTrue(settings.force_dry_run)


if __name__ == "__main__": unittest.main()
