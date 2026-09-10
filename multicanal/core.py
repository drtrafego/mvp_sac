"""Contratos puros da fundação multicanal; sem I/O e sem credenciais."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from hashlib import sha256
from threading import Lock
from typing import Any, Mapping, Optional, Protocol
from uuid import NAMESPACE_URL, uuid5

CHANNELS = frozenset({"whatsapp", "instagram", "email"})
DIRECTIONS = frozenset({"inbound", "outbound"})


def _required(value: str, field: str) -> str:
    clean = value.strip()
    if not clean:
        raise ValueError(f"{field} é obrigatório")
    return clean


def _iso8601(value: str, field: str) -> str:
    clean = _required(value, field)
    candidate = clean[:-1] + "+00:00" if clean.endswith("Z") else clean
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ValueError(f"{field} deve ser ISO-8601") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field} deve conter fuso horário")
    return clean


@dataclass(frozen=True)
class ChannelIdentity:
    channel: str
    account_id: str
    external_user_id: str
    display_name: Optional[str] = None

    def __post_init__(self) -> None:
        if self.channel not in CHANNELS:
            raise ValueError(f"canal não suportado: {self.channel}")
        object.__setattr__(self, "account_id", _required(self.account_id, "account_id"))
        external = _required(self.external_user_id, "external_user_id")
        if self.channel == "email":
            external = external.casefold()
        object.__setattr__(self, "external_user_id", external)

    @property
    def canonical_key(self) -> str:
        return f"{self.channel}:{self.account_id}:{self.external_user_id}"

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["canonical_key"] = self.canonical_key
        return result


@dataclass(frozen=True)
class NormalizedEnvelope:
    version: str
    event_id: str
    provider_event_id: str
    channel: str
    provider: str
    account_id: str
    identity: ChannelIdentity
    direction: str
    occurred_at: str
    received_at: str
    message: Mapping[str, Any]
    dedupe_key: str
    acquisition: Optional[Mapping[str, Any]] = None
    raw: Optional[Mapping[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["identity"] = self.identity.to_dict()
        return result


def build_envelope(
    *, channel: str, provider: str, provider_event_id: str, account_id: str,
    external_user_id: str, direction: str, occurred_at: str,
    message: Mapping[str, Any], display_name: Optional[str] = None,
    acquisition: Optional[Mapping[str, Any]] = None,
    raw: Optional[Mapping[str, Any]] = None, received_at: Optional[str] = None,
) -> NormalizedEnvelope:
    if direction not in DIRECTIONS:
        raise ValueError(f"direção não suportada: {direction}")
    provider = _required(provider, "provider")
    provider_event_id = _required(provider_event_id, "provider_event_id")
    account_id = _required(account_id, "account_id")
    if not isinstance(message, Mapping):
        raise ValueError("message deve ser um objeto")
    identity = ChannelIdentity(channel, account_id, external_user_id, display_name)
    occurred_at = _iso8601(occurred_at, "occurred_at")
    received_at = _iso8601(
        received_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "received_at",
    )
    basis = "\x1f".join((channel, provider, account_id, provider_event_id))
    dedupe_key = sha256(basis.encode("utf-8")).hexdigest()
    event_id = str(uuid5(NAMESPACE_URL, "hermes:event:" + basis))
    return NormalizedEnvelope(
        "1.0", event_id, provider_event_id, channel, provider, account_id,
        identity, direction, occurred_at, received_at, dict(message), dedupe_key,
        dict(acquisition) if acquisition is not None else None,
        dict(raw) if raw is not None else None,
    )


class IdempotencyStore(Protocol):
    def claim(self, key: str) -> bool:
        """Retorna True somente na primeira reivindicação atômica da chave."""


class MemoryIdempotencyStore:
    def __init__(self) -> None:
        self._keys: set[str] = set()
        self._lock = Lock()

    def claim(self, key: str) -> bool:
        with self._lock:
            if key in self._keys:
                return False
            self._keys.add(key)
            return True


class IdempotencyGuard:
    def __init__(self, store: Optional[IdempotencyStore] = None) -> None:
        self.store = store or MemoryIdempotencyStore()

    def claim(self, envelope: NormalizedEnvelope) -> bool:
        return self.store.claim(envelope.dedupe_key)


class PersonIdentityIndex:
    """Liga identidades a pessoas apenas por decisão explícita."""

    def __init__(self) -> None:
        self._identity_to_person: dict[str, str] = {}

    def link(self, person_id: str, identity: ChannelIdentity) -> None:
        person_id = _required(person_id, "person_id")
        current = self._identity_to_person.get(identity.canonical_key)
        if current is not None and current != person_id:
            raise ValueError("identidade já ligada a outra pessoa")
        self._identity_to_person[identity.canonical_key] = person_id

    def resolve(self, identity: ChannelIdentity) -> Optional[str]:
        return self._identity_to_person.get(identity.canonical_key)
