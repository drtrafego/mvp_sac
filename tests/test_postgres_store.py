"""Unit tests for PostgreSQL semantics without requiring a live database."""

from __future__ import annotations

import json
import unittest
from collections import deque
from dataclasses import replace

from backend.postgres_store import ClaimedOutbound, PostgresStore
from multicanal import build_envelope


class FakeCursor:
    def __init__(self, results=()):
        self.results = deque(results)
        self.executions = []
        self.rowcount = 1
        self.closed = False

    def execute(self, query, params=()):
        self.executions.append((" ".join(query.split()), params))
        return self

    def fetchone(self):
        return self.results.popleft() if self.results else None

    def fetchall(self):
        value = self.results.popleft() if self.results else []
        return value

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, results=()):
        self.cur = FakeCursor(results)
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class Factory:
    def __init__(self, *connections):
        self.connections = deque(connections)

    def __call__(self):
        return self.connections.popleft()


def envelope(provider_id="provider-1", acquisition=None):
    return build_envelope(
        channel="whatsapp", provider="meta", provider_event_id=provider_id,
        account_id="waba-1", external_user_id="5511999999999", direction="inbound",
        occurred_at="2026-09-09T10:00:00Z", message={"text": "oi"},
        received_at="2026-09-09T10:00:01Z", acquisition=acquisition,
    )


class PostgresStoreTests(unittest.TestCase):
    def test_rejects_identifier_injection_and_empty_scope(self):
        with self.assertRaises(ValueError):
            PostgresStore(lambda: None, tenant_id="", agent_id="gabi", schema="sac")
        with self.assertRaises(ValueError):
            PostgresStore(lambda: None, tenant_id="tenant", agent_id="gabi",
                          schema="sac; DROP SCHEMA public")

    def test_ingest_rejects_identity_channel_or_account_mismatch_before_connection(self):
        store = PostgresStore(lambda: self.fail("nao deveria conectar"),
                              tenant_id="tenant", agent_id="gabi", schema="sac_gabi")
        valid = envelope()
        cases = (
            replace(valid, identity=replace(valid.identity, account_id="other")),
            replace(valid, identity=replace(valid.identity, channel="instagram")),
        )
        for invalid in cases:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    store.ingest(invalid)

    def test_duplicate_ingest_is_noop_and_commits(self):
        connection = FakeConnection([None])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="gabi_sac")
        result = store.ingest(envelope(acquisition={"source": "facebook"}))
        self.assertFalse(result.accepted)
        self.assertEqual(connection.commits, 1)
        query, params = connection.cur.executions[0]
        self.assertIn("ON CONFLICT (tenant_id,agent_id,dedupe_key) DO NOTHING", query)
        self.assertEqual(params[1:3], ("tenant-a", "gabi"))
        self.assertEqual(len(connection.cur.executions), 1)

    def test_ingest_builds_whole_graph_in_one_transaction(self):
        connection = FakeConnection([
            {"id": "event"},  # inbound insert
            None,              # identity lookup
            None,              # thread lookup
            {"id": "tag_channel"}, {"tag_id": "tag_channel"},
        ])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="gabi_sac")
        result = store.ingest(envelope())
        self.assertTrue(result.accepted)
        self.assertTrue(all((result.contact_id, result.identity_id,
                             result.conversation_id, result.message_id)))
        sql = "\n".join(query for query, _ in connection.cur.executions)
        for table in ("sac_inbound_events", "sac_contacts", "sac_identities",
                      "sac_threads", "sac_messages", "sac_domain_events", "sac_outbox"):
            self.assertIn(f'"gabi_sac"."{table}"', sql)
        self.assertIn("pg_advisory_xact_lock", sql)
        self.assertEqual(connection.commits, 1)
        self.assertEqual(connection.rollbacks, 0)

    def test_ingest_rolls_back_everything_on_failure(self):
        class ExplodingCursor(FakeCursor):
            def execute(self, query, params=()):
                super().execute(query, params)
                if "sac_messages" in query:
                    raise RuntimeError("disk/database failure")
                return self

        connection = FakeConnection([{"id": "event"}, None, None])
        connection.cur = ExplodingCursor([{"id": "event"}, None, None])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="gabi_sac")
        with self.assertRaises(RuntimeError):
            store.ingest(envelope())
        self.assertEqual(connection.commits, 0)
        self.assertEqual(connection.rollbacks, 1)

    def test_claim_is_atomic_skip_locked_and_scoped(self):
        payload = {"channel": "email", "account_id": "inbox",
                   "recipient_id": "lead@example.com", "text": "ola", "subject": "Oi"}
        connection = FakeConnection([{"id": "ob_1", "payload": payload, "attempts": 2,
                                      "lease_token": "lease"}])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="isabella",
                              schema="shared_sac")
        item = store.claim_outbound()
        self.assertEqual(item.id, "ob_1")
        self.assertEqual(item.tenant_id, "tenant-a")
        self.assertEqual(item.agent_id, "isabella")
        query, params = next((sql, values) for sql, values in connection.cur.executions
                             if "FOR UPDATE SKIP LOCKED" in sql)
        self.assertIn("FOR UPDATE SKIP LOCKED", query)
        self.assertIn("attempts < max_attempts", query)
        self.assertIn("available_at <= now()", query)
        self.assertIn("leased_until <= now()", query)
        self.assertEqual(params[:3], ("tenant-a", "isabella", "outbound.send"))

    def test_claim_sweeps_expired_final_lease_to_dlq(self):
        connection = FakeConnection([None])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        self.assertIsNone(store.claim_outbound())
        sql = "\n".join(query for query, _ in connection.cur.executions)
        self.assertIn("lease expirou na tentativa final", sql)
        self.assertIn("sac_dead_letters", sql)
        self.assertIn("attempts >= max_attempts", sql)
        self.assertIn("leased_until <= now()", sql)

    def test_claim_domain_excludes_inbound_and_outbound_topics(self):
        connection = FakeConnection([{"id": "ob-domain", "topic": "contact.tagged",
            "aggregate_id": "ct", "payload": {"tag": "vip"}, "attempts": 1,
            "lease_token": "lease"}])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        item = store.claim_domain_event()
        self.assertEqual(item.topic, "contact.tagged")
        self.assertEqual(item.payload, {"tag": "vip"})
        claim_sql = next(sql for sql, _ in connection.cur.executions
                         if "FOR UPDATE SKIP LOCKED" in sql)
        self.assertIn("topic NOT IN ('message.received','outbound.send')", claim_sql)
        self.assertIn("attempts < max_attempts", claim_sql)

    def test_failed_final_attempt_goes_to_dead_letter_atomically(self):
        payload = {"channel": "email", "text": "ola"}
        connection = FakeConnection([{"topic": "outbound.send", "aggregate_id": "msg_1",
                                      "payload": payload, "attempts": 5, "max_attempts": 5}])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="isabella",
                              schema="shared_sac")
        item = ClaimedOutbound("ob_1", "lease", "tenant-a", "isabella", "email",
                               "inbox", "lead@example.com", "ola", "Oi", 5)
        self.assertTrue(store.finish_outbound(item, success=False, error="provider down"))
        sql = "\n".join(query for query, _ in connection.cur.executions)
        self.assertIn('"shared_sac"."sac_dead_letters"', sql)
        self.assertIn("SET status='dead'", sql)
        self.assertIn("lease_token=%s", sql)
        self.assertEqual(connection.commits, 1)

    def test_stale_lease_cannot_finish_another_workers_item(self):
        connection = FakeConnection([None])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="isabella",
                              schema="shared_sac")
        item = ClaimedOutbound("ob_1", "old-lease", "tenant-a", "isabella", "email",
                               "inbox", "lead@example.com", "ola", "Oi", 1)
        self.assertFalse(store.finish_outbound(item, success=True))
        self.assertEqual(len(connection.cur.executions), 1)

    def test_payload_cannot_override_bound_scope(self):
        connection = FakeConnection([{"id": "ob"}])
        store = PostgresStore(Factory(connection), tenant_id="real-tenant", agent_id="gabi",
                              schema="shared_sac")
        store.enqueue_outbound(message_id="msg", channel="email", account_id="mail",
                               recipient_id="victim", text=json.dumps({"tenant_id": "other"}))
        _, params = connection.cur.executions[0]
        self.assertEqual(params[1:3], ("real-tenant", "gabi"))

    def test_finish_rejects_item_from_other_scope_without_query(self):
        connection = FakeConnection()
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        item = ClaimedOutbound("ob", "lease", "tenant-b", "gabi", "email", "mail",
                               "lead@example.com", "ola", "Oi", 1)
        with self.assertRaises(ValueError):
            store.finish_outbound(item, success=True)
        self.assertEqual(connection.cur.executions, [])

    def test_tag_contact_is_scoped_audited_and_atomic(self):
        connection = FakeConnection([
            {"id": "ct", "display_name": "Ana", "pipeline_stage": "novo", "merged_into": None},
            {"id": "tag_1"}, {"tag_id": "tag_1"},
        ])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        store.tag_contact("ct", " VIP ")
        sql = "\n".join(query for query, _ in connection.cur.executions)
        self.assertIn("sac_tags", sql)
        self.assertIn("sac_contact_tags", sql)
        self.assertIn("sac_domain_events", sql)
        self.assertIn("sac_outbox", sql)
        self.assertEqual(connection.commits, 1)

    def test_enrich_rejects_cross_contact_point_and_rolls_back(self):
        connection = FakeConnection([
            {"id": "ct", "display_name": "Ana", "pipeline_stage": "novo", "merged_into": None},
            {"contact_id": "another-contact"},
        ])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        with self.assertRaises(ValueError):
            store.enrich_contact("ct", contact_points={"email": "same@example.com"})
        self.assertEqual(connection.commits, 0)
        self.assertEqual(connection.rollbacks, 1)

    def test_hermes_decision_is_idempotent_before_any_side_effect(self):
        connection = FakeConnection([{"id": "already"}])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        changed = store.apply_hermes_decision(
            message_id="msg", channel="email", account_id="mail",
            recipient_id="lead@example.com", decision={"text": "nao deve sair"})
        self.assertFalse(changed)
        sql = "\n".join(query for query, _ in connection.cur.executions)
        self.assertNotIn("sac_outbox", sql)
        self.assertEqual(connection.commits, 1)

    def test_hermes_context_is_fully_scoped(self):
        connection = FakeConnection([
            {"thread_id": "th", "contact_id": "ct", "display_name": "Ana",
             "pipeline_stage": "novo"},
            [{"channel": "email", "account_id": "mail", "external_user_id": "a@b.com",
              "display_name": "Ana"}],
            [{"name": "vip"}],
            [{"field_name": "notes", "value": "\"nota\""}],
            [{"kind": "email", "value": "a@b.com"}],
            [{"direction": "inbound", "occurred_at": "2026-09-09T10:00:00Z",
              "body": {"text": "oi"}}],
            {"data": {"source": "facebook", "campaign": "inverno"}},
        ])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        context = store.hermes_context("msg")
        self.assertEqual(context["contact_id"], "ct")
        self.assertEqual(context["tags"], ["vip"])
        self.assertEqual(context["data"], {"notes": "nota"})
        self.assertEqual(context["recent_messages"][0]["text"], "oi")
        self.assertEqual(context["acquisition"]["campaign"], "inverno")
        self.assertTrue(any("WITH RECURSIVE family" in sql
                            for sql, _ in connection.cur.executions))
        for sql, params in connection.cur.executions:
            if len(params) >= 2:
                self.assertIn("tenant_id=%s", sql)
                self.assertIn("agent_id=%s", sql)
                self.assertEqual(params[:2], ("tenant-a", "gabi"))

    def test_ingest_persists_acquisition_and_origin_tags_in_same_transaction(self):
        connection = FakeConnection([
            {"id": "event"}, None, None,
            {"id": "tag_channel"}, {"tag_id": "tag_channel"},
            {"id": "tag_source"}, {"tag_id": "tag_source"},
            {"id": "tag_campaign"}, {"tag_id": "tag_campaign"},
        ])
        store = PostgresStore(Factory(connection), tenant_id="tenant-a", agent_id="gabi",
                              schema="shared_sac")
        result = store.ingest(envelope(acquisition={"source": "Facebook", "campaign": "Inverno"}))
        self.assertTrue(result.accepted)
        sql = "\n".join(query for query, _ in connection.cur.executions)
        self.assertIn('"shared_sac"."sac_origins"', sql)
        tag_params = [params for query, params in connection.cur.executions
                      if "INSERT INTO" in query and "sac_tags" in query]
        self.assertTrue(any("origem:source:facebook" in params for params in tag_params))
        self.assertTrue(any("origem:campaign:inverno" in params for params in tag_params))
        self.assertEqual(connection.commits, 1)


if __name__ == "__main__":
    unittest.main()
