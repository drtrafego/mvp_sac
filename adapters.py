"""Primitivas puras para borda multicanal; nenhuma função faz rede ou I/O."""
from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Any


def verify_meta_signature(raw_body: bytes, signature: str | None, app_secret: str) -> bool:
    if not signature or not signature.startswith("sha256=") or not app_secret:
        return False
    expected = hmac.new(app_secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature[7:], expected)


def verify_shared_secret(received: str | None, expected: str) -> bool:
    return bool(received and expected) and hmac.compare_digest(received, expected)


def verify_meta_challenge(mode: str | None, token: str | None, challenge: str | None, expected: str) -> str | None:
    if mode == "subscribe" and challenge is not None and verify_shared_secret(token, expected):
        return challenge
    return None


def dedupe_key(channel: str, external_event_id: str | None, fallback: dict[str, Any] | None = None) -> str:
    if external_event_id:
        stable = external_event_id
    else:
        stable = hashlib.sha256(json.dumps(fallback or {}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return f"{channel}:{stable}"


@dataclass(frozen=True)
class NormalizedEvent:
    channel: str
    external_event_id: str
    identity: str
    occurred_at: str
    direction: str
    kind: str
    text: str | None
    acquisition_source: str | None
    raw_ref: str

