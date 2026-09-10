"""API de homologacao, somente leitura, para o piloto AutonomIA.

As consultas usam duas replicas logicas ja existentes na operacao:

* Neon central: conversas do Hermes e CRM dos leads de anuncio;
* banco do Minerador: captacao Google Places, pipeline e outreach por canal.

O processo nao possui rota de escrita, recusa qualquer metodo diferente de
GET/HEAD e abre todas as sessoes PostgreSQL com ``default_transaction_read_only``.
Telefones e e-mails nunca saem completos; corpos de mensagem passam por uma
redacao conservadora antes de serem serializados.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable, Mapping, Protocol, Sequence
from urllib.parse import parse_qs, unquote
from wsgiref.simple_server import make_server


AUTONOMIA_ORG = "AutonomIA"
ADS_PAGE_ID = "109902140539351"
MAX_LIMIT = 100
DEFAULT_LIMIT = 40
SOURCE_IDS = frozenset({"ads", "mining_whatsapp", "mining_email"})
EMAIL_RE = re.compile(r"(?<![\w.+-])([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})(?![\w.-])", re.I)
PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{6,}\d)(?!\w)")


class QueryDatabase(Protocol):
    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]: ...


class ContactedWhatsappCatalog:
    """Contagem do registro operacional atual, sem serializar os contatos."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def count(self) -> int:
        if self.path.is_symlink() or not self.path.is_file() or self.path.stat().st_mode & 0o077:
            raise RuntimeError("registro de abordados ausente ou inseguro")
        payload = json.loads(self.path.read_text())
        if not isinstance(payload, dict):
            raise RuntimeError("registro de abordados invalido")
        return len(payload)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def mask_handle(value: str | None, channel: str) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    if channel == "email" and "@" in value:
        local, domain = value.rsplit("@", 1)
        return f"{local[:1] or '*'}***@{domain}"
    digits = re.sub(r"\D", "", value)
    if digits:
        return f"•••• {digits[-4:]}"
    return "••••"


def redact_text(value: str | None) -> str | None:
    if value is None:
        return None
    text = EMAIL_RE.sub(lambda m: f"{m.group(1)[:1]}***@{m.group(2)}", str(value))

    def redact_phone(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        return f"[telefone •••• {digits[-4:]}]" if len(digits) >= 8 else match.group(0)

    return PHONE_RE.sub(redact_phone, text)


def _dedupe_key(source_id: str, entity_id: str) -> str:
    digest = hashlib.sha256(f"autonomia:{entity_id}".encode()).hexdigest()[:20]
    return f"{source_id}:{digest}"


def _entity_token(entity_id: str) -> str:
    """ID publico irreversivel; session_id legado contem telefone."""
    return hashlib.sha256(f"autonomia:conversation:{entity_id}".encode()).hexdigest()[:24]


def _bounded_limit(raw: str | None) -> int:
    try:
        value = int(raw or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return min(MAX_LIMIT, max(1, value))


@dataclass(frozen=True)
class SourceDefinition:
    id: str
    label: str
    capture_origin: str
    channel: str


SOURCE_DEFINITIONS = (
    SourceDefinition("ads", "Anúncios", "Meta Ads", "whatsapp"),
    SourceDefinition("mining_whatsapp", "Mineração WhatsApp", "Google Places", "whatsapp"),
    SourceDefinition("mining_email", "Mineração E-mail", "Google Places", "email"),
)


class PsycopgReadOnlyDatabase:
    """Conexao curta e fail-closed, sempre em transacao somente leitura."""

    def __init__(self, url_file: str | os.PathLike[str]) -> None:
        self.url_file = Path(url_file)

    def _url(self) -> str:
        path = self.url_file
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("arquivo de conexao ausente ou inseguro")
        if path.stat().st_mode & 0o077:
            raise RuntimeError("arquivo de conexao deve ter modo 0600")
        value = path.read_text().strip()
        if not value.startswith(("postgresql://", "postgres://")):
            raise RuntimeError("conexao PostgreSQL invalida")
        return value

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover - coberto pela imagem
            raise RuntimeError("driver PostgreSQL ausente") from exc
        connection = psycopg.connect(
            self._url(),
            autocommit=True,
            row_factory=dict_row,
            options="-c statement_timeout=10000",
        )
        try:
            with connection.cursor() as cursor:
                # O pooler em transaction mode pode descartar GUCs de sessao.
                # READ ONLY na propria transacao nao depende desse estado.
                cursor.execute("BEGIN TRANSACTION READ ONLY")
                cursor.execute("SET LOCAL statement_timeout = '10s'")
                cursor.execute(sql, tuple(params))
                rows = list(cursor.fetchall())
                cursor.execute("ROLLBACK")
                return rows
        finally:
            try:
                connection.rollback()
            except Exception:
                pass
            connection.close()


class AutonomiaRepository:
    ADS_COUNT_SQL = """
      SELECT count(*)::int AS leads,
             count(*) FILTER (WHERE c.session_id IS NOT NULL)::int AS conversations,
             coalesce(sum(c.message_count) FILTER (WHERE c.session_id IS NOT NULL), 0)::int AS messages,
             count(DISTINCT l.id)::int AS unique_contacts,
             max(coalesce(c.started_at, l.created_at)) AS last_activity
        FROM agente24horas.crm_leads l
        LEFT JOIN LATERAL (
          SELECT c.session_id, c.started_at, c.message_count
            FROM agente24horas.conversations c
           WHERE (l.email IS NOT NULL AND c.chat_id IS NOT NULL
                  AND lower(btrim(l.email)) = lower(btrim(c.chat_id)))
              OR (regexp_replace(coalesce(l.phone,''), '\\D', '', 'g') <> ''
                  AND right(regexp_replace(coalesce(l.phone,''), '\\D', '', 'g'), 8)
                    = right(regexp_replace(coalesce(c.chat_id,''), '\\D', '', 'g'), 8))
           ORDER BY coalesce(c.started_at, c.ended_at) DESC NULLS LAST LIMIT 1
        ) c ON true
       WHERE l.created_via = 'nina_anuncio' OR l.campaign_source = 'nina_anuncio'
    """
    MINING_COUNT_SQL = """
      SELECT t.channel::text AS channel, count(*)::int AS conversations,
             count(*) FILTER (WHERE t.status::text IN ('replied','booked'))::int AS responded,
             coalesce(sum((SELECT count(*) FROM minerador_scrapling.outreach_messages om
                            WHERE om.thread_id=t.id)),0)::int AS messages,
             count(DISTINCT l.id)::int AS unique_contacts,
             max(coalesce(t.last_message_at,t.updated_at,t.created_at)) AS last_activity
        FROM minerador_scrapling.outreach_threads t
        JOIN minerador_scrapling.organization o ON o.id=t.organization_id
        JOIN minerador_scrapling.leads l ON l.id=t.lead_id
       WHERE o.name=%s AND t.deleted_at IS NULL AND l.deleted_at IS NULL
         AND t.channel::text='email'
       GROUP BY t.channel::text
    """
    WHATSAPP_COUNT_SQL = """
      SELECT count(*)::int AS conversations,
             coalesce(sum(c.message_count),0)::int AS messages,
             count(DISTINCT c.chat_id)::int AS unique_contacts,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM agente24horas.messages m
                WHERE m.session_id=c.session_id AND m.role='user'
             ))::int AS responded,
             max(coalesce(c.started_at,c.ended_at)) AS last_activity
        FROM agente24horas.conversations c
       WHERE c.source='outreach' AND c.channel='whatsapp'
    """
    ADS_LIST_SQL = """
      SELECT l.id::text AS entity_id, coalesce(nullif(btrim(l.name),''),
             nullif(btrim(l.company),''),'Contato de anúncio') AS display_name,
             l.phone, l.email, l.company, col.id::text AS pipeline_id,
             col.title AS pipeline_name, l.status,
             c.session_id, coalesce(c.channel,'whatsapp') AS channel,
             coalesce(c.started_at,l.created_at) AS last_activity,
             coalesce(c.message_count,0)::int AS message_count
        FROM agente24horas.crm_leads l
        LEFT JOIN agente24horas.crm_columns col ON col.id=l.column_id
        LEFT JOIN LATERAL (
          SELECT c.session_id,c.channel,c.started_at,c.ended_at,c.message_count
            FROM agente24horas.conversations c
           WHERE (l.email IS NOT NULL AND c.chat_id IS NOT NULL
                  AND lower(btrim(l.email))=lower(btrim(c.chat_id)))
              OR (regexp_replace(coalesce(l.phone,''), '\\D', '', 'g') <> ''
                  AND right(regexp_replace(coalesce(l.phone,''), '\\D', '', 'g'),8)
                    = right(regexp_replace(coalesce(c.chat_id,''), '\\D', '', 'g'),8))
           ORDER BY coalesce(c.started_at,c.ended_at) DESC NULLS LAST LIMIT 1
        ) c ON true
       WHERE l.created_via='nina_anuncio' OR l.campaign_source='nina_anuncio'
       ORDER BY coalesce(c.started_at,l.created_at) DESC NULLS LAST LIMIT %s
    """
    MINING_LIST_SQL = """
      SELECT t.id::text AS entity_id,l.id::text AS lead_id,t.channel::text AS channel,
             coalesce(nullif(btrim(l.display_name),''),nullif(btrim(l.company),''),'Contato minerado') AS display_name,
             l.phone,l.email,l.company,ps.id::text AS pipeline_id,ps.name AS pipeline_name,
             t.status::text AS status,coalesce(t.last_message_at,t.updated_at,t.created_at) AS last_activity,
             (SELECT count(*) FROM minerador_scrapling.outreach_messages om WHERE om.thread_id=t.id)::int AS message_count
        FROM minerador_scrapling.outreach_threads t
        JOIN minerador_scrapling.organization o ON o.id=t.organization_id
        JOIN minerador_scrapling.leads l ON l.id=t.lead_id
        LEFT JOIN minerador_scrapling.pipeline_stages ps ON ps.id=l.pipeline_stage_id
       WHERE o.name=%s AND t.deleted_at IS NULL AND l.deleted_at IS NULL
         AND t.channel::text=%s
       ORDER BY coalesce(t.last_message_at,t.updated_at,t.created_at) DESC NULLS LAST LIMIT %s
    """
    WHATSAPP_LIST_SQL = """
      SELECT c.session_id AS entity_id,
             coalesce(nullif(btrim(crm.name),''),nullif(btrim(c.title),''),'Contato abordado') AS display_name,
             c.chat_id AS phone,NULL::text AS email,crm.company,
             crm.pipeline_id,crm.pipeline_name,coalesce(crm.status,'active') AS status,
             coalesce(c.started_at,c.ended_at) AS last_activity,
             coalesce(c.message_count,0)::int AS message_count
        FROM agente24horas.conversations c
        LEFT JOIN LATERAL (
          SELECT l.name,l.company,l.column_id::text AS pipeline_id,col.title AS pipeline_name,l.status
            FROM agente24horas.crm_leads l
            LEFT JOIN agente24horas.crm_columns col ON col.id=l.column_id
           WHERE (l.email IS NOT NULL AND c.chat_id IS NOT NULL
                  AND lower(btrim(l.email))=lower(btrim(c.chat_id)))
              OR (regexp_replace(coalesce(l.phone,''), '\\D','','g') <> ''
                  AND right(regexp_replace(coalesce(l.phone,''), '\\D','','g'),8)
                    = right(regexp_replace(coalesce(c.chat_id,''), '\\D','','g'),8))
           ORDER BY coalesce(l.first_contact_at,l.created_at) DESC NULLS LAST LIMIT 1
        ) crm ON true
       WHERE c.source='outreach' AND c.channel='whatsapp'
       ORDER BY coalesce(c.started_at,c.ended_at) DESC NULLS LAST LIMIT %s
    """

    def __init__(self, central: QueryDatabase, miner: QueryDatabase,
                 whatsapp_contacted: ContactedWhatsappCatalog | None = None) -> None:
        self.central, self.miner = central, miner
        self.whatsapp_contacted = whatsapp_contacted

    def ready(self) -> bool:
        try:
            files_ready = self.whatsapp_contacted is None or self.whatsapp_contacted.count() >= 0
            return files_ready and bool(self.central.query("SELECT 1 AS ok")) and bool(self.miner.query("SELECT 1 AS ok"))
        except Exception:
            return False

    def overview(self) -> dict[str, Any]:
        ads = (self.central.query(self.ADS_COUNT_SQL) or [{}])[0]
        mining_rows = {row["channel"]: row for row in self.miner.query(self.MINING_COUNT_SQL, (AUTONOMIA_ORG,))}
        whatsapp = (self.central.query(self.WHATSAPP_COUNT_SQL) or [{}])[0]
        if self.whatsapp_contacted is not None:
            whatsapp = {**whatsapp, "leads": self.whatsapp_contacted.count()}
        mining_rows["whatsapp"] = whatsapp
        sources: list[dict[str, Any]] = []
        for definition in SOURCE_DEFINITIONS:
            row = ads if definition.id == "ads" else mining_rows.get(definition.channel, {})
            sources.append({
                "id": definition.id, "label": definition.label,
                "captureOrigin": definition.capture_origin, "channel": definition.channel,
                "leads": int(row.get("leads", row.get("unique_contacts", 0)) or 0),
                "conversations": int(row.get("conversations", 0) or 0),
                "messages": int(row.get("messages", 0) or 0),
                "responded": int(row.get("responded", 0) or 0),
                "uniqueContacts": int(row.get("unique_contacts", 0) or 0),
                "lastActivityAt": _iso(row.get("last_activity")),
            })
        return self._envelope({
            "sources": sources,
            "totals": {
                "leads": sum(x["leads"] for x in sources),
                "conversations": sum(x["conversations"] for x in sources),
                "messages": sum(x["messages"] for x in sources),
                "responded": sum(x["responded"] for x in sources),
            },
        })

    def conversations(self, source: str | None = None, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
        selected = [source] if source in SOURCE_IDS else [d.id for d in SOURCE_DEFINITIONS]
        buckets: dict[str, list[dict[str, Any]]] = {item: [] for item in selected}
        if "ads" in selected:
            buckets["ads"].extend(self._conversation(row, SOURCE_DEFINITIONS[0], row["entity_id"])
                                  for row in self.central.query(self.ADS_LIST_SQL, (limit,)))
        for definition in SOURCE_DEFINITIONS[1:]:
            if definition.id not in selected:
                continue
            if definition.id == "mining_whatsapp":
                result = self.central.query(self.WHATSAPP_LIST_SQL, (limit,))
            else:
                result = self.miner.query(self.MINING_LIST_SQL, (AUTONOMIA_ORG, definition.channel, limit))
            buckets[definition.id].extend(self._conversation(row, definition, row["lead_id"])
                                          if "lead_id" in row else self._conversation(row, definition, row["entity_id"])
                                          for row in result)
        if len(selected) == 1:
            rows = buckets[selected[0]][:limit]
        else:
            # A atividade mais recente de um canal nao pode expulsar os outros
            # do snapshot. Reserva uma cota por fluxo e usa sobras para
            # completar a pagina quando algum deles tem poucos registros.
            quota, remainder = divmod(limit, len(selected))
            rows, leftovers = [], []
            for index, source_id in enumerate(selected):
                take = quota + int(index < remainder)
                bucket = buckets[source_id]
                rows.extend(bucket[:take])
                leftovers.extend(bucket[take:])
            if len(rows) < limit:
                leftovers.sort(key=lambda item: item.get("lastActivityAt") or "", reverse=True)
                rows.extend(leftovers[:limit-len(rows)])
        rows.sort(key=lambda item: item.get("lastActivityAt") or "", reverse=True)
        return self._envelope({"conversations": rows[:limit]})

    def messages(self, conversation_id: str) -> dict[str, Any] | None:
        try:
            source, entity_id = conversation_id.split(":", 1)
        except ValueError:
            return None
        if source == "ads":
            sessions = self.central.query("""
              SELECT c.session_id
                FROM agente24horas.crm_leads l
                JOIN LATERAL (
                  SELECT c.session_id FROM agente24horas.conversations c
                   WHERE (l.email IS NOT NULL AND c.chat_id IS NOT NULL
                          AND lower(btrim(l.email))=lower(btrim(c.chat_id)))
                      OR (regexp_replace(coalesce(l.phone,''), '\\D','','g') <> ''
                          AND right(regexp_replace(coalesce(l.phone,''), '\\D','','g'),8)
                            = right(regexp_replace(coalesce(c.chat_id,''), '\\D','','g'),8))
                   ORDER BY coalesce(c.started_at,c.ended_at) DESC NULLS LAST LIMIT 1
                ) c ON true WHERE l.id::text=%s
            """, (entity_id,))
            if not sessions:
                messages: list[dict[str, Any]] = []
            else:
                messages = self.central.query("""
                  SELECT id,role AS direction,'delivered'::text AS status,NULL::text AS subject,
                         content AS body,ts AS sent_at
                    FROM agente24horas.messages WHERE session_id=%s
                   ORDER BY ts ASC NULLS LAST LIMIT 100
                """, (sessions[0]["session_id"],))
        elif source == "mining_whatsapp":
            rows = self.central.query("""
              SELECT c.session_id,m.id,m.role AS direction,'delivered'::text AS status,
                     NULL::text AS subject,m.content AS body,m.ts AS sent_at
                FROM agente24horas.conversations c
                JOIN agente24horas.messages m ON m.session_id=c.session_id
               WHERE c.source='outreach' AND c.channel='whatsapp'
               ORDER BY c.session_id,m.ts ASC NULLS LAST
            """)
            messages = [row for row in rows
                        if _entity_token(str(row["session_id"])) == entity_id]
        elif source == "mining_email":
            messages = self.miner.query("""
              SELECT om.id::text AS id,om.direction::text AS direction,om.status::text AS status,
                     om.subject,om.body,coalesce(om.sent_at,om.created_at) AS sent_at
                FROM minerador_scrapling.outreach_messages om
                JOIN minerador_scrapling.outreach_threads t ON t.id=om.thread_id
                JOIN minerador_scrapling.organization o ON o.id=t.organization_id
               WHERE o.name=%s AND t.id::text=%s AND t.channel::text=%s AND t.deleted_at IS NULL
               ORDER BY coalesce(om.sent_at,om.created_at) ASC LIMIT 100
            """, (AUTONOMIA_ORG, entity_id, "email"))
        else:
            return None
        clean = self._clean_messages(messages, conversation_id)
        return self._envelope({"conversationId": conversation_id, "messages": clean})

    def messages_many(self, conversations: Sequence[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        """Busca o historico de uma pagina inteira em no maximo duas queries."""
        ads_ids = [str(c["id"]).split(":", 1)[1] for c in conversations if c.get("source") == "ads"]
        whatsapp_tokens = {str(c["id"]).split(":", 1)[1] for c in conversations
                           if c.get("source") == "mining_whatsapp"}
        mining_ids = [str(c["id"]).split(":", 1)[1] for c in conversations
                      if c.get("source") == "mining_email"]
        rows: list[dict[str, Any]] = []
        if ads_ids:
            rows.extend(self.central.query("""
              SELECT 'ads:' || l.id::text AS conversation_id,m.id,m.role AS direction,
                     'delivered'::text AS status,NULL::text AS subject,m.content AS body,m.ts AS sent_at
                FROM agente24horas.crm_leads l
                JOIN LATERAL (
                  SELECT c.session_id FROM agente24horas.conversations c
                   WHERE (l.email IS NOT NULL AND c.chat_id IS NOT NULL
                          AND lower(btrim(l.email))=lower(btrim(c.chat_id)))
                      OR (regexp_replace(coalesce(l.phone,''), '\\D','','g') <> ''
                          AND right(regexp_replace(coalesce(l.phone,''), '\\D','','g'),8)
                            = right(regexp_replace(coalesce(c.chat_id,''), '\\D','','g'),8))
                   ORDER BY coalesce(c.started_at,c.ended_at) DESC NULLS LAST LIMIT 1
                ) c ON true
                JOIN agente24horas.messages m ON m.session_id=c.session_id
               WHERE l.id::text = ANY(%s::text[])
                 AND m.id IN (SELECT m2.id FROM agente24horas.messages m2
                               WHERE m2.session_id=c.session_id ORDER BY m2.ts DESC NULLS LAST LIMIT 30)
               ORDER BY l.id,m.ts ASC NULLS LAST
            """, (ads_ids,)))
        if mining_ids:
            rows.extend(self.miner.query("""
              SELECT 'mining_' || t.channel::text || ':' || t.id::text AS conversation_id,
                     om.id::text AS id,om.direction::text AS direction,om.status::text AS status,
                     om.subject,om.body,coalesce(om.sent_at,om.created_at) AS sent_at
                FROM minerador_scrapling.outreach_threads t
                JOIN minerador_scrapling.organization o ON o.id=t.organization_id
                JOIN minerador_scrapling.outreach_messages om ON om.thread_id=t.id
               WHERE o.name=%s AND t.id::text = ANY(%s::text[]) AND t.deleted_at IS NULL
                 AND om.id IN (SELECT om2.id FROM minerador_scrapling.outreach_messages om2
                                WHERE om2.thread_id=t.id
                                ORDER BY coalesce(om2.sent_at,om2.created_at) DESC LIMIT 30)
               ORDER BY t.id,coalesce(om.sent_at,om.created_at) ASC
            """, (AUTONOMIA_ORG, mining_ids)))
        if whatsapp_tokens:
            whatsapp_rows = self.central.query("""
              SELECT c.session_id,m.id,m.role AS direction,'delivered'::text AS status,
                     NULL::text AS subject,m.content AS body,m.ts AS sent_at
                FROM agente24horas.conversations c
                JOIN agente24horas.messages m ON m.session_id=c.session_id
               WHERE c.source='outreach' AND c.channel='whatsapp'
                 AND m.id IN (SELECT m2.id FROM agente24horas.messages m2
                               WHERE m2.session_id=c.session_id ORDER BY m2.ts DESC NULLS LAST LIMIT 30)
               ORDER BY c.session_id,m.ts ASC NULLS LAST
            """)
            for row in whatsapp_rows:
                token = _entity_token(str(row.pop("session_id")))
                if token in whatsapp_tokens:
                    rows.append({"conversation_id": f"mining_whatsapp:{token}", **row})
        grouped = {str(c["id"]): [] for c in conversations}
        for row in rows:
            conversation_id = str(row["conversation_id"])
            grouped.setdefault(conversation_id, []).extend(self._clean_messages([row], conversation_id))
        return grouped

    @staticmethod
    def _clean_messages(messages: Sequence[Mapping[str, Any]], conversation_id: str) -> list[dict[str, Any]]:
        return [{
            "id": str(row["id"]), "conversationId": conversation_id,
            "direction": "inbound" if str(row.get("direction", "")).lower() in {"user", "inbound"} else "outbound",
            "status": row.get("status"), "subject": redact_text(row.get("subject")),
            "body": redact_text(row.get("body")), "sentAt": _iso(row.get("sent_at")),
        } for row in messages]

    def pipeline(self) -> dict[str, Any]:
        ads = self.central.query("""
          SELECT coalesce(col.id::text,'sem-etapa') AS id,coalesce(col.title,'Sem etapa') AS name,
                 count(*)::int AS leads
            FROM agente24horas.crm_leads l
            LEFT JOIN agente24horas.crm_columns col ON col.id=l.column_id
           WHERE l.created_via='nina_anuncio' OR l.campaign_source='nina_anuncio'
           GROUP BY 1,2 ORDER BY min(coalesce(col."order",999)),2
        """)
        mining = self.miner.query("""
          SELECT t.channel::text AS channel,coalesce(ps.id::text,'sem-etapa') AS id,
                 coalesce(ps.name,'Sem etapa') AS name,count(DISTINCT l.id)::int AS leads
            FROM minerador_scrapling.outreach_threads t
            JOIN minerador_scrapling.organization o ON o.id=t.organization_id
            JOIN minerador_scrapling.leads l ON l.id=t.lead_id
            LEFT JOIN minerador_scrapling.pipeline_stages ps ON ps.id=l.pipeline_stage_id
           WHERE o.name=%s AND t.deleted_at IS NULL AND l.deleted_at IS NULL
             AND t.channel::text='email'
           GROUP BY 1,2,3 ORDER BY 1,3
        """, (AUTONOMIA_ORG,))
        whatsapp = self.central.query("""
          SELECT coalesce(col.id::text,'sem-etapa') AS id,coalesce(col.title,'Sem etapa') AS name,
                 count(*)::int AS leads
            FROM agente24horas.crm_leads l
            LEFT JOIN agente24horas.crm_columns col ON col.id=l.column_id
           WHERE l.created_via='nina_outreach' OR l.campaign_source='nina_outreach'
           GROUP BY 1,2 ORDER BY min(coalesce(col."order",999)),2
        """)
        rows = [{"source": "ads", **row} for row in ads]
        rows.extend({"source": "mining_whatsapp", **row} for row in whatsapp)
        rows.extend({"source": f"mining_{row.pop('channel')}", **row} for row in mining)
        return self._envelope({"pipeline": rows})

    def snapshot(self, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
        overview = self.overview()
        conversations = self.conversations(limit=limit)
        pipeline = self.pipeline()
        overview["conversations"] = conversations["conversations"]
        overview["pipeline"] = pipeline["pipeline"]
        # O painel publico e estatico. Uma busca em lote por banco inclui o
        # historico recente de TODAS as conversas exportadas, sem N+1 queries.
        details = self.messages_many(conversations["conversations"])
        for conversation in conversations["conversations"]:
            recent = details.get(conversation["id"], [])
            conversation["messages"] = [{
                "from": "lead" if msg["direction"] == "inbound" else "agent",
                "text": msg.get("body") or msg.get("subject") or "Mensagem sem texto",
                "at": msg.get("sentAt"),
            } for msg in recent]
        overview["messagesByConversation"] = details
        overview["outboundEnabled"] = False
        return overview

    @staticmethod
    def _conversation(row: Mapping[str, Any], definition: SourceDefinition,
                      dedupe_entity_id: str) -> dict[str, Any]:
        raw_handle = row.get("email") if definition.channel == "email" else row.get("phone")
        entity_id = str(row["entity_id"])
        public_entity_id = _entity_token(entity_id) if definition.id == "mining_whatsapp" else entity_id
        return {
            "id": f"{definition.id}:{public_entity_id}", "source": definition.id,
            "sourceLabel": definition.label, "captureOrigin": definition.capture_origin,
            "channel": definition.channel,
            "contact": {"displayName": row.get("display_name"),
                        "handleMasked": mask_handle(raw_handle, definition.channel),
                        "company": row.get("company")},
            "pipeline": {"id": row.get("pipeline_id") or "sem-etapa",
                         "name": row.get("pipeline_name") or "Sem etapa",
                         "status": row.get("status")},
            "status": row.get("status"), "lastActivityAt": _iso(row.get("last_activity")),
            "messageCount": int(row.get("message_count", 0) or 0),
            "dedupeKey": _dedupe_key(definition.id, dedupe_entity_id), "isReal": True,
        }

    @staticmethod
    def _envelope(payload: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "dataMode": "real", "readOnly": True,
            "customer": {"id": "autonomia", "name": "AutonomIA"},
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "privacy": {"contactHandles": "masked", "messageContent": "redacted",
                        "rawCredentials": "never_exposed"},
            **payload,
        }


class AutonomiaReadOnlyApplication:
    def __init__(self, repository: AutonomiaRepository) -> None:
        self.repository = repository

    def __call__(self, environ, start_response):
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        if method not in {"GET", "HEAD"}:
            return self._reply(start_response, "405 Method Not Allowed",
                               {"error": "read_only"}, method)
        path = str(environ.get("PATH_INFO", ""))
        query = parse_qs(str(environ.get("QUERY_STRING", "")))
        try:
            if path == "/livez":
                return self._reply(start_response, "200 OK", {"status": "ok"}, method)
            if path == "/readyz":
                ready = self.repository.ready()
                return self._reply(start_response, "200 OK" if ready else "503 Service Unavailable",
                                   {"status": "ready" if ready else "unavailable"}, method)
            if path == "/api/v1/autonomia/overview":
                payload = self.repository.overview()
            elif path == "/api/v1/autonomia/conversations":
                source = (query.get("source") or [None])[0]
                if source and source not in SOURCE_IDS:
                    return self._reply(start_response, "400 Bad Request", {"error": "invalid_source"}, method)
                payload = self.repository.conversations(source, _bounded_limit((query.get("limit") or [None])[0]))
            elif path.startswith("/api/v1/autonomia/conversations/") and path.endswith("/messages"):
                conversation_id = unquote(path[len("/api/v1/autonomia/conversations/"):-len("/messages")]).strip("/")
                payload = self.repository.messages(conversation_id)
                if payload is None:
                    return self._reply(start_response, "404 Not Found", {"error": "not_found"}, method)
            elif path == "/api/v1/autonomia/pipeline":
                payload = self.repository.pipeline()
            elif path == "/api/v1/autonomia/snapshot":
                payload = self.repository.snapshot(_bounded_limit((query.get("limit") or [None])[0]))
            else:
                return self._reply(start_response, "404 Not Found", {"error": "not_found"}, method)
            return self._reply(start_response, "200 OK", payload, method)
        except Exception:
            # Nada de str(exc): URLs e dados pessoais podem aparecer no texto do driver.
            return self._reply(start_response, "503 Service Unavailable",
                               {"error": "source_unavailable"}, method)

    @staticmethod
    def _reply(start_response, status: str, payload: Mapping[str, Any], method: str):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_iso).encode()
        headers = [("Content-Type", "application/json; charset=utf-8"),
                   ("Cache-Control", "private, no-store"),
                   ("X-Content-Type-Options", "nosniff"),
                   ("Content-Length", str(len(body) if method != "HEAD" else 0))]
        start_response(status, headers)
        return [] if method == "HEAD" else [body]


def build_from_env(env: Mapping[str, str] = os.environ) -> AutonomiaReadOnlyApplication:
    central_file = env.get("AUTONOMIA_CENTRAL_DATABASE_FILE", "").strip()
    miner_file = env.get("AUTONOMIA_MINER_DATABASE_FILE", "").strip()
    contacted_file = env.get("AUTONOMIA_WHATSAPP_CONTACTED_FILE", "").strip()
    if not central_file or not miner_file or not contacted_file:
        raise ValueError("arquivos de conexao somente leitura sao obrigatorios")
    return AutonomiaReadOnlyApplication(AutonomiaRepository(
        PsycopgReadOnlyDatabase(central_file), PsycopgReadOnlyDatabase(miner_file),
        ContactedWhatsappCatalog(contacted_file)))


def main(argv: list[str] | None = None, env: Mapping[str, str] = os.environ) -> int:
    parser = argparse.ArgumentParser(description="API read-only da homologacao AutonomIA")
    parser.add_argument("command", choices=("server", "check", "snapshot"))
    args = parser.parse_args(argv)
    try:
        app = build_from_env(env)
    except (ValueError, OSError) as exc:
        print(f"configuracao invalida: {exc}", file=os.sys.stderr)
        return 2
    if args.command == "check":
        return 0 if app.repository.ready() else 1
    if args.command == "snapshot":
        print(json.dumps(app.repository.snapshot(), ensure_ascii=False, default=_iso))
        return 0
    host, port = env.get("AUTONOMIA_API_HOST", "127.0.0.1"), int(env.get("AUTONOMIA_API_PORT", "8081"))
    stop = Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    with make_server(host, port, app) as server:
        server.timeout = 1
        while not stop.is_set():
            server.handle_request()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
