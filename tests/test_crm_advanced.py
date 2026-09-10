import json
import tempfile
import unittest
from pathlib import Path

from backend import SQLiteStore
from multicanal import build_envelope


def envelope(event, channel="whatsapp", user="5511999", acquisition=None):
    return build_envelope(
        channel=channel, provider="meta", provider_event_id=event,
        account_id=f"account-{channel}", external_user_id=user,
        direction="inbound", occurred_at="2026-09-08T20:00:00Z",
        message={"type": "text", "text": "oi"}, acquisition=acquisition,
    )


class AdvancedCRMTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SQLiteStore(Path(self.tmp.name) / "crm.sqlite3")

    def tearDown(self):
        self.tmp.cleanup()

    def test_ingest_aplica_tags_de_canal_e_origem(self):
        contact = self.store.ingest("bella", envelope("e1", acquisition={
            "source": "Instagram Ads", "campaign": "Constelacao Setembro"
        })).contact_id
        rows = self._tags(contact)
        self.assertEqual(rows, {"canal:whatsapp", "origem:source:instagram ads",
                                "origem:campaign:constelacao setembro"})

    def test_enriquecimento_guarda_proveniencia_e_normaliza(self):
        contact = self.store.ingest("bella", envelope("e1")).contact_id
        self.store.enrich_contact("bella", contact, fields={"cidade": "Campinas"},
                                  contact_points={"email": "ANA@EXAMPLE.COM", "instagram": "@Ana"},
                                  source="hermes", confidence=.8)
        email = self.store.fetchone("SELECT * FROM contact_points WHERE kind='email'")
        self.assertEqual(email["normalized_value"], "ana@example.com")
        profile = self.store.fetchone("SELECT * FROM contact_profile_fields WHERE field_name='cidade'")
        self.assertEqual(json.loads(profile["value_json"]), "Campinas")
        self.assertEqual(profile["source"], "hermes")
        self.assertAlmostEqual(profile["confidence"], .8)
        self.assertIsNotNone(self.store.fetchone("SELECT 1 FROM domain_events WHERE event_type='contact.enriched'"))

    def test_dado_igual_nao_faz_merge_automatico(self):
        first = self.store.ingest("bella", envelope("e1", user="a")).contact_id
        second = self.store.ingest("bella", envelope("e2", user="b")).contact_id
        self.store.enrich_contact("bella", first, contact_points={"phone": "+55 (11) 9999-0000"})
        with self.assertRaisesRegex(ValueError, "merge explicito"):
            self.store.enrich_contact("bella", second, contact_points={"phone": "551199990000"})
        self.assertIsNone(self.store.fetchone("SELECT merged_into FROM contacts WHERE id=?", (second,))["merged_into"])

    def test_merge_explicito_move_grafo_e_cria_auditoria(self):
        source = self.store.ingest("bella", envelope("e1", user="a")).contact_id
        target = self.store.ingest("bella", envelope("e2", channel="instagram", user="b")).contact_id
        self.store.enrich_contact("bella", source, contact_points={"email": "ana@example.com"},
                                  fields={"interesse": "curso"})
        self.store.tag_contact("bella", source, "lead-quente")
        merge_id = self.store.merge_contacts("bella", source, target,
                                             actor="hermes:reviewed", reason="confirmacao da cliente")
        self.assertEqual(self.store.fetchone("SELECT merged_into FROM contacts WHERE id=?", (source,))["merged_into"], target)
        self.assertEqual(self.store.fetchone("SELECT contact_id FROM contact_points WHERE kind='email'")["contact_id"], target)
        audit = self.store.fetchone("SELECT * FROM contact_merges WHERE id=?", (merge_id,))
        self.assertEqual(audit["actor"], "hermes:reviewed")
        self.assertIsNotNone(self.store.fetchone("SELECT 1 FROM domain_events WHERE event_type='contacts.merged'"))
        with self.assertRaises(KeyError):
            self.store.enrich_contact("bella", source, fields={"x": 1})

    def _tags(self, contact_id):
        with self.store._connection() as conn:
            return {r["name"] for r in conn.execute(
                "SELECT t.name FROM tags t JOIN contact_tags ct ON ct.tag_id=t.id "
                "WHERE ct.tenant_id='bella' AND ct.contact_id=?", (contact_id,))}


if __name__ == "__main__":
    unittest.main()
