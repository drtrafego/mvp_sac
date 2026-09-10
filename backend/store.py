"""Contrato e implementacao SQLite para homologacao do backend multicanal."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional, Protocol
from uuid import uuid4

from multicanal.core import ChannelIdentity, NormalizedEnvelope

from .pipeline import PipelineEngine


@dataclass(frozen=True)
class IngestResult:
    accepted: bool
    contact_id: Optional[str] = None
    identity_id: Optional[str] = None
    conversation_id: Optional[str] = None
    message_id: Optional[str] = None


@dataclass(frozen=True)
class PendingOutbound:
    id: str
    tenant_id: str
    channel: str
    account_id: str
    recipient_id: str
    text: str
    subject: str


@dataclass(frozen=True)
class PendingInbound:
    outbox_id: str
    tenant_id: str
    message_id: str
    conversation_id: str
    channel: str
    account_id: str
    recipient_id: str
    text: str


class Store(Protocol):
    def ingest(self, tenant_id: str, envelope: NormalizedEnvelope) -> IngestResult: ...
    def link_identity(self, tenant_id: str, contact_id: str, identity: ChannelIdentity) -> str: ...
    def advance_pipeline(self, tenant_id: str, contact_id: str, target_stage: str) -> str: ...


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT,
  pipeline_stage TEXT NOT NULL, merged_into TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  channel TEXT NOT NULL, account_id TEXT NOT NULL, external_user_id TEXT NOT NULL,
  display_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, channel, account_id, external_user_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, identity_id TEXT NOT NULL,
  channel TEXT NOT NULL, account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, identity_id, channel, account_id),
  FOREIGN KEY (identity_id) REFERENCES identities(id)
);
CREATE TABLE IF NOT EXISTS inbound_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  provider_event_id TEXT NOT NULL, channel TEXT NOT NULL, payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL, processed_at TEXT,
  UNIQUE (tenant_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  event_id TEXT, direction TEXT NOT NULL, provider_event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL, body_json TEXT NOT NULL,
  UNIQUE (tenant_id, conversation_id, provider_event_id, direction),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (event_id) REFERENCES inbound_events(id)
);
CREATE TABLE IF NOT EXISTS acquisition_sources (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  message_id TEXT NOT NULL, data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, message_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, topic TEXT NOT NULL,
  aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_outbound_aggregate_unique
  ON outbox (tenant_id, aggregate_id) WHERE topic = 'outbound.send';
CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pipeline_history (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  from_stage TEXT, to_stage TEXT NOT NULL, actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);
CREATE TABLE IF NOT EXISTS contact_points (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  kind TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL,
  source TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, kind, normalized_value),
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);
CREATE TABLE IF NOT EXISTS contact_profile_fields (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  field_name TEXT NOT NULL, value_json TEXT NOT NULL, source TEXT NOT NULL,
  confidence REAL NOT NULL, observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, contact_id, field_name, source),
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS contact_tags (
  tenant_id TEXT NOT NULL, contact_id TEXT NOT NULL, tag_id TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, contact_id, tag_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id), FOREIGN KEY (tag_id) REFERENCES tags(id)
);
CREATE TABLE IF NOT EXISTS contact_merges (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source_contact_id TEXT NOT NULL,
  target_contact_id TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS crm_action_log (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  message_id TEXT NOT NULL, decision_json TEXT NOT NULL, applied_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, message_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (published_at, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (tenant_id, conversation_id, occurred_at);
"""


class SQLiteStore:
    """SQLite real, destinado a testes e homologacao; uma transacao por operacao."""

    def __init__(self, path: str | Path, pipeline: Optional[PipelineEngine] = None) -> None:
        self.path = str(path)
        self.pipeline = pipeline or PipelineEngine()
        with self._connection() as conn:
            conn.executescript(SCHEMA)
            # Bancos de homologacao criados pela versao anterior sao preservados.
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(contacts)")}
            if "merged_into" not in columns:
                conn.execute("ALTER TABLE contacts ADD COLUMN merged_into TEXT")
            outbox_columns = {row["name"] for row in conn.execute("PRAGMA table_info(outbox)")}
            if "claimed_at" not in outbox_columns:
                conn.execute("ALTER TABLE outbox ADD COLUMN claimed_at TEXT")
            if "last_error" not in outbox_columns:
                conn.execute("ALTER TABLE outbox ADD COLUMN last_error TEXT")

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA journal_mode = WAL")
        try:
            yield conn
        finally:
            conn.close()

    @staticmethod
    def _id(prefix: str) -> str:
        return f"{prefix}_{uuid4().hex}"

    @staticmethod
    def _json(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def ingest(self, tenant_id: str, envelope: NormalizedEnvelope) -> IngestResult:
        tenant_id = tenant_id.strip()
        if not tenant_id:
            raise ValueError("tenant_id e obrigatorio")
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            event_id = envelope.event_id
            try:
                conn.execute(
                    "INSERT INTO inbound_events VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                    (event_id, tenant_id, envelope.dedupe_key, envelope.provider_event_id,
                     envelope.channel, self._json(envelope.to_dict()), envelope.received_at),
                )
            except sqlite3.IntegrityError:
                conn.rollback()
                return IngestResult(False)

            ident = conn.execute(
                "SELECT id, contact_id FROM identities WHERE tenant_id=? AND channel=? AND account_id=? AND external_user_id=?",
                (tenant_id, envelope.identity.channel, envelope.identity.account_id,
                 envelope.identity.external_user_id),
            ).fetchone()
            if ident is None:
                contact_id, identity_id = self._id("ct"), self._id("id")
                conn.execute("INSERT INTO contacts(id,tenant_id,display_name,pipeline_stage) VALUES(?,?,?,?)",
                             (contact_id, tenant_id, envelope.identity.display_name, self.pipeline.stages[0]))
                conn.execute(
                    "INSERT INTO identities(id,tenant_id,contact_id,channel,account_id,external_user_id,display_name) VALUES(?,?,?,?,?,?,?)",
                    (identity_id, tenant_id, contact_id, envelope.identity.channel,
                     envelope.identity.account_id, envelope.identity.external_user_id,
                     envelope.identity.display_name),
                )
            else:
                identity_id, contact_id = ident["id"], ident["contact_id"]

            conversation = conn.execute(
                "SELECT id FROM conversations WHERE tenant_id=? AND identity_id=? AND channel=? AND account_id=?",
                (tenant_id, identity_id, envelope.channel, envelope.account_id),
            ).fetchone()
            conversation_id = conversation["id"] if conversation else self._id("cv")
            if conversation is None:
                conn.execute("INSERT INTO conversations(id,tenant_id,identity_id,channel,account_id) VALUES(?,?,?,?,?)",
                             (conversation_id, tenant_id, identity_id, envelope.channel, envelope.account_id))
            message_id = self._id("msg")
            conn.execute(
                "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
                (message_id, tenant_id, conversation_id, event_id, envelope.direction,
                 envelope.provider_event_id, envelope.occurred_at, self._json(envelope.message)),
            )
            if envelope.acquisition is not None:
                conn.execute("INSERT INTO acquisition_sources(id,tenant_id,contact_id,message_id,data_json) VALUES(?,?,?,?,?)",
                             (self._id("src"), tenant_id, contact_id, message_id, self._json(envelope.acquisition)))
            self._tag_in_transaction(conn, tenant_id, contact_id, f"canal:{envelope.channel}", "automation")
            if envelope.acquisition:
                for key in ("source", "origin", "platform", "campaign"):
                    value = envelope.acquisition.get(key)
                    if isinstance(value, str) and value.strip():
                        self._tag_in_transaction(conn, tenant_id, contact_id,
                                                 f"origem:{key}:{value.strip().casefold()}", "automation")
            payload = {"event_id": event_id, "contact_id": contact_id, "message_id": message_id,
                       "conversation_id": conversation_id, "channel": envelope.channel}
            serialized = self._json(payload)
            conn.execute("INSERT INTO domain_events(id,tenant_id,event_type,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                         (self._id("evt"), tenant_id, "message.received", conversation_id, serialized))
            conn.execute("INSERT INTO outbox(id,tenant_id,topic,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                         (self._id("ob"), tenant_id, "message.received", conversation_id, serialized))
            conn.execute("UPDATE inbound_events SET processed_at=CURRENT_TIMESTAMP WHERE id=?", (event_id,))
            conn.commit()
            return IngestResult(True, contact_id, identity_id, conversation_id, message_id)

    def link_identity(self, tenant_id: str, contact_id: str, identity: ChannelIdentity) -> str:
        """Vinculo cross-channel somente por chamada explicita; nunca por nome."""
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT 1 FROM contacts WHERE tenant_id=? AND id=?", (tenant_id, contact_id)).fetchone() is None:
                conn.rollback()
                raise KeyError("contato inexistente")
            found = conn.execute(
                "SELECT id,contact_id FROM identities WHERE tenant_id=? AND channel=? AND account_id=? AND external_user_id=?",
                (tenant_id, identity.channel, identity.account_id, identity.external_user_id),
            ).fetchone()
            if found and found["contact_id"] != contact_id:
                conn.rollback()
                raise ValueError("identidade ja ligada a outro contato")
            if found:
                conn.commit()
                return found["id"]
            identity_id = self._id("id")
            conn.execute("INSERT INTO identities(id,tenant_id,contact_id,channel,account_id,external_user_id,display_name) VALUES(?,?,?,?,?,?,?)",
                         (identity_id, tenant_id, contact_id, identity.channel, identity.account_id,
                          identity.external_user_id, identity.display_name))
            self._emit(conn, tenant_id, "identity.linked", contact_id,
                       {"identity_id": identity_id, "channel": identity.channel,
                        "account_id": identity.account_id, "actor": "explicit"})
            conn.commit()
            return identity_id

    def advance_pipeline(self, tenant_id: str, contact_id: str, target_stage: str) -> str:
        self.pipeline.rank(target_stage)
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT pipeline_stage FROM contacts WHERE tenant_id=? AND id=?",
                               (tenant_id, contact_id)).fetchone()
            if row is None:
                conn.rollback()
                raise KeyError("contato inexistente")
            current = row["pipeline_stage"]
            resolved = self.pipeline.resolve(current, target_stage)
            if resolved != current:
                conn.execute("UPDATE contacts SET pipeline_stage=? WHERE tenant_id=? AND id=?",
                             (resolved, tenant_id, contact_id))
                payload = self._json({"from": current, "to": resolved})
                conn.execute("INSERT INTO pipeline_history(id,tenant_id,contact_id,from_stage,to_stage,actor) VALUES(?,?,?,?,?,?)",
                             (self._id("ph"), tenant_id, contact_id, current, resolved, "automation"))
                conn.execute("INSERT INTO domain_events(id,tenant_id,event_type,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                             (self._id("evt"), tenant_id, "pipeline.advanced", contact_id, payload))
                conn.execute("INSERT INTO outbox(id,tenant_id,topic,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                             (self._id("ob"), tenant_id, "pipeline.advanced", contact_id, payload))
            conn.commit()
            return resolved

    @staticmethod
    def _normalize_point(kind: str, value: str) -> str:
        kind, value = kind.strip().casefold(), value.strip()
        if kind not in {"email", "phone", "instagram"} or not value:
            raise ValueError("tipo ou valor de contato invalido")
        if kind == "email":
            return value.casefold()
        if kind == "instagram":
            return value.lstrip("@").casefold()
        digits = "".join(ch for ch in value if ch.isdigit())
        if not digits:
            raise ValueError("telefone invalido")
        return "+" + digits

    def _tag_in_transaction(self, conn: sqlite3.Connection, tenant_id: str,
                            contact_id: str, name: str, source: str) -> None:
        clean = name.strip().casefold()
        if not clean:
            raise ValueError("tag vazia")
        row = conn.execute("SELECT id FROM tags WHERE tenant_id=? AND name=?", (tenant_id, clean)).fetchone()
        tag_id = row["id"] if row else self._id("tag")
        if row is None:
            conn.execute("INSERT INTO tags(id,tenant_id,name) VALUES(?,?,?)", (tag_id, tenant_id, clean))
        conn.execute("INSERT OR IGNORE INTO contact_tags(tenant_id,contact_id,tag_id,source) VALUES(?,?,?,?)",
                     (tenant_id, contact_id, tag_id, source))

    def tag_contact(self, tenant_id: str, contact_id: str, name: str, *, source: str = "hermes") -> None:
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._require_active_contact(conn, tenant_id, contact_id)
            self._tag_in_transaction(conn, tenant_id, contact_id, name, source)
            self._emit(conn, tenant_id, "contact.tagged", contact_id, {"tag": name, "source": source})
            conn.commit()

    def enrich_contact(self, tenant_id: str, contact_id: str, *,
                       fields: Mapping[str, Any] | None = None,
                       contact_points: Mapping[str, str] | None = None,
                       source: str = "hermes", confidence: float = 1.0) -> None:
        """Registra fatos com proveniencia; nunca faz merge por heuristica."""
        if not 0 <= confidence <= 1 or not source.strip():
            raise ValueError("source/confidence invalidos")
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._require_active_contact(conn, tenant_id, contact_id)
            for name, value in (fields or {}).items():
                if not name.strip():
                    raise ValueError("campo vazio")
                conn.execute(
                    "INSERT INTO contact_profile_fields(id,tenant_id,contact_id,field_name,value_json,source,confidence) "
                    "VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,contact_id,field_name,source) DO UPDATE SET "
                    "value_json=excluded.value_json,confidence=excluded.confidence,observed_at=CURRENT_TIMESTAMP",
                    (self._id("cpf"), tenant_id, contact_id, name.strip(), self._json(value), source, confidence))
            for kind, value in (contact_points or {}).items():
                normalized = self._normalize_point(kind, value)
                existing = conn.execute("SELECT contact_id FROM contact_points WHERE tenant_id=? AND kind=? AND normalized_value=?",
                                        (tenant_id, kind.casefold(), normalized)).fetchone()
                if existing and existing["contact_id"] != contact_id:
                    conn.rollback()
                    raise ValueError("dado pertence a outro contato; merge explicito necessario")
                conn.execute("INSERT OR IGNORE INTO contact_points(id,tenant_id,contact_id,kind,value,normalized_value,source) VALUES(?,?,?,?,?,?,?)",
                             (self._id("cp"), tenant_id, contact_id, kind.casefold(), value.strip(), normalized, source))
            self._emit(conn, tenant_id, "contact.enriched", contact_id,
                       {"fields": sorted((fields or {}).keys()), "contact_points": sorted((contact_points or {}).keys()), "source": source})
            conn.commit()

    def merge_contacts(self, tenant_id: str, source_contact_id: str, target_contact_id: str,
                       *, actor: str, reason: str) -> str:
        if source_contact_id == target_contact_id or not actor.strip() or not reason.strip():
            raise ValueError("merge invalido")
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            source = self._require_active_contact(conn, tenant_id, source_contact_id)
            target = self._require_active_contact(conn, tenant_id, target_contact_id)
            conflicts = conn.execute(
                "SELECT s.kind,s.normalized_value FROM contact_points s JOIN contact_points t "
                "ON t.tenant_id=s.tenant_id AND t.kind=s.kind AND t.normalized_value=s.normalized_value "
                "WHERE s.tenant_id=? AND s.contact_id=? AND t.contact_id=?", (tenant_id, source_contact_id, target_contact_id)).fetchall()
            snapshot = {"source": dict(source), "target": dict(target), "shared_points": [dict(r) for r in conflicts]}
            conn.execute("UPDATE identities SET contact_id=? WHERE tenant_id=? AND contact_id=?", (target_contact_id, tenant_id, source_contact_id))
            conn.execute("UPDATE contact_points SET contact_id=? WHERE tenant_id=? AND contact_id=?", (target_contact_id, tenant_id, source_contact_id))
            conn.execute(
                "DELETE FROM contact_profile_fields WHERE tenant_id=? AND contact_id=? AND EXISTS ("
                "SELECT 1 FROM contact_profile_fields t WHERE t.tenant_id=contact_profile_fields.tenant_id "
                "AND t.contact_id=? AND t.field_name=contact_profile_fields.field_name "
                "AND t.source=contact_profile_fields.source)",
                (tenant_id, source_contact_id, target_contact_id))
            conn.execute("UPDATE contact_profile_fields SET contact_id=? WHERE tenant_id=? AND contact_id=?",
                         (target_contact_id, tenant_id, source_contact_id))
            conn.execute("INSERT OR IGNORE INTO contact_tags(tenant_id,contact_id,tag_id,source) SELECT tenant_id,?,tag_id,source FROM contact_tags WHERE tenant_id=? AND contact_id=?",
                         (target_contact_id, tenant_id, source_contact_id))
            conn.execute("DELETE FROM contact_tags WHERE tenant_id=? AND contact_id=?", (tenant_id, source_contact_id))
            conn.execute("UPDATE acquisition_sources SET contact_id=? WHERE tenant_id=? AND contact_id=?", (target_contact_id, tenant_id, source_contact_id))
            conn.execute("UPDATE contacts SET merged_into=? WHERE tenant_id=? AND id=?", (target_contact_id, tenant_id, source_contact_id))
            merge_id = self._id("merge")
            conn.execute("INSERT INTO contact_merges VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
                         (merge_id, tenant_id, source_contact_id, target_contact_id, actor, reason, self._json(snapshot)))
            self._emit(conn, tenant_id, "contacts.merged", target_contact_id,
                       {"merge_id": merge_id, "source_contact_id": source_contact_id,
                        "target_contact_id": target_contact_id, "actor": actor, "reason": reason})
            conn.commit()
            return merge_id

    @staticmethod
    def _require_active_contact(conn: sqlite3.Connection, tenant_id: str, contact_id: str) -> sqlite3.Row:
        row = conn.execute("SELECT * FROM contacts WHERE tenant_id=? AND id=?", (tenant_id, contact_id)).fetchone()
        if row is None or row["merged_into"] is not None:
            raise KeyError("contato inexistente ou ja mesclado")
        return row

    def _emit(self, conn: sqlite3.Connection, tenant_id: str, event_type: str,
              aggregate_id: str, payload: Mapping[str, Any]) -> None:
        serialized = self._json(payload)
        conn.execute("INSERT INTO domain_events(id,tenant_id,event_type,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                     (self._id("evt"), tenant_id, event_type, aggregate_id, serialized))
        conn.execute("INSERT INTO outbox(id,tenant_id,topic,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                     (self._id("ob"), tenant_id, event_type, aggregate_id, serialized))

    def fetchone(self, sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
        """Ajuda de inspecao para homologacao e testes."""
        with self._connection() as conn:
            return conn.execute(sql, params).fetchone()

    def enqueue_outbound(self, *, tenant_id: str, message_id: str, channel: str,
                         account_id: str, recipient_id: str, text: str,
                         subject: str = "Mensagem") -> bool:
        payload = self._json({"channel": channel, "account_id": account_id,
                              "recipient_id": recipient_id, "text": text,
                              "subject": subject})
        with self._connection() as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO outbox(id,tenant_id,topic,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                (self._id("ob"), tenant_id, "outbound.send", message_id, payload),
            )
            return cursor.rowcount == 1

    def claim_inbound(self, tenant_id: str) -> Optional[PendingInbound]:
        """Reserva atomicamente um evento recebido e carrega seu contexto."""
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,payload_json FROM outbox WHERE tenant_id=? AND topic='message.received' "
                "AND published_at IS NULL AND (claimed_at IS NULL OR claimed_at <= datetime('now','-5 minutes')) "
                "ORDER BY created_at,id LIMIT 1",
                (tenant_id,),
            ).fetchone()
            if row is None:
                conn.commit()
                return None
            if conn.execute("UPDATE outbox SET attempts=attempts+1,claimed_at=CURRENT_TIMESTAMP,last_error=NULL "
                            "WHERE id=? AND published_at IS NULL AND "
                            "(claimed_at IS NULL OR claimed_at <= datetime('now','-5 minutes'))",
                            (row["id"],)).rowcount != 1:
                conn.rollback()
                return None
            payload = json.loads(row["payload_json"])
            context = conn.execute(
                "SELECT m.body_json,c.id conversation_id,c.channel,c.account_id,i.external_user_id "
                "FROM messages m JOIN conversations c ON c.id=m.conversation_id "
                "JOIN identities i ON i.id=c.identity_id WHERE m.tenant_id=? AND m.id=?",
                (tenant_id, payload["message_id"]),
            ).fetchone()
            if context is None:
                conn.rollback()
                raise RuntimeError("evento inbound sem mensagem associada")
            conn.commit()
            body = json.loads(context["body_json"])
            text = next((body[key] for key in ("text", "body", "content")
                         if isinstance(body.get(key), str)), "")
            return PendingInbound(row["id"], tenant_id, payload["message_id"],
                                  context["conversation_id"], context["channel"],
                                  context["account_id"], context["external_user_id"], text)

    def finish_inbound(self, item_id: str, *, success: bool, error: str | None = None) -> None:
        with self._connection() as conn:
            if success:
                conn.execute("UPDATE outbox SET published_at=CURRENT_TIMESTAMP,claimed_at=NULL,last_error=NULL "
                             "WHERE id=? AND claimed_at IS NOT NULL", (item_id,))
            else:
                conn.execute("UPDATE outbox SET claimed_at=NULL,last_error=? WHERE id=? AND claimed_at IS NOT NULL",
                             ((error or "worker failure")[:1000], item_id))

    def hermes_context(self, tenant_id: str, message_id: str) -> dict:
        """Snapshot CRM limitado e sem segredos para fundamentar a decisão do Hermes."""
        with self._connection() as conn:
            base = conn.execute(
                "SELECT m.conversation_id,i.contact_id,c.display_name,c.pipeline_stage "
                "FROM messages m JOIN conversations v ON v.id=m.conversation_id "
                "JOIN identities i ON i.id=v.identity_id JOIN contacts c ON c.id=i.contact_id "
                "WHERE m.tenant_id=? AND m.id=?", (tenant_id, message_id),
            ).fetchone()
            if base is None:
                raise KeyError("mensagem inexistente")
            contact_id = base["contact_id"]
            identities = [dict(row) for row in conn.execute(
                "SELECT channel,account_id,external_user_id,display_name FROM identities "
                "WHERE tenant_id=? AND contact_id=? ORDER BY created_at", (tenant_id, contact_id))]
            tags = [row["name"] for row in conn.execute(
                "SELECT t.name FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id "
                "WHERE ct.tenant_id=? AND ct.contact_id=? ORDER BY t.name", (tenant_id, contact_id))]
            data = {row["field_name"]: json.loads(row["value_json"]) for row in conn.execute(
                "SELECT field_name,value_json FROM contact_profile_fields WHERE tenant_id=? AND contact_id=? "
                "ORDER BY observed_at", (tenant_id, contact_id))}
            points = {row["kind"]: row["value"] for row in conn.execute(
                "SELECT kind,value FROM contact_points WHERE tenant_id=? AND contact_id=? ORDER BY created_at",
                (tenant_id, contact_id))}
            history = []
            for row in conn.execute(
                "SELECT direction,occurred_at,body_json FROM messages WHERE tenant_id=? AND conversation_id=? "
                "ORDER BY occurred_at DESC,id DESC LIMIT 20", (tenant_id, base["conversation_id"])):
                body = json.loads(row["body_json"])
                history.append({"direction": row["direction"], "occurred_at": row["occurred_at"],
                                "text": next((body.get(k) for k in ("text", "body", "content") if isinstance(body.get(k), str)), "")})
            source = conn.execute(
                "SELECT data_json FROM acquisition_sources WHERE tenant_id=? AND contact_id=? ORDER BY created_at LIMIT 1",
                (tenant_id, contact_id),
            ).fetchone()
            return {"contact_id": contact_id, "display_name": base["display_name"],
                    "pipeline_stage": base["pipeline_stage"], "identities": identities,
                    "tags": tags, "data": data, "contact_points": points,
                    "acquisition": json.loads(source["data_json"]) if source else None,
                    "recent_messages": list(reversed(history))}

    def apply_hermes_decision(self, *, tenant_id: str, message_id: str, channel: str,
                              account_id: str, recipient_id: str, decision: dict) -> bool:
        """Aplica uma decisão validada numa transação e registra exatamente o que mudou."""
        allowed_fields = {"name", "email", "phone", "instagram_username", "notes"}
        text = str(decision.get("text") or "").strip()
        tags = sorted({str(tag).strip().lower() for tag in (decision.get("tags") or [])
                       if isinstance(tag, str) and 0 < len(tag.strip()) <= 64})[:20]
        extracted = {str(k): str(v).strip() for k, v in (decision.get("data") or {}).items()
                     if k in allowed_fields and isinstance(v, (str, int, float)) and str(v).strip()} 
        requested_stage = decision.get("pipeline_stage")
        if requested_stage is not None:
            self.pipeline.rank(str(requested_stage))
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute("SELECT 1 FROM crm_action_log WHERE tenant_id=? AND message_id=?",
                                    (tenant_id, message_id)).fetchone()
            if existing:
                conn.commit()
                return False
            row = conn.execute(
                "SELECT i.contact_id,c.pipeline_stage FROM messages m JOIN conversations v ON v.id=m.conversation_id "
                "JOIN identities i ON i.id=v.identity_id JOIN contacts c ON c.id=i.contact_id "
                "WHERE m.tenant_id=? AND m.id=?", (tenant_id, message_id)).fetchone()
            if row is None:
                conn.rollback(); raise KeyError("mensagem inexistente")
            contact_id, current = row["contact_id"], row["pipeline_stage"]
            applied = {"tags": [], "data": {}, "pipeline_stage": current, "outbound": bool(text)}
            for tag in tags:
                before = conn.total_changes
                self._tag_in_transaction(conn, tenant_id, contact_id, tag, "hermes")
                if conn.total_changes > before:
                    applied["tags"].append(tag)
            for field, value in extracted.items():
                if field in {"email", "phone", "instagram_username"}:
                    kind = "instagram" if field == "instagram_username" else field
                    normalized = self._normalize_point(kind, value)
                    owner = conn.execute("SELECT contact_id FROM contact_points WHERE tenant_id=? AND kind=? AND normalized_value=?",
                                         (tenant_id, kind, normalized)).fetchone()
                    if owner and owner["contact_id"] != contact_id:
                        continue
                    conn.execute("INSERT OR IGNORE INTO contact_points(id,tenant_id,contact_id,kind,value,normalized_value,source) VALUES(?,?,?,?,?,?,?)",
                                 (self._id("cp"), tenant_id, contact_id, kind, value, normalized, "hermes"))
                else:
                    conn.execute(
                        "INSERT INTO contact_profile_fields(id,tenant_id,contact_id,field_name,value_json,source,confidence) "
                        "VALUES(?,?,?,?,?,'hermes',1.0) ON CONFLICT(tenant_id,contact_id,field_name,source) DO UPDATE SET "
                        "value_json=excluded.value_json,confidence=excluded.confidence,observed_at=CURRENT_TIMESTAMP",
                        (self._id("cpf"), tenant_id, contact_id, field, self._json(value)))
                applied["data"][field] = value
            if requested_stage:
                resolved = self.pipeline.resolve(current, str(requested_stage))
                if resolved != current:
                    conn.execute("UPDATE contacts SET pipeline_stage=? WHERE tenant_id=? AND id=?", (resolved, tenant_id, contact_id))
                    conn.execute("INSERT INTO pipeline_history(id,tenant_id,contact_id,from_stage,to_stage,actor) VALUES(?,?,?,?,?,?)",
                                 (self._id("ph"), tenant_id, contact_id, current, resolved, "hermes"))
                    applied["pipeline_stage"] = resolved
            if text:
                payload = self._json({"channel": channel, "account_id": account_id,
                                      "recipient_id": recipient_id, "text": text,
                                      "subject": str(decision.get("subject") or "Mensagem")[:200]})
                conn.execute("INSERT OR IGNORE INTO outbox(id,tenant_id,topic,aggregate_id,payload_json) VALUES(?,?,?,?,?)",
                             (self._id("ob"), tenant_id, "outbound.send", message_id, payload))
            conn.execute("INSERT INTO crm_action_log VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)",
                         (self._id("crm"), tenant_id, contact_id, message_id,
                          self._json(decision), self._json(applied)))
            conn.commit()
            return True

    def claim_outbound(self, tenant_id: str) -> Optional[PendingOutbound]:
        """Claim simples e atomico para um unico worker de homologacao."""
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,payload_json FROM outbox WHERE tenant_id=? AND topic='outbound.send' "
                "AND published_at IS NULL AND (claimed_at IS NULL OR claimed_at <= datetime('now','-5 minutes')) "
                "ORDER BY created_at,id LIMIT 1",
                (tenant_id,),
            ).fetchone()
            if row is None:
                conn.commit()
                return None
            # Lease recuperavel evita que um crash deixe o item preso para sempre.
            changed = conn.execute("UPDATE outbox SET attempts=attempts+1,claimed_at=CURRENT_TIMESTAMP,last_error=NULL "
                                   "WHERE id=? AND published_at IS NULL AND "
                                   "(claimed_at IS NULL OR claimed_at <= datetime('now','-5 minutes'))",
                                   (row["id"],)).rowcount
            if changed != 1:
                conn.rollback()
                return None
            conn.commit()
            payload = json.loads(row["payload_json"])
            return PendingOutbound(row["id"], tenant_id, payload["channel"], payload["account_id"],
                                   payload["recipient_id"], payload["text"], payload["subject"])

    def finish_outbound(self, item_id: str, *, success: bool, error: str | None = None) -> None:
        with self._connection() as conn:
            if success:
                conn.execute("UPDATE outbox SET published_at=CURRENT_TIMESTAMP,claimed_at=NULL,last_error=NULL "
                             "WHERE id=? AND claimed_at IS NOT NULL", (item_id,))
            else:
                conn.execute("UPDATE outbox SET claimed_at=NULL,last_error=? WHERE id=? AND claimed_at IS NOT NULL",
                             ((error or "delivery failure")[:1000], item_id))
