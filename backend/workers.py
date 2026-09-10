"""Outbox mínima com claim atômico, retry limitado e idempotência."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any, Callable, Mapping, Optional

from .connectors import SendResult


@dataclass
class OutboxItem:
    idempotency_key: str
    channel: str
    account_id: str
    recipient_id: str
    text: str
    subject: str = "Mensagem"
    attempts: int = 0
    available_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    status: str = "pending"
    provider_id: Optional[str] = None
    last_error: Optional[str] = None


class MemoryOutbox:
    """Implementação de teste; produção deve trocar por claim transacional no banco."""

    def __init__(self) -> None:
        self._items: dict[str, OutboxItem] = {}
        self._lock = Lock()

    def enqueue(self, item: OutboxItem) -> bool:
        with self._lock:
            if item.idempotency_key in self._items:
                return False
            self._items[item.idempotency_key] = item
            return True

    def claim(self, now: datetime) -> Optional[OutboxItem]:
        with self._lock:
            for item in self._items.values():
                if item.status in {"pending", "retry"} and item.available_at <= now:
                    item.status = "processing"
                    return item
        return None

    def all(self) -> list[OutboxItem]:
        return list(self._items.values())


class OutboxWorker:
    def __init__(self, outbox: MemoryOutbox, connectors: Mapping[str, Any], *, max_attempts: int = 5,
                 clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> None:
        self.outbox, self.connectors, self.max_attempts, self.clock = outbox, connectors, max_attempts, clock

    def run_once(self) -> Optional[OutboxItem]:
        item = self.outbox.claim(self.clock())
        if item is None:
            return None
        item.attempts += 1
        try:
            connector = self.connectors[item.channel]
            kwargs = {"recipient_id": item.recipient_id, "text": item.text}
            if item.channel in {"whatsapp", "instagram"}:
                kwargs.update(channel=item.channel, account_id=item.account_id)
            elif item.channel == "email":
                kwargs["subject"] = item.subject
            result: SendResult = connector.send(**kwargs)
            item.provider_id, item.status, item.last_error = result.provider_id, "sent", None
        except Exception as exc:
            item.last_error = f"{type(exc).__name__}: {exc}"
            if item.attempts >= self.max_attempts:
                item.status = "failed"
            else:
                item.status = "retry"
                item.available_at = self.clock() + timedelta(seconds=min(300, 2 ** item.attempts))
        return item
