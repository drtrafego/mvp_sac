"""Aplicação WSGI sem dependências para receber webhooks.

Não lê ambiente nem abre sockets ao importar. Credenciais e persistência são
sempre injetadas pelo composition root da instalação.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Iterable, Protocol

from adapters import verify_meta_challenge, verify_meta_signature, verify_shared_secret
from multicanal import NormalizedEnvelope, build_envelope


class EnvelopeSink(Protocol):
    def persist(self, envelopes: tuple[NormalizedEnvelope, ...]) -> None:
        """Persiste o lote de forma durável/atômica ou lança uma exceção."""


class InMemoryEnvelopeSink:
    """Sink somente para testes e desenvolvimento local."""

    def __init__(self) -> None:
        self.envelopes: list[NormalizedEnvelope] = []
        self._keys: set[str] = set()
        self._lock = Lock()

    def persist(self, envelopes: tuple[NormalizedEnvelope, ...]) -> None:
        with self._lock:
            for envelope in envelopes:
                if envelope.dedupe_key not in self._keys:
                    self._keys.add(envelope.dedupe_key)
                    self.envelopes.append(envelope)


@dataclass(frozen=True)
class AppConfig:
    meta_app_secret: str
    meta_verify_token: str
    brevo_webhook_secret: str
    brevo_signature_header: str = "X-Brevo-Signature"
    email_account_id: str = "brevo"
    max_body_bytes: int = 1_048_576
    # O contrato de entrada e neutro. "brevo" preserva instalacoes antigas;
    # qualquer provedor pode publicar o mesmo payload canonico em /webhooks/email.
    email_provider: str = "brevo"


def _utc_from_epoch(value: object) -> str:
    try:
        stamp = float(str(value))
    except (TypeError, ValueError):
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z")


def _meta_envelopes(payload: dict) -> Iterable[NormalizedEnvelope]:
    for entry in payload.get("entry", []):
        account_id = str(entry.get("id") or "")
        for change in entry.get("changes", []):
            value = change.get("value") or {}
            whatsapp_account = str((value.get("metadata") or {}).get("phone_number_id") or account_id)
            names = {str(c.get("wa_id")): (c.get("profile") or {}).get("name") for c in value.get("contacts", [])}
            for message in value.get("messages", []):
                sender = str(message.get("from") or "")
                kind = str(message.get("type") or "unknown")
                content = {"type": kind}
                detail = message.get(kind)
                if isinstance(detail, dict):
                    content.update(detail)
                context = message.get("context")
                if isinstance(context, dict):
                    content["context"] = context
                yield build_envelope(
                    channel="whatsapp", provider="meta",
                    provider_event_id=str(message.get("id") or ""),
                    account_id=whatsapp_account, external_user_id=sender,
                    display_name=names.get(sender), direction="inbound",
                    occurred_at=_utc_from_epoch(message.get("timestamp")),
                    message=content, raw={"field": change.get("field"), "message": message},
                )
        for event in entry.get("messaging", []):
            message = event.get("message") or {}
            # Echoes and delivery/read receipts are not new customer input.
            if not message or message.get("is_echo"):
                continue
            sender = str((event.get("sender") or {}).get("id") or "")
            recipient = str((event.get("recipient") or {}).get("id") or account_id)
            content = {"type": "text" if "text" in message else "attachment"}
            if "text" in message:
                content["text"] = message["text"]
            if "attachments" in message:
                content["attachments"] = message["attachments"]
            if "reply_to" in message:
                content["reply_to"] = message["reply_to"]
            referral = event.get("referral") or message.get("referral")
            acquisition = None
            if isinstance(referral, dict):
                acquisition = {
                    "source": referral.get("source"), "type": referral.get("type"),
                    "ad_id": referral.get("ad_id"), "ref": referral.get("ref"),
                    "platform": "instagram",
                }
                acquisition = {k: v for k, v in acquisition.items() if v is not None}
            yield build_envelope(
                channel="instagram", provider="meta",
                provider_event_id=str(message.get("mid") or ""),
                account_id=recipient, external_user_id=sender,
                direction="inbound", occurred_at=_utc_from_epoch(event.get("timestamp", 0) / 1000 if isinstance(event.get("timestamp"), (int, float)) else event.get("timestamp")),
                message=content, acquisition=acquisition, raw={"messaging": event},
            )


def _email_envelope(payload: dict, account_id: str, provider: str) -> NormalizedEnvelope:
    external_id = payload.get("message-id") or payload.get("messageId") or payload.get("id")
    sender = payload.get("email") or payload.get("sender") or payload.get("from")
    if isinstance(sender, dict):
        sender = sender.get("email")
    occurred = payload.get("date") or payload.get("timestamp")
    occurred_at = str(occurred) if isinstance(occurred, str) and "T" in occurred else _utc_from_epoch(occurred)
    text = payload.get("text") or payload.get("textContent") or payload.get("body") or payload.get("subject")
    message = {"type": str(payload.get("event") or "email"), "text": text,
               "subject": payload.get("subject")}
    for key in ("html", "htmlContent", "attachments", "headers", "to", "cc", "replyTo"):
        if key in payload:
            message[key] = payload[key]
    return build_envelope(
        channel="email", provider=provider, provider_event_id=str(external_id or ""),
        account_id=account_id, external_user_id=str(sender or ""), direction="inbound",
        occurred_at=occurred_at,
        message=message, raw={"event": payload},
    )


class WebhookApplication:
    def __init__(self, config: AppConfig, sink: EnvelopeSink) -> None:
        self.config = config
        self.sink = sink

    @staticmethod
    def _reply(start_response, status: str, body: bytes, content_type: str = "application/json"):
        start_response(status, [("Content-Type", content_type), ("Content-Length", str(len(body)))])
        return [body]

    def __call__(self, environ, start_response):
        method, path = environ.get("REQUEST_METHOD", "GET"), environ.get("PATH_INFO", "")
        if method == "GET" and path == "/health":
            return self._reply(start_response, "200 OK", b'{"status":"ok"}')
        if method == "GET" and path == "/webhooks/meta":
            from urllib.parse import parse_qs
            query = parse_qs(environ.get("QUERY_STRING", ""))
            challenge = verify_meta_challenge(
                query.get("hub.mode", [None])[0], query.get("hub.verify_token", [None])[0],
                query.get("hub.challenge", [None])[0], self.config.meta_verify_token,
            )
            if challenge is None:
                return self._reply(start_response, "403 Forbidden", b'{"error":"forbidden"}')
            return self._reply(start_response, "200 OK", challenge.encode(), "text/plain")
        if method != "POST" or path not in {"/webhooks/meta", "/webhooks/email", "/webhooks/brevo"}:
            return self._reply(start_response, "404 Not Found", b'{"error":"not_found"}')

        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            return self._reply(start_response, "400 Bad Request", b'{"error":"bad_length"}')
        if length < 0 or length > self.config.max_body_bytes:
            return self._reply(start_response, "413 Payload Too Large", b'{"error":"too_large"}')
        raw = environ["wsgi.input"].read(length)
        if path == "/webhooks/meta":
            valid = verify_meta_signature(raw, environ.get("HTTP_X_HUB_SIGNATURE_256"), self.config.meta_app_secret)
        else:
            header_key = "HTTP_" + self.config.brevo_signature_header.upper().replace("-", "_")
            valid = verify_shared_secret(environ.get(header_key), self.config.brevo_webhook_secret)
        if not valid:
            return self._reply(start_response, "401 Unauthorized", b'{"error":"invalid_signature"}')
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("payload must be object")
            envelopes = (tuple(_meta_envelopes(payload)) if path.endswith("meta") else
                         (_email_envelope(payload, self.config.email_account_id,
                                          self.config.email_provider),))
            if not envelopes:
                return self._reply(start_response, "200 OK", b'{"status":"ignored"}')
            self.sink.persist(envelopes)
        except (json.JSONDecodeError, ValueError, TypeError, KeyError):
            return self._reply(start_response, "400 Bad Request", b'{"error":"invalid_payload"}')
        except Exception:
            # Sem ACK: o provedor deve repetir a entrega.
            return self._reply(start_response, "503 Service Unavailable", b'{"error":"persistence_failed"}')
        return self._reply(start_response, "200 OK", b'{"status":"persisted"}')
