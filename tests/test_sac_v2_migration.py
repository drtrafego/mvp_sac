import runpy
import unittest
from pathlib import Path


class SacV2MigrationTests(unittest.TestCase):
    def test_static_validator_runs_offline(self):
        root = Path(__file__).resolve().parents[1]
        runpy.run_path(str(root / "validate_sac_v2.py"), run_name="__main__")


    def test_contract_matches_postgres_store(self):
        root = Path(__file__).resolve().parents[1]
        sql = (root / "002_sac_multiagent_v2.sql").read_text(encoding="utf-8")
        expected = {
        "sac_contacts": ("id text", "display_name text", "pipeline_stage text", "merged_into text"),
        "sac_identities": ("contact_id text", "channel text", "account_id text", "external_user_id text"),
        "sac_threads": ("identity_id text", "external_thread_id text", "bot_paused boolean"),
        "sac_messages": ("thread_id text", "event_id text", "direction text", "body jsonb"),
        "sac_inbound_events": ("dedupe_key text", "provider_event_id text", "payload jsonb", "processed_at timestamptz"),
        "sac_domain_events": ("event_type text", "aggregate_id text", "payload jsonb"),
        "sac_outbox": ("topic text", "status text", "attempts integer", "max_attempts integer", "lease_token text"),
        "sac_dead_letters": ("outbox_id text", "attempts integer", "last_error text", "failed_at timestamptz"),
        "sac_origins": ("contact_id text", "message_id text", "data jsonb", "created_at timestamptz"),
        "sac_contact_points": ("contact_id text", "kind text", "normalized_value text", "source text"),
        "sac_profile_fields": ("contact_id text", "field_name text", "value jsonb", "confidence numeric"),
        "sac_contact_merges": ("source_contact_id text", "target_contact_id text", "snapshot jsonb"),
        "sac_crm_actions": ("contact_id text", "action text", "idempotency_key text", "actor text", "payload jsonb"),
        }
        for table, columns in expected.items():
            start = sql.index(f"CREATE TABLE %1$I.{table} (")
            block = sql[start : sql.index("\n    );", start)]
            for column in columns:
                self.assertIn(column, block, (table, column))

    def test_control_plane_matches_production_worker_without_secrets_in_json(self):
        root = Path(__file__).resolve().parents[1]
        sql = (root / "002_sac_multiagent_v2.sql").read_text(encoding="utf-8")
        for column in (
            "runtime_config jsonb", "hermes_api_key_secret_ref text",
            "access_token_secret_ref text", "api_key_secret_ref text",
            "smtp_username_secret_ref text", "smtp_password_secret_ref text",
        ):
            self.assertIn(column, sql)
        self.assertIn("sac_json_contains_secret_key(runtime_config)", sql)
        self.assertIn("sac_json_contains_secret_key(config)", sql)
        self.assertIn("sac_activate_agent", sql)
        self.assertIn("ALTER TABLE %I.%I OWNER TO %I", sql)


if __name__ == "__main__":
    unittest.main()
