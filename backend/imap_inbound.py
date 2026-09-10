"""Coletor IMAP de entrada com persistência antes de marcar a mensagem como lida."""

from __future__ import annotations

import email
import hashlib
import imaplib
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parsedate_to_datetime, parseaddr
from typing import Callable

from multicanal import build_envelope


def _decoded(value: str | None) -> str:
    return str(make_header(decode_header(value or "")))


def _text(message: Message) -> str:
    if message.is_multipart():
        parts = message.walk()
    else:
        parts = (message,)
    for part in parts:
        if part.get_content_type() != "text/plain" or part.get_content_disposition() == "attachment":
            continue
        payload = part.get_payload(decode=True)
        if payload is not None:
            return payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    return ""


class IMAPInbound:
    """Busca uma mensagem UNSEEN por chamada; adequado ao worker existente."""

    def __init__(self, *, host: str, port: int, username: str, password: str,
                 account_id: str, sink, mailbox: str = "INBOX", use_ssl: bool = True,
                 starttls: bool = False, factory: Callable | None = None) -> None:
        self.host, self.port = host, port
        self.username, self.password = username, password
        self.account_id, self.mailbox = account_id, mailbox
        self.use_ssl, self.starttls, self.sink = use_ssl, starttls, sink
        self.factory = factory

    def _connect(self):
        factory = self.factory or (imaplib.IMAP4_SSL if self.use_ssl else imaplib.IMAP4)
        client = factory(self.host, self.port)
        if self.starttls:
            client.starttls()
        client.login(self.username, self.password)
        return client

    def poll_once(self) -> bool:
        client = self._connect()
        try:
            status, _ = client.select(self.mailbox)
            if status != "OK":
                raise RuntimeError("não foi possível selecionar a caixa IMAP")
            status, data = client.uid("search", None, "UNSEEN")
            if status != "OK" or not data or not data[0]:
                return False
            uid = data[0].split()[0]
            status, fetched = client.uid("fetch", uid, "(RFC822)")
            if status != "OK":
                raise RuntimeError("não foi possível ler a mensagem IMAP")
            raw = next((item[1] for item in fetched if isinstance(item, tuple)), None)
            if not isinstance(raw, bytes):
                raise RuntimeError("resposta IMAP sem mensagem")
            message = email.message_from_bytes(raw)
            sender = parseaddr(_decoded(message.get("From")))[1]
            if not sender:
                raise ValueError("mensagem IMAP sem remetente")
            message_id = (message.get("Message-ID") or "").strip()
            if not message_id:
                message_id = "imap:" + hashlib.sha256(self.account_id.encode() + b"\0" + uid + b"\0" + raw).hexdigest()
            try:
                occurred = parsedate_to_datetime(message.get("Date"))
                if occurred.tzinfo is None:
                    occurred = occurred.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError, OverflowError):
                occurred = datetime.now(timezone.utc)
            envelope = build_envelope(
                channel="email", provider="imap", provider_event_id=message_id,
                account_id=self.account_id, external_user_id=sender, direction="inbound",
                occurred_at=occurred.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                display_name=parseaddr(_decoded(message.get("From")))[0] or None,
                message={"type": "email", "text": _text(message),
                         "subject": _decoded(message.get("Subject")), "message_id": message_id},
            )
            self.sink.persist((envelope,))
            client.uid("store", uid, "+FLAGS", "(\\Seen)")
            return True
        finally:
            try:
                client.logout()
            except Exception:
                pass
