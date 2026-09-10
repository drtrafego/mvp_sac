"""PostgreSQL persistence for the shared, tenant-isolated SAC service.

The store is deliberately *tenant bound*: ``tenant_id`` and ``agent_id`` are
constructor arguments and never come from an inbound envelope or a worker job.
Every query includes both values, even when the row id is globally unique.  A
connection factory is injected so the module works with psycopg, a pool, or
small DB-API fakes in unit tests without importing a PostgreSQL driver.

The companion migration owns the ``sac_*`` tables.  This module never creates
or alters schema objects.
"""

from __future__ import annotations

import base64
import json
import re
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Mapping, Optional, Protocol
from uuid import uuid4

from multicanal.core import ChannelIdentity, NormalizedEnvelope

from .origins import normalize as normalize_origin
from .panel_analytics import AnalyticsQueries
from .pipeline import PipelineEngine
from .store import IngestResult


class Cursor(Protocol):
    rowcount: int

    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Any: ...
    def fetchone(self) -> Any: ...
    def fetchall(self) -> list[Any]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...
    def close(self) -> None: ...


ConnectionFactory = Callable[[], Connection]


@dataclass(frozen=True)
class ClaimedInbound:
    outbox_id: str
    lease_token: str
    tenant_id: str
    agent_id: str
    message_id: str
    conversation_id: str
    channel: str
    account_id: str
    recipient_id: str
    text: str
    attempts: int


@dataclass(frozen=True)
class ClaimedOutbound:
    id: str
    lease_token: str
    tenant_id: str
    agent_id: str
    channel: str
    account_id: str
    recipient_id: str
    text: str
    subject: str
    attempts: int


@dataclass(frozen=True)
class ClaimedDomainEvent:
    id: str
    lease_token: str
    tenant_id: str
    agent_id: str
    topic: str
    aggregate_id: str
    payload: Mapping[str, Any]
    attempts: int


class PostgresStore(AnalyticsQueries):
    """DB-API PostgreSQL store permanently scoped to one tenant and agent.

    ``AnalyticsQueries`` entra como base para que os relatorios do painel
    herdem o mesmo escopo tenant/agente fixado aqui no construtor: nao existe
    caminho em que uma consulta de analytics veja outro cliente.
    """

    tenant_bound = True
    _IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

    def __init__(
        self,
        connection_factory: ConnectionFactory,
        *,
        tenant_id: str,
        agent_id: str,
        schema: str,
        pipeline: Optional[PipelineEngine] = None,
        close_connections: bool = True,
        lease_seconds: int = 300,
        max_attempts: int = 5,
    ) -> None:
        self.tenant_id = self._required(tenant_id, "tenant_id")
        self.agent_id = self._required(agent_id, "agent_id")
        if not self._IDENTIFIER.fullmatch(schema):
            raise ValueError("schema PostgreSQL invalido")
        if not callable(connection_factory):
            raise TypeError("connection_factory deve ser chamavel")
        if lease_seconds < 1 or max_attempts < 1:
            raise ValueError("lease_seconds e max_attempts devem ser positivos")
        self._factory = connection_factory
        self._schema = schema
        self.pipeline = pipeline or PipelineEngine()
        self._close_connections = close_connections
        self.lease_seconds = lease_seconds
        self.max_attempts = max_attempts

    @staticmethod
    def _required(value: str, field: str) -> str:
        clean = value.strip()
        if not clean:
            raise ValueError(f"{field} e obrigatorio")
        return clean

    @staticmethod
    def _id(prefix: str) -> str:
        return f"{prefix}_{uuid4().hex}"

    @staticmethod
    def _json(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def _table(self, name: str) -> str:
        # Both pieces are constants/validated identifiers. Values remain bound.
        if not self._IDENTIFIER.fullmatch(name):
            raise ValueError("nome de tabela invalido")
        return f'"{self._schema}"."{name}"'

    @contextmanager
    def _transaction(self) -> Iterator[Cursor]:
        conn = self._factory()
        cursor = conn.cursor()
        try:
            yield cursor
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            close_cursor = getattr(cursor, "close", None)
            if callable(close_cursor):
                close_cursor()
            if self._close_connections:
                conn.close()

    @staticmethod
    def _value(row: Any, key: str, position: int) -> Any:
        if isinstance(row, Mapping):
            return row[key]
        try:
            return row[key]
        except (TypeError, KeyError, IndexError):
            return row[position]

    def _scope(self) -> tuple[str, str]:
        return self.tenant_id, self.agent_id

    def ingest(self, envelope: NormalizedEnvelope) -> IngestResult:
        """Persist dedupe, contact, identity, thread, message and events atomically."""
        if (envelope.channel != envelope.identity.channel or
                envelope.account_id != envelope.identity.account_id):
            raise ValueError("envelope e identidade pertencem a canais/contas diferentes")
        inbound = self._table("sac_inbound_events")
        contacts = self._table("sac_contacts")
        identities = self._table("sac_identities")
        threads = self._table("sac_threads")
        messages = self._table("sac_messages")
        domain_events = self._table("sac_domain_events")
        outbox = self._table("sac_outbox")
        origins = self._table("sac_origins")
        scope = self._scope()
        with self._transaction() as cur:
            cur.execute(
                f"INSERT INTO {inbound} "
                "(id,tenant_id,agent_id,dedupe_key,provider_event_id,channel,payload,received_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s) "
                "ON CONFLICT (tenant_id,agent_id,dedupe_key) DO NOTHING RETURNING id",
                (envelope.event_id, *scope, envelope.dedupe_key, envelope.provider_event_id,
                 envelope.channel, self._json(envelope.to_dict()), envelope.received_at),
            )
            if cur.fetchone() is None:
                return IngestResult(False)

            # Serialize first creation of a channel identity without a table-wide lock.
            identity_key = "\x1f".join((*scope, envelope.identity.canonical_key))
            cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (identity_key,))
            cur.execute(
                f"SELECT id,contact_id FROM {identities} WHERE tenant_id=%s AND agent_id=%s "
                "AND channel=%s AND account_id=%s AND external_user_id=%s FOR UPDATE",
                (*scope, envelope.identity.channel, envelope.identity.account_id,
                 envelope.identity.external_user_id),
            )
            identity = cur.fetchone()
            if identity is None:
                contact_id, identity_id = self._id("ct"), self._id("id")
                cur.execute(
                    f"INSERT INTO {contacts} (id,tenant_id,agent_id,display_name,pipeline_stage) "
                    "VALUES (%s,%s,%s,%s,%s)",
                    (contact_id, *scope, envelope.identity.display_name, self.pipeline.stages[0]),
                )
                cur.execute(
                    f"INSERT INTO {identities} "
                    "(id,tenant_id,agent_id,contact_id,channel,account_id,external_user_id,display_name) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                    (identity_id, *scope, contact_id, envelope.identity.channel,
                     envelope.identity.account_id, envelope.identity.external_user_id,
                     envelope.identity.display_name),
                )
            else:
                identity_id = str(self._value(identity, "id", 0))
                contact_id = str(self._value(identity, "contact_id", 1))

            # One stable thread per channel identity/account. external_thread_id is
            # intentionally deterministic when providers do not expose a thread id.
            external_thread_id = envelope.identity.external_user_id
            thread_key = "\x1f".join((*scope, envelope.channel, envelope.account_id,
                                      external_thread_id))
            cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (thread_key,))
            cur.execute(
                f"SELECT id FROM {threads} WHERE tenant_id=%s AND agent_id=%s AND identity_id=%s "
                "AND channel=%s AND account_id=%s AND external_thread_id=%s FOR UPDATE",
                (*scope, identity_id, envelope.channel, envelope.account_id, external_thread_id),
            )
            thread = cur.fetchone()
            if thread is None:
                conversation_id = self._id("cv")
                cur.execute(
                    f"INSERT INTO {threads} "
                    "(id,tenant_id,agent_id,identity_id,channel,account_id,external_thread_id) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (conversation_id, *scope, identity_id, envelope.channel,
                     envelope.account_id, external_thread_id),
                )
            else:
                conversation_id = str(self._value(thread, "id", 0))

            message_id = self._id("msg")
            cur.execute(
                f"INSERT INTO {messages} "
                "(id,tenant_id,agent_id,thread_id,event_id,direction,provider_event_id,occurred_at,body) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                (message_id, *scope, conversation_id, envelope.event_id, envelope.direction,
                 envelope.provider_event_id, envelope.occurred_at, self._json(envelope.message)),
            )
            if envelope.acquisition is not None:
                cur.execute(
                    f"INSERT INTO {origins} "
                    "(id,tenant_id,agent_id,contact_id,message_id,data) "
                    "VALUES (%s,%s,%s,%s,%s,%s::jsonb) "
                    "ON CONFLICT (tenant_id,agent_id,message_id) DO NOTHING",
                    (self._id("src"), *scope, contact_id, message_id,
                     self._json(envelope.acquisition)),
                )
            self._tag(cur, contact_id, f"canal:{envelope.channel}", "automation")
            if envelope.acquisition:
                for key in ("source", "origin", "platform", "campaign"):
                    value = envelope.acquisition.get(key)
                    if isinstance(value, str) and value.strip():
                        self._tag(cur, contact_id,
                                  f"origem:{key}:{value.strip().casefold()}", "automation")
            payload = self._json({"event_id": envelope.event_id, "contact_id": contact_id,
                                  "message_id": message_id, "conversation_id": conversation_id,
                                  "channel": envelope.channel})
            cur.execute(
                f"INSERT INTO {domain_events} "
                "(id,tenant_id,agent_id,event_type,aggregate_id,payload) "
                "VALUES (%s,%s,%s,'message.received',%s,%s::jsonb)",
                (self._id("evt"), *scope, conversation_id, payload),
            )
            cur.execute(
                f"INSERT INTO {outbox} "
                "(id,tenant_id,agent_id,topic,aggregate_id,payload,status,max_attempts,available_at) "
                "VALUES (%s,%s,%s,'message.received',%s,%s::jsonb,'pending',%s,now())",
                (self._id("ob"), *scope, message_id, payload, self.max_attempts),
            )
            cur.execute(
                f"UPDATE {inbound} SET processed_at=now() WHERE tenant_id=%s AND agent_id=%s AND id=%s",
                (*scope, envelope.event_id),
            )
            return IngestResult(True, contact_id, identity_id, conversation_id, message_id)

    def link_identity(self, contact_id: str, identity: ChannelIdentity) -> str:
        contacts, identities = self._table("sac_contacts"), self._table("sac_identities")
        scope = self._scope()
        with self._transaction() as cur:
            cur.execute(f"SELECT id FROM {contacts} WHERE tenant_id=%s AND agent_id=%s AND id=%s "
                        "AND merged_into IS NULL FOR UPDATE", (*scope, contact_id))
            if cur.fetchone() is None:
                raise KeyError("contato inexistente")
            key = "\x1f".join((*scope, identity.canonical_key))
            cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (key,))
            cur.execute(f"SELECT id,contact_id FROM {identities} WHERE tenant_id=%s AND agent_id=%s "
                        "AND channel=%s AND account_id=%s AND external_user_id=%s FOR UPDATE",
                        (*scope, identity.channel, identity.account_id, identity.external_user_id))
            row = cur.fetchone()
            if row:
                if str(self._value(row, "contact_id", 1)) != contact_id:
                    raise ValueError("identidade ja ligada a outro contato")
                return str(self._value(row, "id", 0))
            identity_id = self._id("id")
            cur.execute(f"INSERT INTO {identities} "
                        "(id,tenant_id,agent_id,contact_id,channel,account_id,external_user_id,display_name) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                        (identity_id, *scope, contact_id, identity.channel, identity.account_id,
                         identity.external_user_id, identity.display_name))
            self._emit(cur, "identity.linked", contact_id,
                       {"identity_id": identity_id, "channel": identity.channel,
                        "account_id": identity.account_id, "actor": "explicit"})
            return identity_id

    def advance_pipeline(self, contact_id: str, target_stage: str) -> str:
        self.pipeline.rank(target_stage)
        contacts = self._table("sac_contacts")
        scope = self._scope()
        with self._transaction() as cur:
            cur.execute(f"SELECT pipeline_stage FROM {contacts} WHERE tenant_id=%s AND agent_id=%s "
                        "AND id=%s AND merged_into IS NULL FOR UPDATE", (*scope, contact_id))
            row = cur.fetchone()
            if row is None:
                raise KeyError("contato inexistente")
            current = str(self._value(row, "pipeline_stage", 0))
            resolved = self.pipeline.resolve(current, target_stage)
            if resolved != current:
                cur.execute(f"UPDATE {contacts} SET pipeline_stage=%s,updated_at=now() "
                            "WHERE tenant_id=%s AND agent_id=%s AND id=%s",
                            (resolved, *scope, contact_id))
                cur.execute(f"INSERT INTO {self._table('sac_pipeline_history')} "
                            "(id,tenant_id,agent_id,contact_id,from_stage,to_stage,actor) "
                            "VALUES (%s,%s,%s,%s,%s,%s,'automation')",
                            (self._id("ph"), *scope, contact_id, current, resolved))
                self._emit(cur, "pipeline.advanced", contact_id,
                           {"from": current, "to": resolved, "actor": "automation"})
            return resolved

    def _require_contact(self, cur: Cursor, contact_id: str, *, lock: bool = False) -> Any:
        suffix = " FOR UPDATE" if lock else ""
        cur.execute(f"SELECT id,display_name,pipeline_stage,merged_into FROM {self._table('sac_contacts')} "
                    "WHERE tenant_id=%s AND agent_id=%s AND id=%s" + suffix,
                    (*self._scope(), contact_id))
        row = cur.fetchone()
        if row is None or self._value(row, "merged_into", 3) is not None:
            raise KeyError("contato inexistente ou incorporado")
        return row

    def _tag(self, cur: Cursor, contact_id: str, name: str, source: str) -> bool:
        clean = name.strip().casefold()
        if not clean:
            raise ValueError("tag vazia")
        tags, links = self._table("sac_tags"), self._table("sac_contact_tags")
        cur.execute(f"INSERT INTO {tags} (id,tenant_id,agent_id,name) VALUES (%s,%s,%s,%s) "
                    "ON CONFLICT (tenant_id,agent_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
                    (self._id("tag"), *self._scope(), clean))
        tag_id = str(self._value(cur.fetchone(), "id", 0))
        cur.execute(f"INSERT INTO {links} (tenant_id,agent_id,contact_id,tag_id,source) "
                    "VALUES (%s,%s,%s,%s,%s) ON CONFLICT (tenant_id,agent_id,contact_id,tag_id) "
                    "DO NOTHING RETURNING tag_id", (*self._scope(), contact_id, tag_id, source))
        return cur.fetchone() is not None

    def tag_contact(self, contact_id: str, name: str, *, source: str = "hermes") -> None:
        with self._transaction() as cur:
            self._require_contact(cur, contact_id, lock=True)
            self._tag(cur, contact_id, name, source)
            self._emit(cur, "contact.tagged", contact_id, {"tag": name, "source": source})

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

    def enrich_contact(self, contact_id: str, *, fields: Mapping[str, Any] | None = None,
                       contact_points: Mapping[str, str] | None = None,
                       source: str = "hermes", confidence: float = 1.0) -> None:
        if not source.strip() or not 0 <= confidence <= 1:
            raise ValueError("source/confidence invalidos")
        profiles, points = self._table("sac_profile_fields"), self._table("sac_contact_points")
        with self._transaction() as cur:
            self._require_contact(cur, contact_id, lock=True)
            for name, value in (fields or {}).items():
                clean_name = name.strip()
                if not clean_name:
                    raise ValueError("campo vazio")
                cur.execute(f"INSERT INTO {profiles} "
                            "(id,tenant_id,agent_id,contact_id,field_name,value,source,confidence) "
                            "VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s,%s) "
                            "ON CONFLICT (tenant_id,agent_id,contact_id,field_name,source) DO UPDATE SET "
                            "value=EXCLUDED.value,confidence=EXCLUDED.confidence,observed_at=now()",
                            (self._id("cpf"), *self._scope(), contact_id, clean_name,
                             self._json(value), source, confidence))
            for kind, value in (contact_points or {}).items():
                clean_kind = kind.strip().casefold()
                normalized = self._normalize_point(clean_kind, value)
                cur.execute(f"SELECT contact_id FROM {points} WHERE tenant_id=%s AND agent_id=%s "
                            "AND kind=%s AND normalized_value=%s FOR UPDATE",
                            (*self._scope(), clean_kind, normalized))
                owner = cur.fetchone()
                if owner is not None and str(self._value(owner, "contact_id", 0)) != contact_id:
                    raise ValueError("dado pertence a outro contato; merge explicito necessario")
                cur.execute(f"INSERT INTO {points} "
                            "(id,tenant_id,agent_id,contact_id,kind,value,normalized_value,source) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
                            "ON CONFLICT (tenant_id,agent_id,kind,normalized_value) DO NOTHING",
                            (self._id("cp"), *self._scope(), contact_id, clean_kind,
                             value.strip(), normalized, source))
            self._emit(cur, "contact.enriched", contact_id,
                       {"fields": sorted((fields or {}).keys()),
                        "contact_points": sorted((contact_points or {}).keys()), "source": source})

    def merge_contacts(self, source_contact_id: str, target_contact_id: str, *,
                       actor: str, reason: str) -> str:
        """Explicit, audited merge; never infers identity from names or contact data."""
        if source_contact_id == target_contact_id:
            raise ValueError("origem e destino devem ser diferentes")
        if not actor.strip() or not reason.strip():
            raise ValueError("actor e reason sao obrigatorios")
        contacts = self._table("sac_contacts")
        identities = self._table("sac_identities")
        points = self._table("sac_contact_points")
        profiles = self._table("sac_profile_fields")
        links = self._table("sac_contact_tags")
        merges = self._table("sac_contact_merges")
        scope = self._scope()
        # Stable lock order prevents two opposite merges from deadlocking.
        first, second = sorted((source_contact_id, target_contact_id))
        with self._transaction() as cur:
            self._require_contact(cur, first, lock=True)
            self._require_contact(cur, second, lock=True)
            cur.execute(f"SELECT count(*) AS n FROM {identities} WHERE tenant_id=%s AND agent_id=%s "
                        "AND contact_id=%s", (*scope, source_contact_id))
            identity_count = int(self._value(cur.fetchone(), "n", 0))
            snapshot = {"source_contact_id": source_contact_id,
                        "target_contact_id": target_contact_id,
                        "moved_identities": identity_count}
            cur.execute(f"UPDATE {identities} SET contact_id=%s WHERE tenant_id=%s AND agent_id=%s "
                        "AND contact_id=%s", (target_contact_id, *scope, source_contact_id))
            # Identical facts at the target win; non-conflicting facts move.
            cur.execute(f"DELETE FROM {points} s WHERE s.tenant_id=%s AND s.agent_id=%s AND s.contact_id=%s "
                        f"AND EXISTS (SELECT 1 FROM {points} t WHERE t.tenant_id=s.tenant_id "
                        "AND t.agent_id=s.agent_id AND t.contact_id=%s AND t.kind=s.kind "
                        "AND t.normalized_value=s.normalized_value)",
                        (*scope, source_contact_id, target_contact_id))
            cur.execute(f"UPDATE {points} SET contact_id=%s WHERE tenant_id=%s AND agent_id=%s AND contact_id=%s",
                        (target_contact_id, *scope, source_contact_id))
            cur.execute(f"DELETE FROM {profiles} s WHERE s.tenant_id=%s AND s.agent_id=%s AND s.contact_id=%s "
                        f"AND EXISTS (SELECT 1 FROM {profiles} t WHERE t.tenant_id=s.tenant_id "
                        "AND t.agent_id=s.agent_id AND t.contact_id=%s AND t.field_name=s.field_name "
                        "AND t.source=s.source)", (*scope, source_contact_id, target_contact_id))
            cur.execute(f"UPDATE {profiles} SET contact_id=%s WHERE tenant_id=%s AND agent_id=%s AND contact_id=%s",
                        (target_contact_id, *scope, source_contact_id))
            cur.execute(f"INSERT INTO {links} (tenant_id,agent_id,contact_id,tag_id,source) "
                        f"SELECT tenant_id,agent_id,%s,tag_id,source FROM {links} WHERE tenant_id=%s "
                        "AND agent_id=%s AND contact_id=%s ON CONFLICT DO NOTHING",
                        (target_contact_id, *scope, source_contact_id))
            cur.execute(f"DELETE FROM {links} WHERE tenant_id=%s AND agent_id=%s AND contact_id=%s",
                        (*scope, source_contact_id))
            cur.execute(f"UPDATE {contacts} SET merged_into=%s,updated_at=now() WHERE tenant_id=%s "
                        "AND agent_id=%s AND id=%s", (target_contact_id, *scope, source_contact_id))
            merge_id = self._id("merge")
            cur.execute(f"INSERT INTO {merges} "
                        "(id,tenant_id,agent_id,source_contact_id,target_contact_id,actor,reason,snapshot) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                        (merge_id, *scope, source_contact_id, target_contact_id,
                         actor.strip(), reason.strip(), self._json(snapshot)))
            self._emit(cur, "contacts.merged", target_contact_id,
                       {**snapshot, "merge_id": merge_id, "actor": actor.strip(),
                        "reason": reason.strip()})
            return merge_id

    def _emit(self, cur: Cursor, event_type: str, aggregate_id: str,
              payload: Mapping[str, Any]) -> None:
        domain, outbox = self._table("sac_domain_events"), self._table("sac_outbox")
        serialized = self._json(payload)
        cur.execute(f"INSERT INTO {domain} "
                    "(id,tenant_id,agent_id,event_type,aggregate_id,payload) "
                    "VALUES (%s,%s,%s,%s,%s,%s::jsonb)",
                    (self._id("evt"), *self._scope(), event_type, aggregate_id, serialized))
        cur.execute(f"INSERT INTO {outbox} "
                    "(id,tenant_id,agent_id,topic,aggregate_id,payload,status,max_attempts,available_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s::jsonb,'pending',%s,now())",
                    (self._id("ob"), *self._scope(), event_type, aggregate_id,
                     serialized, self.max_attempts))

    def enqueue_outbound(self, *, message_id: str, channel: str, account_id: str,
                         recipient_id: str, text: str, subject: str = "Mensagem") -> bool:
        payload = self._json({"channel": channel, "account_id": account_id,
                              "recipient_id": recipient_id, "text": text,
                              "subject": subject})
        with self._transaction() as cur:
            cur.execute(f"INSERT INTO {self._table('sac_outbox')} "
                        "(id,tenant_id,agent_id,topic,aggregate_id,payload,status,max_attempts,available_at) "
                        "VALUES (%s,%s,%s,'outbound.send',%s,%s::jsonb,'pending',%s,now()) "
                        "ON CONFLICT (tenant_id,agent_id,topic,aggregate_id) "
                        "WHERE topic='outbound.send' DO NOTHING RETURNING id",
                        (self._id("ob"), *self._scope(), message_id, payload, self.max_attempts))
            return cur.fetchone() is not None

    def hermes_context(self, message_id: str) -> dict[str, Any]:
        """Return a secret-free CRM snapshot, constrained to the bound scope."""
        scope = self._scope()
        with self._transaction() as cur:
            cur.execute(
                f"SELECT m.thread_id,i.contact_id,c.display_name,c.pipeline_stage "
                f"FROM {self._table('sac_messages')} m "
                f"JOIN {self._table('sac_threads')} t ON t.tenant_id=m.tenant_id AND t.agent_id=m.agent_id AND t.id=m.thread_id "
                f"JOIN {self._table('sac_identities')} i ON i.tenant_id=t.tenant_id AND i.agent_id=t.agent_id AND i.id=t.identity_id "
                f"JOIN {self._table('sac_contacts')} c ON c.tenant_id=i.tenant_id AND c.agent_id=i.agent_id AND c.id=i.contact_id "
                "WHERE m.tenant_id=%s AND m.agent_id=%s AND m.id=%s",
                (*scope, message_id),
            )
            base = cur.fetchone()
            if base is None:
                raise KeyError("mensagem inexistente")
            thread_id = str(self._value(base, "thread_id", 0))
            contact_id = str(self._value(base, "contact_id", 1))
            cur.execute(f"SELECT channel,account_id,external_user_id,display_name "
                        f"FROM {self._table('sac_identities')} WHERE tenant_id=%s AND agent_id=%s "
                        "AND contact_id=%s ORDER BY created_at,id", (*scope, contact_id))
            identities = [self._row_dict(row, ("channel", "account_id", "external_user_id", "display_name"))
                          for row in cur.fetchall()]
            cur.execute(f"SELECT t.name FROM {self._table('sac_contact_tags')} ct "
                        f"JOIN {self._table('sac_tags')} t ON t.tenant_id=ct.tenant_id "
                        "AND t.agent_id=ct.agent_id AND t.id=ct.tag_id "
                        "WHERE ct.tenant_id=%s AND ct.agent_id=%s AND ct.contact_id=%s ORDER BY t.name",
                        (*scope, contact_id))
            tags = [str(self._value(row, "name", 0)) for row in cur.fetchall()]
            cur.execute(f"SELECT field_name,value FROM {self._table('sac_profile_fields')} "
                        "WHERE tenant_id=%s AND agent_id=%s AND contact_id=%s "
                        "ORDER BY observed_at,id", (*scope, contact_id))
            data = {}
            for row in cur.fetchall():
                value = self._value(row, "value", 1)
                data[str(self._value(row, "field_name", 0))] = (
                    json.loads(value) if isinstance(value, str) else value)
            cur.execute(f"SELECT kind,value FROM {self._table('sac_contact_points')} "
                        "WHERE tenant_id=%s AND agent_id=%s AND contact_id=%s ORDER BY created_at,id",
                        (*scope, contact_id))
            contact_points = {str(self._value(row, "kind", 0)): self._value(row, "value", 1)
                              for row in cur.fetchall()}
            cur.execute(f"SELECT direction,occurred_at,body FROM {self._table('sac_messages')} "
                        "WHERE tenant_id=%s AND agent_id=%s AND thread_id=%s "
                        "ORDER BY occurred_at DESC,id DESC LIMIT 20", (*scope, thread_id))
            history = []
            for row in cur.fetchall():
                body = self._value(row, "body", 2)
                body = json.loads(body) if isinstance(body, str) else dict(body)
                history.append({"direction": self._value(row, "direction", 0),
                                "occurred_at": self._value(row, "occurred_at", 1),
                                "text": next((body.get(k) for k in ("text", "body", "content")
                                              if isinstance(body.get(k), str)), "")})
            # Origins are append-only. Explicit merges keep source contacts as
            # tombstones, so traverse the merge tree instead of rewriting history.
            cur.execute(f"WITH RECURSIVE family(id) AS ("
                        f"SELECT id FROM {self._table('sac_contacts')} "
                        "WHERE tenant_id=%s AND agent_id=%s AND id=%s UNION ALL "
                        f"SELECT c.id FROM {self._table('sac_contacts')} c JOIN family f "
                        "ON c.merged_into=f.id WHERE c.tenant_id=%s AND c.agent_id=%s) "
                        f"SELECT o.data FROM {self._table('sac_origins')} o JOIN family f "
                        "ON f.id=o.contact_id WHERE o.tenant_id=%s AND o.agent_id=%s "
                        "ORDER BY o.created_at,o.id LIMIT 1",
                        (*scope, contact_id, *scope, *scope))
            source = cur.fetchone()
            acquisition = None
            if source is not None:
                acquisition = self._value(source, "data", 0)
                if isinstance(acquisition, str):
                    acquisition = json.loads(acquisition)
            return {"contact_id": contact_id,
                    "display_name": self._value(base, "display_name", 2),
                    "pipeline_stage": self._value(base, "pipeline_stage", 3),
                    "identities": identities, "tags": tags, "data": data,
                    "contact_points": contact_points, "acquisition": acquisition,
                    "recent_messages": list(reversed(history))}

    @classmethod
    def _row_dict(cls, row: Any, keys: tuple[str, ...]) -> dict[str, Any]:
        return {key: cls._value(row, key, index) for index, key in enumerate(keys)}

    def apply_hermes_decision(self, *, message_id: str, channel: str, account_id: str,
                              recipient_id: str, decision: Mapping[str, Any]) -> bool:
        """Apply one Hermes decision exactly once, including CRM changes and send job."""
        allowed_fields = {"name", "email", "phone", "instagram_username", "notes"}
        text = str(decision.get("text") or "").strip()
        tags = sorted({str(tag).strip().casefold() for tag in (decision.get("tags") or [])
                       if isinstance(tag, str) and 0 < len(tag.strip()) <= 64})[:20]
        raw_data = decision.get("data") or {}
        if not isinstance(raw_data, Mapping):
            raise ValueError("decision.data deve ser objeto")
        extracted = {str(key): str(value).strip() for key, value in raw_data.items()
                     if key in allowed_fields and isinstance(value, (str, int, float))
                     and str(value).strip()}
        requested_stage = decision.get("pipeline_stage")
        if requested_stage is not None:
            self.pipeline.rank(str(requested_stage))
        actions = self._table("sac_crm_actions")
        scope = self._scope()
        with self._transaction() as cur:
            # Serializes replay/racing workers even before the audit row exists.
            cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                        ("\x1f".join((*scope, "hermes", message_id)),))
            cur.execute(f"SELECT id FROM {actions} WHERE tenant_id=%s AND agent_id=%s "
                        "AND action='hermes.decision' AND idempotency_key=%s",
                        (*scope, message_id))
            if cur.fetchone() is not None:
                return False
            cur.execute(
                f"SELECT i.contact_id,c.pipeline_stage FROM {self._table('sac_messages')} m "
                f"JOIN {self._table('sac_threads')} t ON t.tenant_id=m.tenant_id AND t.agent_id=m.agent_id AND t.id=m.thread_id "
                f"JOIN {self._table('sac_identities')} i ON i.tenant_id=t.tenant_id AND i.agent_id=t.agent_id AND i.id=t.identity_id "
                f"JOIN {self._table('sac_contacts')} c ON c.tenant_id=i.tenant_id AND c.agent_id=i.agent_id AND c.id=i.contact_id "
                "WHERE m.tenant_id=%s AND m.agent_id=%s AND m.id=%s FOR UPDATE OF c",
                (*scope, message_id),
            )
            row = cur.fetchone()
            if row is None:
                raise KeyError("mensagem inexistente")
            contact_id = str(self._value(row, "contact_id", 0))
            current = str(self._value(row, "pipeline_stage", 1))
            applied: dict[str, Any] = {"tags": [], "data": {},
                                      "pipeline_stage": current, "outbound": bool(text)}
            for tag in tags:
                if self._tag(cur, contact_id, tag, "hermes"):
                    applied["tags"].append(tag)
            for field, value in extracted.items():
                if field in {"email", "phone", "instagram_username"}:
                    kind = "instagram" if field == "instagram_username" else field
                    normalized = self._normalize_point(kind, value)
                    points = self._table("sac_contact_points")
                    cur.execute(f"SELECT contact_id FROM {points} WHERE tenant_id=%s AND agent_id=%s "
                                "AND kind=%s AND normalized_value=%s FOR UPDATE",
                                (*scope, kind, normalized))
                    owner = cur.fetchone()
                    if owner is not None and str(self._value(owner, "contact_id", 0)) != contact_id:
                        continue
                    cur.execute(f"INSERT INTO {points} "
                                "(id,tenant_id,agent_id,contact_id,kind,value,normalized_value,source) "
                                "VALUES (%s,%s,%s,%s,%s,%s,%s,'hermes') "
                                "ON CONFLICT (tenant_id,agent_id,kind,normalized_value) DO NOTHING",
                                (self._id("cp"), *scope, contact_id, kind, value, normalized))
                else:
                    profiles = self._table("sac_profile_fields")
                    cur.execute(f"INSERT INTO {profiles} "
                                "(id,tenant_id,agent_id,contact_id,field_name,value,source,confidence) "
                                "VALUES (%s,%s,%s,%s,%s,%s::jsonb,'hermes',1.0) "
                                "ON CONFLICT (tenant_id,agent_id,contact_id,field_name,source) DO UPDATE SET "
                                "value=EXCLUDED.value,confidence=EXCLUDED.confidence,observed_at=now()",
                                (self._id("cpf"), *scope, contact_id, field, self._json(value)))
                applied["data"][field] = value
            if requested_stage:
                resolved = self.pipeline.resolve(current, str(requested_stage))
                if resolved != current:
                    cur.execute(f"UPDATE {self._table('sac_contacts')} SET pipeline_stage=%s,updated_at=now() "
                                "WHERE tenant_id=%s AND agent_id=%s AND id=%s",
                                (resolved, *scope, contact_id))
                    cur.execute(f"INSERT INTO {self._table('sac_pipeline_history')} "
                                "(id,tenant_id,agent_id,contact_id,from_stage,to_stage,actor) "
                                "VALUES (%s,%s,%s,%s,%s,%s,'hermes')",
                                (self._id("ph"), *scope, contact_id, current, resolved))
                    applied["pipeline_stage"] = resolved
            if text:
                payload = self._json({"channel": channel, "account_id": account_id,
                                      "recipient_id": recipient_id, "text": text,
                                      "subject": str(decision.get("subject") or "Mensagem")[:200]})
                cur.execute(f"INSERT INTO {self._table('sac_outbox')} "
                            "(id,tenant_id,agent_id,topic,aggregate_id,payload,status,max_attempts,available_at) "
                            "VALUES (%s,%s,%s,'outbound.send',%s,%s::jsonb,'pending',%s,now()) "
                            "ON CONFLICT (tenant_id,agent_id,topic,aggregate_id) "
                            "WHERE topic='outbound.send' DO NOTHING",
                            (self._id("ob"), *scope, message_id, payload, self.max_attempts))
            cur.execute(f"INSERT INTO {actions} "
                        "(id,tenant_id,agent_id,contact_id,action,idempotency_key,payload,actor) "
                        "VALUES (%s,%s,%s,%s,'hermes.decision',%s,%s::jsonb,'hermes')",
                        (self._id("crm"), *scope, contact_id, message_id,
                         self._json({"decision": dict(decision), "applied": applied})))
            return True

    def _claim(self, topic: str) -> Any:
        outbox = self._table("sac_outbox")
        dead = self._table("sac_dead_letters")
        token = uuid4().hex
        with self._transaction() as cur:
            # A worker may die during its final attempt. Once that lease expires,
            # finalize it into the DLQ before looking for more work.
            cur.execute(
                f"INSERT INTO {dead} "
                "(id,tenant_id,agent_id,outbox_id,topic,aggregate_id,payload,attempts,last_error) "
                f"SELECT 'dlq_' || md5(o.id),o.tenant_id,o.agent_id,o.id,o.topic,o.aggregate_id,o.payload,o.attempts,"
                f"coalesce(o.last_error,'lease expirou na tentativa final') FROM {outbox} o "
                "WHERE o.tenant_id=%s AND o.agent_id=%s AND o.topic=%s AND o.status='processing' "
                "AND o.attempts >= o.max_attempts AND o.leased_until <= now() "
                "ON CONFLICT (tenant_id,agent_id,outbox_id) DO NOTHING",
                (*self._scope(), topic),
            )
            cur.execute(
                f"UPDATE {outbox} SET status='dead',lease_token=NULL,leased_until=NULL,"
                "last_error=coalesce(last_error,'lease expirou na tentativa final') "
                "WHERE tenant_id=%s AND agent_id=%s AND topic=%s AND status='processing' "
                "AND attempts >= max_attempts AND leased_until <= now()",
                (*self._scope(), topic),
            )
            cur.execute(
                f"WITH candidate AS (SELECT id FROM {outbox} WHERE tenant_id=%s AND agent_id=%s "
                "AND topic=%s AND status IN ('pending','retry','processing') "
                "AND attempts < max_attempts AND available_at <= now() "
                "AND (status <> 'processing' OR leased_until <= now()) "
                "ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) "
                f"UPDATE {outbox} o SET status='processing',attempts=o.attempts+1,lease_token=%s,"
                "leased_until=now()+(%s * interval '1 second'),last_error=NULL FROM candidate c "
                "WHERE o.id=c.id AND o.tenant_id=%s AND o.agent_id=%s "
                "RETURNING o.id,o.payload,o.attempts,o.lease_token",
                (*self._scope(), topic, token, self.lease_seconds, *self._scope()),
            )
            return cur.fetchone()

    def claim_inbound(self) -> Optional[ClaimedInbound]:
        row = self._claim("message.received")
        if row is None:
            return None
        outbox_id = str(self._value(row, "id", 0))
        payload = self._value(row, "payload", 1)
        payload = json.loads(payload) if isinstance(payload, str) else dict(payload)
        attempts = int(self._value(row, "attempts", 2))
        token = str(self._value(row, "lease_token", 3))
        with self._transaction() as cur:
            cur.execute(
                f"SELECT m.body,t.id,t.channel,t.account_id,i.external_user_id FROM {self._table('sac_messages')} m "
                f"JOIN {self._table('sac_threads')} t ON t.tenant_id=m.tenant_id AND t.agent_id=m.agent_id AND t.id=m.thread_id "
                f"JOIN {self._table('sac_identities')} i ON i.tenant_id=t.tenant_id AND i.agent_id=t.agent_id AND i.id=t.identity_id "
                "WHERE m.tenant_id=%s AND m.agent_id=%s AND m.id=%s",
                (*self._scope(), payload["message_id"]),
            )
            context = cur.fetchone()
            if context is None:
                # Leave the leased item recoverable; caller can fail it explicitly.
                raise RuntimeError("evento inbound sem mensagem associada")
        body = self._value(context, "body", 0)
        body = json.loads(body) if isinstance(body, str) else dict(body)
        text = next((body[k] for k in ("text", "body", "content")
                     if isinstance(body.get(k), str)), "")
        return ClaimedInbound(outbox_id, token, *self._scope(), payload["message_id"],
                              str(self._value(context, "id", 1)),
                              str(self._value(context, "channel", 2)),
                              str(self._value(context, "account_id", 3)),
                              str(self._value(context, "external_user_id", 4)), text, attempts)

    def claim_outbound(self) -> Optional[ClaimedOutbound]:
        row = self._claim("outbound.send")
        if row is None:
            return None
        payload = self._value(row, "payload", 1)
        payload = json.loads(payload) if isinstance(payload, str) else dict(payload)
        return ClaimedOutbound(
            str(self._value(row, "id", 0)), str(self._value(row, "lease_token", 3)),
            *self._scope(), payload["channel"], payload["account_id"],
            payload["recipient_id"], payload["text"], payload.get("subject", "Mensagem"),
            int(self._value(row, "attempts", 2)),
        )

    def claim_domain_event(self) -> Optional[ClaimedDomainEvent]:
        """Claim an internal event without competing with inbound/outbound workers."""
        outbox = self._table("sac_outbox")
        token = uuid4().hex
        scope = self._scope()
        with self._transaction() as cur:
            # Sweep expired final leases for every internal topic in one bounded step.
            cur.execute(
                f"INSERT INTO {self._table('sac_dead_letters')} "
                "(id,tenant_id,agent_id,outbox_id,topic,aggregate_id,payload,attempts,last_error) "
                f"SELECT 'dlq_' || md5(o.id),o.tenant_id,o.agent_id,o.id,o.topic,o.aggregate_id,o.payload,o.attempts,"
                "coalesce(o.last_error,'lease expirou na tentativa final') FROM " + outbox + " o "
                "WHERE o.tenant_id=%s AND o.agent_id=%s "
                "AND o.topic NOT IN ('message.received','outbound.send') AND o.status='processing' "
                "AND o.attempts >= o.max_attempts AND o.leased_until <= now() "
                "ON CONFLICT (tenant_id,agent_id,outbox_id) DO NOTHING", scope)
            cur.execute(
                f"UPDATE {outbox} SET status='dead',lease_token=NULL,leased_until=NULL,"
                "last_error=coalesce(last_error,'lease expirou na tentativa final') "
                "WHERE tenant_id=%s AND agent_id=%s "
                "AND topic NOT IN ('message.received','outbound.send') AND status='processing' "
                "AND attempts >= max_attempts AND leased_until <= now()", scope)
            cur.execute(
                f"WITH candidate AS (SELECT id FROM {outbox} WHERE tenant_id=%s AND agent_id=%s "
                "AND topic NOT IN ('message.received','outbound.send') "
                "AND status IN ('pending','retry','processing') AND attempts < max_attempts "
                "AND available_at <= now() AND (status <> 'processing' OR leased_until <= now()) "
                "ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) "
                f"UPDATE {outbox} o SET status='processing',attempts=o.attempts+1,lease_token=%s,"
                "leased_until=now()+(%s * interval '1 second'),last_error=NULL FROM candidate c "
                "WHERE o.id=c.id AND o.tenant_id=%s AND o.agent_id=%s "
                "RETURNING o.id,o.topic,o.aggregate_id,o.payload,o.attempts,o.lease_token",
                (*scope, token, self.lease_seconds, *scope))
            row = cur.fetchone()
        if row is None:
            return None
        payload = self._value(row, "payload", 3)
        payload = json.loads(payload) if isinstance(payload, str) else dict(payload)
        return ClaimedDomainEvent(str(self._value(row, "id", 0)),
            str(self._value(row, "lease_token", 5)), *scope,
            str(self._value(row, "topic", 1)), str(self._value(row, "aggregate_id", 2)),
            payload, int(self._value(row, "attempts", 4)))

    def finish_inbound(self, item: ClaimedInbound, *, success: bool,
                       error: Optional[str] = None) -> bool:
        self._validate_item_scope(item.tenant_id, item.agent_id)
        return self._finish(item.outbox_id, item.lease_token, success=success, error=error)

    def finish_outbound(self, item: ClaimedOutbound, *, success: bool,
                        error: Optional[str] = None) -> bool:
        self._validate_item_scope(item.tenant_id, item.agent_id)
        return self._finish(item.id, item.lease_token, success=success, error=error)

    def finish_domain_event(self, item: ClaimedDomainEvent, *, success: bool,
                            error: Optional[str] = None) -> bool:
        self._validate_item_scope(item.tenant_id, item.agent_id)
        return self._finish(item.id, item.lease_token, success=success, error=error)

    def _validate_item_scope(self, tenant_id: str, agent_id: str) -> None:
        if (tenant_id, agent_id) != self._scope():
            raise ValueError("item pertence a outro tenant/agente")

    def _finish(self, item_id: str, lease_token: str, *, success: bool,
                error: Optional[str]) -> bool:
        """Finish only the caller's lease; exhausted failures move to the DLQ."""
        outbox, dead = self._table("sac_outbox"), self._table("sac_dead_letters")
        scope = self._scope()
        with self._transaction() as cur:
            cur.execute(f"SELECT topic,aggregate_id,payload,attempts,max_attempts FROM {outbox} "
                        "WHERE tenant_id=%s AND agent_id=%s AND id=%s AND status='processing' "
                        "AND lease_token=%s FOR UPDATE", (*scope, item_id, lease_token))
            row = cur.fetchone()
            if row is None:
                return False
            if success:
                cur.execute(f"UPDATE {outbox} SET status='published',published_at=now(),lease_token=NULL,"
                            "leased_until=NULL,last_error=NULL WHERE tenant_id=%s AND agent_id=%s "
                            "AND id=%s AND lease_token=%s", (*scope, item_id, lease_token))
                return cur.rowcount == 1
            attempts = int(self._value(row, "attempts", 3))
            max_attempts = int(self._value(row, "max_attempts", 4))
            clean_error = (error or "worker failure")[:2000]
            if attempts >= max_attempts:
                dead_payload = self._value(row, "payload", 2)
                if isinstance(dead_payload, str):
                    dead_payload = json.loads(dead_payload)
                cur.execute(f"INSERT INTO {dead} "
                            "(id,tenant_id,agent_id,outbox_id,topic,aggregate_id,payload,attempts,last_error) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) "
                            "ON CONFLICT (tenant_id,agent_id,outbox_id) DO NOTHING",
                            (self._id("dlq"), *scope, item_id,
                             self._value(row, "topic", 0), self._value(row, "aggregate_id", 1),
                             self._json(dead_payload), attempts, clean_error))
                cur.execute(f"UPDATE {outbox} SET status='dead',lease_token=NULL,leased_until=NULL,"
                            "last_error=%s WHERE tenant_id=%s AND agent_id=%s AND id=%s AND lease_token=%s",
                            (clean_error, *scope, item_id, lease_token))
            else:
                delay = min(300, 2 ** attempts)
                cur.execute(f"UPDATE {outbox} SET status='retry',available_at=now()+(%s * interval '1 second'),"
                            "lease_token=NULL,leased_until=NULL,last_error=%s WHERE tenant_id=%s AND agent_id=%s "
                            "AND id=%s AND lease_token=%s",
                            (delay, clean_error, *scope, item_id, lease_token))
            return cur.rowcount == 1

    # ------------------------------------------------------------------
    # Painel do operador.
    #
    # Leitura paginada e escrita auditada, sempre dentro do escopo fixado no
    # construtor. Nenhum metodo desta secao escreve em ``sac_outbox``: acao de
    # painel jamais enfileira envio externo. O unico rastro fora da tabela
    # alvo e a trilha append-only em ``sac_audit_log``.
    # ------------------------------------------------------------------

    PANEL_NOTE_ACTION = "panel.note"
    PANEL_MAX_PAGE = 100
    PANEL_MAX_NOTE_CHARS = 4000
    PANEL_ACTOR_MAX_CHARS = 128
    PANEL_STAGE_ACTION = "panel.contact.stage"
    PANEL_ASSIGN_ACTION = "panel.conversation.assign"
    PANEL_NOTE_AUDIT_ACTION = "panel.conversation.note"

    @staticmethod
    def _panel_iso(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, datetime):
            moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return str(value)

    @staticmethod
    def _panel_json(value: Any) -> dict[str, Any]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                return {}
        return dict(value) if isinstance(value, Mapping) else {}

    @classmethod
    def _panel_text(cls, body: Any) -> str:
        payload = cls._panel_json(body)
        for key in ("text", "body", "content", "caption", "subject"):
            candidate = payload.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate
        return ""

    @staticmethod
    def _panel_encode_cursor(moment: Any, row_id: Any) -> Optional[str]:
        if moment is None or row_id is None:
            return None
        raw = json.dumps([PostgresStore._panel_iso(moment), str(row_id)],
                         separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    @staticmethod
    def _panel_decode_cursor(cursor: Optional[str]) -> Optional[tuple[str, str]]:
        if cursor is None or cursor == "":
            return None
        try:
            padded = cursor + "=" * (-len(cursor) % 4)
            moment, row_id = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        except (ValueError, TypeError, json.JSONDecodeError):
            raise ValueError("cursor invalido")
        if not isinstance(moment, str) or not isinstance(row_id, str) or not row_id:
            raise ValueError("cursor invalido")
        return moment, row_id

    def _panel_limit(self, limit: Any, default: int = 25) -> int:
        try:
            value = int(limit) if limit is not None else default
        except (TypeError, ValueError):
            raise ValueError("limite invalido")
        if value < 1:
            raise ValueError("limite invalido")
        return min(value, self.PANEL_MAX_PAGE)

    @classmethod
    def _panel_actor(cls, actor_id: Any) -> str:
        actor = str(actor_id or "").strip()
        if not actor or len(actor) > cls.PANEL_ACTOR_MAX_CHARS:
            raise ValueError("operador invalido")
        return actor

    def _panel_stage(self, stage: Any) -> str:
        value = str(stage or "").strip()
        self.pipeline.rank(value)
        return value

    def _audit(self, cur: Cursor, *, actor_id: str, action: str, object_type: str,
               object_id: Optional[str], data: Mapping[str, Any],
               actor_type: str = "user") -> Optional[int]:
        """Grava a trilha append-only na mesma transacao da escrita."""
        cur.execute(
            f"INSERT INTO {self._table('sac_audit_log')} "
            "(tenant_id,agent_id,actor_type,actor_id,action,object_type,object_id,data) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb) RETURNING id",
            (*self._scope(), actor_type, actor_id, action, object_type, object_id,
             self._json(dict(data))),
        )
        row = cur.fetchone()
        return None if row is None else int(self._value(row, "id", 0))

    def _panel_require_thread(self, cur: Cursor, conversation_id: str, *,
                              lock: bool = False) -> tuple[str, Optional[str]]:
        """Devolve (contact_id, assigned_to) provando que a conversa e do escopo."""
        cur.execute(
            f"SELECT i.contact_id AS contact_id, t.assigned_to AS assigned_to "
            f"FROM {self._table('sac_threads')} t "
            f"JOIN {self._table('sac_identities')} i ON i.tenant_id=t.tenant_id "
            "AND i.agent_id=t.agent_id AND i.id=t.identity_id "
            "WHERE t.tenant_id=%s AND t.agent_id=%s AND t.id=%s" + (" FOR UPDATE OF t" if lock else ""),
            (*self._scope(), conversation_id),
        )
        row = cur.fetchone()
        if row is None:
            raise KeyError("conversa inexistente")
        assigned = self._value(row, "assigned_to", 1)
        return str(self._value(row, "contact_id", 0)), None if assigned is None else str(assigned)

    def panel_conversations(self, *, limit: int = 25,
                            cursor: Optional[str] = None) -> dict[str, Any]:
        """Pagina de conversas do agente, mais recente primeiro (keyset estavel)."""
        size = self._panel_limit(limit)
        keyset = self._panel_decode_cursor(cursor)
        threads = self._table("sac_threads")
        identities = self._table("sac_identities")
        contacts = self._table("sac_contacts")
        messages = self._table("sac_messages")
        origins = self._table("sac_origins")
        condition = "" if keyset is None else " AND (t.updated_at,t.id) < (%s::timestamptz,%s)"
        params: tuple[Any, ...] = (*self._scope(), *(keyset or ()), size + 1)
        with self._transaction() as cur:
            cur.execute(
                "SELECT t.id AS conversation_id,t.channel AS channel,t.status AS status,"
                "t.assigned_to AS assigned_to,t.bot_paused AS bot_paused,"
                "t.updated_at AS updated_at,c.id AS contact_id,"
                "c.display_name AS contact_name,c.pipeline_stage AS pipeline_stage,"
                "last.direction AS last_direction,last.occurred_at AS last_occurred_at,"
                "last.body AS last_body,last.status AS last_status,"
                "coalesce(total.message_count,0) AS message_count,"
                "origin.data AS origin_data "
                f"FROM {threads} t "
                f"JOIN {identities} i ON i.tenant_id=t.tenant_id AND i.agent_id=t.agent_id "
                "AND i.id=t.identity_id "
                f"JOIN {contacts} c ON c.tenant_id=i.tenant_id AND c.agent_id=i.agent_id "
                "AND c.id=i.contact_id "
                "LEFT JOIN LATERAL (SELECT m.direction,m.occurred_at,m.body,m.status "
                f"FROM {messages} m WHERE m.tenant_id=t.tenant_id AND m.agent_id=t.agent_id "
                "AND m.thread_id=t.id ORDER BY m.occurred_at DESC,m.id DESC LIMIT 1) last ON true "
                "LEFT JOIN LATERAL (SELECT count(*) AS message_count "
                f"FROM {messages} m WHERE m.tenant_id=t.tenant_id AND m.agent_id=t.agent_id "
                "AND m.thread_id=t.id) total ON true "
                "LEFT JOIN LATERAL (SELECT o.data "
                f"FROM {origins} o WHERE o.tenant_id=c.tenant_id AND o.agent_id=c.agent_id "
                "AND o.contact_id=c.id ORDER BY o.created_at,o.id LIMIT 1) origin ON true "
                "WHERE t.tenant_id=%s AND t.agent_id=%s" + condition +
                " ORDER BY t.updated_at DESC,t.id DESC LIMIT %s",
                params,
            )
            rows = list(cur.fetchall())
        page, extra = rows[:size], rows[size:]
        conversations = []
        for row in page:
            updated_at = self._value(row, "updated_at", 5)
            conversation_id = str(self._value(row, "conversation_id", 0))
            assigned = self._value(row, "assigned_to", 3)
            last_at = self._value(row, "last_occurred_at", 10)
            conversations.append({
                "id": conversation_id,
                "channel": self._value(row, "channel", 1),
                "status": self._value(row, "status", 2),
                "assignedTo": None if assigned is None else str(assigned),
                "botPaused": bool(self._value(row, "bot_paused", 4)),
                "updatedAt": self._panel_iso(updated_at),
                "contact": {"id": str(self._value(row, "contact_id", 6)),
                            "displayName": self._value(row, "contact_name", 7),
                            "pipelineStage": self._value(row, "pipeline_stage", 8)},
                "messageCount": int(self._value(row, "message_count", 13) or 0),
                # Origem de aquisicao e canal seguem separados de proposito: o
                # canal fica em "channel" e nunca alimenta a origem.
                "origin": normalize_origin(
                    self._panel_json(self._value(row, "origin_data", 14))).public(),
                "lastMessage": None if last_at is None else {
                    "direction": self._value(row, "last_direction", 9),
                    "status": self._value(row, "last_status", 12),
                    "occurredAt": self._panel_iso(last_at),
                    "text": self._panel_text(self._value(row, "last_body", 11)),
                },
            })
        next_cursor = None
        if extra and page:
            last = page[-1]
            next_cursor = self._panel_encode_cursor(self._value(last, "updated_at", 5),
                                                    self._value(last, "conversation_id", 0))
        return {"conversations": conversations, "nextCursor": next_cursor}

    def panel_messages(self, conversation_id: str, *, limit: int = 50,
                       cursor: Optional[str] = None) -> dict[str, Any]:
        """Mensagens da conversa, mais recentes primeiro, com notas internas."""
        size = self._panel_limit(limit, default=50)
        keyset = self._panel_decode_cursor(cursor)
        messages = self._table("sac_messages")
        actions = self._table("sac_crm_actions")
        condition = "" if keyset is None else " AND (occurred_at,id) < (%s::timestamptz,%s)"
        with self._transaction() as cur:
            self._panel_require_thread(cur, conversation_id)
            cur.execute(
                "SELECT id AS id,direction AS direction,status AS status,"
                f"occurred_at AS occurred_at,body AS body FROM {messages} "
                "WHERE tenant_id=%s AND agent_id=%s AND thread_id=%s" + condition +
                " ORDER BY occurred_at DESC,id DESC LIMIT %s",
                (*self._scope(), conversation_id, *(keyset or ()), size + 1),
            )
            rows = list(cur.fetchall())
            cur.execute(
                "SELECT id AS id,actor AS actor,payload AS payload,created_at AS created_at "
                f"FROM {actions} WHERE tenant_id=%s AND agent_id=%s AND action=%s "
                "AND payload->>'conversation_id'=%s ORDER BY created_at DESC,id DESC LIMIT %s",
                (*self._scope(), self.PANEL_NOTE_ACTION, conversation_id, self.PANEL_MAX_PAGE),
            )
            note_rows = list(cur.fetchall())
        page, extra = rows[:size], rows[size:]
        items = [{
            "id": str(self._value(row, "id", 0)),
            "direction": self._value(row, "direction", 1),
            "status": self._value(row, "status", 2),
            "occurredAt": self._panel_iso(self._value(row, "occurred_at", 3)),
            "text": self._panel_text(self._value(row, "body", 4)),
        } for row in page]
        notes = [{
            "id": str(self._value(row, "id", 0)),
            "actor": self._value(row, "actor", 1),
            "text": self._panel_json(self._value(row, "payload", 2)).get("text", ""),
            "createdAt": self._panel_iso(self._value(row, "created_at", 3)),
        } for row in note_rows]
        next_cursor = None
        if extra and page:
            last = page[-1]
            next_cursor = self._panel_encode_cursor(self._value(last, "occurred_at", 3),
                                                    self._value(last, "id", 0))
        return {"conversationId": conversation_id, "messages": items, "notes": notes,
                "nextCursor": next_cursor}

    def panel_origins(self) -> dict[str, Any]:
        """Origens de aquisicao do agente, agregadas por slug estavel.

        ``contacts`` conta contatos distintos por registro de origem; quando um
        mesmo contato tem origens diferentes ele aparece em cada uma delas.
        """
        with self._transaction() as cur:
            cur.execute(
                "SELECT data AS data,count(DISTINCT contact_id) AS contacts,"
                f"max(created_at) AS last_seen_at FROM {self._table('sac_origins')} "
                "WHERE tenant_id=%s AND agent_id=%s GROUP BY data", self._scope())
            rows = list(cur.fetchall())
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            origin = normalize_origin(self._panel_json(self._value(row, "data", 0)))
            last_seen = self._panel_iso(self._value(row, "last_seen_at", 2))
            entry = grouped.setdefault(origin.slug, {**origin.public(), "contacts": 0,
                                                    "lastSeenAt": None,
                                                    "tenantId": self.tenant_id,
                                                    "agentId": self.agent_id})
            entry["contacts"] += int(self._value(row, "contacts", 1) or 0)
            if last_seen and (entry["lastSeenAt"] or "") < last_seen:
                entry["lastSeenAt"] = last_seen
        origins = sorted(grouped.values(), key=lambda item: (-item["contacts"], item["slug"]))
        return {"origins": origins}

    def panel_pipeline(self) -> dict[str, Any]:
        """Contagem por etapa, respeitando a ordem canonica do PipelineEngine."""
        with self._transaction() as cur:
            cur.execute(
                "SELECT pipeline_stage AS pipeline_stage,count(*) AS contacts "
                f"FROM {self._table('sac_contacts')} "
                "WHERE tenant_id=%s AND agent_id=%s AND merged_into IS NULL "
                "GROUP BY pipeline_stage", self._scope())
            rows = list(cur.fetchall())
        counted = {str(self._value(row, "pipeline_stage", 0)): int(self._value(row, "contacts", 1) or 0)
                   for row in rows}
        ordered = list(self.pipeline.stages)
        ordered.extend(stage for stage in sorted(counted) if stage not in ordered)
        stages = [{"id": stage, "contacts": counted.get(stage, 0)} for stage in ordered]
        return {"stages": stages, "total": sum(item["contacts"] for item in stages)}

    def panel_audit(self, *, limit: int = 50) -> dict[str, Any]:
        """Ultimos registros da trilha; usado para provar a auditoria no painel."""
        size = self._panel_limit(limit, default=50)
        with self._transaction() as cur:
            cur.execute(
                "SELECT id AS id,actor_type AS actor_type,actor_id AS actor_id,"
                "action AS action,object_type AS object_type,object_id AS object_id,"
                f"data AS data,occurred_at AS occurred_at FROM {self._table('sac_audit_log')} "
                "WHERE tenant_id=%s AND agent_id=%s ORDER BY occurred_at DESC,id DESC LIMIT %s",
                (*self._scope(), size))
            rows = list(cur.fetchall())
        return {"entries": [{
            "id": str(self._value(row, "id", 0)),
            "actorType": self._value(row, "actor_type", 1),
            "actorId": self._value(row, "actor_id", 2),
            "action": self._value(row, "action", 3),
            "objectType": self._value(row, "object_type", 4),
            "objectId": self._value(row, "object_id", 5),
            "data": self._panel_json(self._value(row, "data", 6)),
            "occurredAt": self._panel_iso(self._value(row, "occurred_at", 7)),
        } for row in rows]}

    def panel_set_stage(self, contact_id: str, *, stage: str, actor_id: str,
                        reason: Optional[str] = None) -> dict[str, Any]:
        """Move o card de pipeline por decisao humana, registrando antes/depois."""
        target = self._panel_stage(stage)
        actor = self._panel_actor(actor_id)
        clean_reason = (str(reason).strip()[:500] or None) if reason else None
        contacts = self._table("sac_contacts")
        scope = self._scope()
        with self._transaction() as cur:
            cur.execute(f"SELECT pipeline_stage FROM {contacts} WHERE tenant_id=%s AND agent_id=%s "
                        "AND id=%s AND merged_into IS NULL FOR UPDATE", (*scope, contact_id))
            row = cur.fetchone()
            if row is None:
                raise KeyError("contato inexistente")
            before = str(self._value(row, "pipeline_stage", 0))
            changed = before != target
            if changed:
                cur.execute(f"UPDATE {contacts} SET pipeline_stage=%s "
                            "WHERE tenant_id=%s AND agent_id=%s AND id=%s",
                            (target, *scope, contact_id))
                cur.execute(f"INSERT INTO {self._table('sac_pipeline_history')} "
                            "(id,tenant_id,agent_id,contact_id,from_stage,to_stage,actor,reason) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                            (self._id("ph"), *scope, contact_id, before, target, actor,
                             clean_reason))
            audit_id = self._audit(cur, actor_id=actor, action=self.PANEL_STAGE_ACTION,
                                   object_type="contact", object_id=contact_id,
                                   data={"before": {"pipeline_stage": before},
                                         "after": {"pipeline_stage": target},
                                         "changed": changed, "reason": clean_reason})
        return {"contactId": contact_id, "before": before, "after": target,
                "changed": changed, "auditId": None if audit_id is None else str(audit_id)}

    def panel_assign_conversation(self, conversation_id: str, *, assignee: Optional[str],
                                  actor_id: str) -> dict[str, Any]:
        """Atribui ou libera a conversa; ``assignee=None`` remove a atribuicao."""
        actor = self._panel_actor(actor_id)
        target = None if assignee is None else self._panel_actor(assignee)
        threads = self._table("sac_threads")
        scope = self._scope()
        with self._transaction() as cur:
            _, before = self._panel_require_thread(cur, conversation_id, lock=True)
            changed = before != target
            if changed:
                cur.execute(f"UPDATE {threads} SET assigned_to=%s "
                            "WHERE tenant_id=%s AND agent_id=%s AND id=%s",
                            (target, *scope, conversation_id))
            audit_id = self._audit(cur, actor_id=actor, action=self.PANEL_ASSIGN_ACTION,
                                   object_type="thread", object_id=conversation_id,
                                   data={"before": {"assigned_to": before},
                                         "after": {"assigned_to": target}, "changed": changed})
        return {"conversationId": conversation_id, "before": before, "after": target,
                "changed": changed, "auditId": None if audit_id is None else str(audit_id)}

    def panel_add_note(self, conversation_id: str, *, text: str, actor_id: str,
                       idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Nota interna: fica em ``sac_crm_actions`` e nunca vira mensagem de canal."""
        actor = self._panel_actor(actor_id)
        clean = str(text or "").strip()
        if not clean:
            raise ValueError("nota vazia")
        if len(clean) > self.PANEL_MAX_NOTE_CHARS:
            raise ValueError("nota longa demais")
        key = str(idempotency_key or "").strip() or self._id("note")
        if len(key) > 200:
            raise ValueError("chave de idempotencia invalida")
        actions = self._table("sac_crm_actions")
        scope = self._scope()
        with self._transaction() as cur:
            contact_id, _ = self._panel_require_thread(cur, conversation_id)
            payload = {"conversation_id": conversation_id, "text": clean, "channel": "internal"}
            cur.execute(f"INSERT INTO {actions} "
                        "(id,tenant_id,agent_id,contact_id,action,idempotency_key,actor,payload) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb) "
                        "ON CONFLICT (tenant_id,agent_id,action,idempotency_key) DO NOTHING "
                        "RETURNING id",
                        (self._id("crm"), *scope, contact_id, self.PANEL_NOTE_ACTION, key,
                         actor, self._json(payload)))
            row = cur.fetchone()
            if row is None:
                cur.execute(f"SELECT id,created_at FROM {actions} WHERE tenant_id=%s AND agent_id=%s "
                            "AND action=%s AND idempotency_key=%s", (*scope, self.PANEL_NOTE_ACTION, key))
                existing = cur.fetchone()
                note_id = None if existing is None else str(self._value(existing, "id", 0))
                return {"conversationId": conversation_id, "contactId": contact_id,
                        "noteId": note_id, "idempotencyKey": key, "idempotent": True,
                        "auditId": None}
            note_id = str(self._value(row, "id", 0))
            audit_id = self._audit(cur, actor_id=actor, action=self.PANEL_NOTE_AUDIT_ACTION,
                                   object_type="thread", object_id=conversation_id,
                                   data={"before": None,
                                         "after": {"note_id": note_id, "text": clean,
                                                   "contact_id": contact_id},
                                         "changed": True, "idempotency_key": key})
        return {"conversationId": conversation_id, "contactId": contact_id, "noteId": note_id,
                "idempotencyKey": key, "idempotent": False,
                "auditId": None if audit_id is None else str(audit_id)}
