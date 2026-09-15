import io
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from backend.autonomia_readonly import (
    AutonomiaReadOnlyApplication,
    AutonomiaRepository,
    ContactedWhatsappCatalog,
    mask_handle,
    redact_text,
)


NOW = datetime(2026, 9, 9, 20, 0, tzinfo=timezone.utc)


class FakeDatabase:
    def __init__(self, kind):
        self.kind = kind
        self.calls = []

    def query(self, sql, params=()):
        self.calls.append((sql, tuple(params)))
        flat = " ".join(sql.split()).lower()
        if flat.startswith("select 1"):
            return [{"ok": 1}]
        if self.kind == "central" and "count(*)::int as leads" in flat:
            return [{"leads": 2, "conversations": 1, "messages": 3,
                     "unique_contacts": 2, "last_activity": NOW}]
        if self.kind == "central" and "from agente24horas.conversations c" in flat and "count(*)::int as conversations" in flat:
            return [{"conversations": 10, "responded": 2, "messages": 12,
                     "unique_contacts": 9, "last_activity": NOW}]
        if self.kind == "central" and "select c.session_id as entity_id" in flat:
            return [{"entity_id": "whatsapp:5511977774321", "display_name": "Bruno Real",
                     "phone": "+55 11 97777-4321", "email": None, "company": "Empresa B",
                     "pipeline_id": "p2", "pipeline_name": "Contatado", "status": "active",
                     "last_activity": NOW, "message_count": 2}]
        if self.kind == "central" and "from agente24horas.crm_leads l" in flat and "limit %s" in flat:
            return [{"entity_id": "lead-ad", "display_name": "Ana Real",
                     "phone": "+55 11 98888-1234", "email": "ana@example.com",
                     "company": "Clínica A", "pipeline_id": "p1", "pipeline_name": "Novo",
                     "status": "open", "session_id": "s1", "channel": "whatsapp",
                     "last_activity": NOW, "message_count": 3}]
        if self.kind == "central" and "'ads:' || l.id::text as conversation_id" in flat:
            return [{"conversation_id": "ads:lead-ad", "id": "m1", "direction": "user",
                     "status": "delivered", "subject": None, "body": "Olá do anúncio",
                     "sent_at": NOW}]
        if self.kind == "central" and "select c.session_id,m.id" in flat:
            return [{"session_id": "whatsapp:5511977774321", "id": "mw1", "direction": "assistant",
                     "status": "delivered", "subject": None, "body": "Oi pelo WhatsApp",
                     "sent_at": NOW}]
        if self.kind == "central" and "select c.session_id" in flat:
            return [{"session_id": "s1"}]
        if self.kind == "central" and "from agente24horas.messages" in flat:
            return [{"id": "m1", "direction": "user", "status": "delivered",
                     "subject": None, "body": "Meu e-mail é ana@example.com e telefone 11988881234",
                     "sent_at": NOW}]
        if self.kind == "central" and "group by 1,2 order by" in flat:
            return [{"id": "p1", "name": "Novo", "leads": 2}]
        if self.kind == "miner" and "group by t.channel::text" in flat:
            return [
                {"channel": "email", "conversations": 20, "responded": 3, "messages": 25,
                 "unique_contacts": 18, "last_activity": NOW},
            ]
        if self.kind == "miner" and "select t.id::text as entity_id" in flat:
            channel = params[1]
            return [{"entity_id": f"thread-{channel}", "lead_id": "same-lead",
                     "channel": channel, "display_name": "Bruno Real",
                     "phone": "+55 21 97777-4321", "email": "bruno@empresa.com",
                     "company": "Empresa B", "pipeline_id": "p2", "pipeline_name": "Contatado",
                     "status": "replied", "last_activity": NOW, "message_count": 2}]
        if self.kind == "miner" and "'mining_' || t.channel::text" in flat:
            return [
                {"conversation_id": "mining_email:thread-email", "id": "me1",
                 "direction": "inbound", "status": "delivered", "subject": "Resposta",
                 "body": "Oi por e-mail", "sent_at": NOW},
            ]
        if self.kind == "miner" and "from minerador_scrapling.outreach_messages om" in flat:
            return [{"id": "mm1", "direction": "inbound", "status": "delivered",
                     "subject": "Contato bruno@empresa.com", "body": "Ligue +55 (21) 97777-4321",
                     "sent_at": NOW}]
        if self.kind == "miner" and "coalesce(ps.id::text" in flat:
            return [{"channel": "whatsapp", "id": "p2", "name": "Contatado", "leads": 9}]
        raise AssertionError(f"consulta inesperada: {flat[:100]}")


class AutonomiaRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.central = FakeDatabase("central")
        self.miner = FakeDatabase("miner")
        self.repo = AutonomiaRepository(self.central, self.miner)

    def test_overview_separa_tres_fluxos_reais(self):
        payload = self.repo.overview()
        self.assertEqual(payload["dataMode"], "real")
        self.assertTrue(payload["readOnly"])
        self.assertEqual(payload["customer"], {"id": "autonomia", "name": "AutonomIA"})
        self.assertEqual([s["id"] for s in payload["sources"]],
                         ["ads", "mining_whatsapp", "mining_email"])
        self.assertEqual([s["captureOrigin"] for s in payload["sources"]],
                         ["Meta Ads", "Google Places", "Google Places"])
        self.assertEqual([s["channel"] for s in payload["sources"]],
                         ["whatsapp", "whatsapp", "email"])

    def test_conversas_mascaram_handle_e_dedupe_cruza_canais_sem_pii(self):
        payload = self.repo.conversations(limit=5)
        raw = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("11988881234", raw)
        self.assertNotIn("bruno@empresa.com", raw)
        mining = [c for c in payload["conversations"] if c["source"].startswith("mining_")]
        self.assertEqual(len(mining), 2)
        self.assertNotIn("5511977774321", json.dumps(mining, ensure_ascii=False))
        self.assertTrue(all(c["isReal"] for c in payload["conversations"]))

    def test_amostra_mista_preserva_as_tres_origens(self):
        payload = self.repo.conversations(limit=3)
        self.assertEqual({c["source"] for c in payload["conversations"]},
                         {"ads", "mining_whatsapp", "mining_email"})

    def test_mensagens_redigem_telefone_e_email(self):
        payload = self.repo.messages("mining_email:thread-email")
        raw = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("bruno@empresa.com", raw)
        self.assertNotIn("97777-4321", raw)
        self.assertIn("b***@empresa.com", raw)
        self.assertIn("•••• 4321", raw)

    def test_sanitizadores(self):
        self.assertEqual(mask_handle("maria@empresa.com", "email"), "m***@empresa.com")
        self.assertEqual(mask_handle("+55 (11) 99888-1234", "whatsapp"), "•••• 1234")
        clean = redact_text("maria@empresa.com / +55 (11) 99888-1234")
        self.assertNotIn("maria@empresa.com", clean)
        self.assertNotIn("99888-1234", clean)


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.app = AutonomiaReadOnlyApplication(
            AutonomiaRepository(FakeDatabase("central"), FakeDatabase("miner")))

    def call(self, path, method="GET", query=""):
        status, headers = [], []
        environ = {"PATH_INFO": path, "REQUEST_METHOD": method,
                   "QUERY_STRING": query, "wsgi.input": io.BytesIO()}
        body = b"".join(self.app(environ, lambda s, h: (status.append(s), headers.extend(h))))
        return int(status[0].split()[0]), dict(headers), json.loads(body or b"{}")

    def test_api_expoe_snapshot_e_recusa_escrita(self):
        status, headers, payload = self.call("/api/v1/autonomia/snapshot", query="limit=3")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "private, no-store")
        self.assertEqual(payload["customer"]["id"], "autonomia")
        self.assertIn("pipeline", payload)
        self.assertTrue(all(c["messages"] for c in payload["conversations"]))
        self.assertFalse(payload["outboundEnabled"])
        self.assertEqual(self.call("/api/v1/autonomia/snapshot", method="POST")[0], 405)

    def test_filtro_invalido_falha_fechado(self):
        self.assertEqual(self.call("/api/v1/autonomia/conversations", query="source=outro")[0], 400)

    def test_endpoint_mensagens(self):
        status, _, payload = self.call(
            "/api/v1/autonomia/conversations/mining_email%3Athread-email/messages")
        self.assertEqual(status, 200)
        self.assertEqual(payload["messages"][0]["direction"], "inbound")


class ContactedWhatsappCatalogTests(unittest.TestCase):
    """O arquivo e relido a cada /readyz; o cache so pode valer enquanto ele nao mudar."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "contatados.json"
        self.write({"5511900000001": 1, "5511900000002": 1})
        self.catalog = ContactedWhatsappCatalog(self.path)

    def write(self, payload):
        self.path.write_text(json.dumps(payload))
        self.path.chmod(0o600)

    def settle(self, segundos=10):
        """Envelhece o mtime para fora da janela de corrida, sem sleep no teste."""
        quando = time.time_ns() - segundos * 1_000_000_000
        os.utime(self.path, ns=(quando, quando))

    def spy_on_reads(self):
        original = Path.read_text
        return mock.patch.object(Path, "read_text", autospec=True, side_effect=original)

    def test_conta_as_chaves_do_registro(self):
        self.assertEqual(self.catalog.count(), 2)

    def test_cache_evita_reler_o_arquivo_enquanto_ele_nao_muda(self):
        self.settle()
        self.catalog.count()
        with self.spy_on_reads() as spy:
            self.assertEqual(self.catalog.count(), 2)
            self.assertEqual(self.catalog.count(), 2)
        self.assertEqual(spy.call_count, 0, "cache nao deveria reabrir o arquivo")

    def test_cache_invalida_quando_o_arquivo_muda(self):
        self.settle()
        self.assertEqual(self.catalog.count(), 2)
        self.write({"5511900000001": 1, "5511900000002": 1, "5511900000003": 1})
        self.settle()
        with self.spy_on_reads() as spy:
            self.assertEqual(self.catalog.count(), 3)
        self.assertEqual(spy.call_count, 1, "mudanca no arquivo deve forcar releitura")

    def test_reescrita_do_mesmo_tamanho_no_mesmo_tique_ainda_invalida(self):
        """O mtime do kernel e grosseiro: duas escritas seguidas podem ficar
        com o mesmo mtime_ns e o mesmo tamanho. O cache nao pode acreditar."""
        self.assertEqual(self.catalog.count(), 2)
        antes = self.path.stat()
        self.write({"5511900000009": 1, "5511900000008": 1})
        depois = self.path.stat()
        self.assertEqual(antes.st_size, depois.st_size)
        with self.spy_on_reads() as spy:
            self.assertEqual(self.catalog.count(), 2)
        self.assertGreaterEqual(spy.call_count, 1,
                                "arquivo recem-escrito nao pode vir do cache")

    def test_arquivo_recem_escrito_nao_e_dado_como_assentado(self):
        """Enquanto o mtime estiver dentro da janela de corrida, rele sempre."""
        with self.spy_on_reads() as spy:
            self.catalog.count()
            self.catalog.count()
        self.assertEqual(spy.call_count, 2)

    def test_troca_atomica_do_arquivo_invalida_o_cache(self):
        self.settle()
        self.assertEqual(self.catalog.count(), 2)
        substituto = Path(self.tmp.name) / "novo.json"
        substituto.write_text(json.dumps({"5511900000004": 1}))
        substituto.chmod(0o600)
        os.replace(substituto, self.path)
        self.assertEqual(self.catalog.count(), 1)

    def test_symlink_e_recusado(self):
        alvo = Path(self.tmp.name) / "alvo.json"
        alvo.write_text(json.dumps({"a": 1}))
        alvo.chmod(0o600)
        link = Path(self.tmp.name) / "link.json"
        link.symlink_to(alvo)
        with self.assertRaises(RuntimeError):
            ContactedWhatsappCatalog(link).count()

    def test_arquivo_legivel_por_outros_e_recusado(self):
        self.path.chmod(0o644)
        with self.assertRaises(RuntimeError):
            ContactedWhatsappCatalog(self.path).count()

    def test_arquivo_ausente_e_recusado(self):
        with self.assertRaises(RuntimeError):
            ContactedWhatsappCatalog(Path(self.tmp.name) / "nao-existe.json").count()

    def test_payload_invalido_nao_fica_em_cache(self):
        self.write(["nao", "e", "dict"])
        catalog = ContactedWhatsappCatalog(self.path)
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                catalog.count()
        self.write({"5511900000005": 1})
        self.assertEqual(catalog.count(), 1)


if __name__ == "__main__":
    unittest.main()
