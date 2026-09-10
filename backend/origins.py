"""Taxonomia de origem de aquisicao, normalizada no backend.

Origem de aquisicao e canal de conversa sao campos diferentes e continuam
separados aqui: ``AcquisitionOrigin.channel`` descreve por onde aquela origem
entra e **nunca** e preenchido a partir do canal da conversa. Uma recuperacao
de carrinho e origem; o canal continua sendo WhatsApp, Instagram ou e-mail.

O painel consome ``slug`` (estavel, usado em filtro e comparacao) e trata
``label`` apenas como texto de reserva: a camada de apresentacao pode
substituir o rotulo e o icone sem que o backend mude.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Mapping, Optional

CHANNELS = frozenset({"whatsapp", "instagram", "email"})
UNKNOWN_SLUG = "origem_nao_identificada"
UNKNOWN_LABEL = "Origem nao identificada"
MAX_SLUG_CHARS = 64
MAX_TEXT_CHARS = 120

_SLUG_SAFE = re.compile(r"[^a-z0-9]+")


def slugify(value: Any) -> str:
    """Slug estavel, sem acento, seguro para filtro, cache e comparacao."""
    text = str(value or "").strip()
    if not text:
        return ""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return _SLUG_SAFE.sub("_", folded.lower()).strip("_")[:MAX_SLUG_CHARS]


def _text(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text[:MAX_TEXT_CHARS] if text else None


def _channel(value: Any) -> Optional[str]:
    candidate = str(value or "").strip().lower()
    return candidate if candidate in CHANNELS else None


@dataclass(frozen=True)
class AcquisitionOrigin:
    slug: str
    label: str
    channel: Optional[str] = None
    platform: Optional[str] = None
    campaign: Optional[str] = None

    @property
    def identified(self) -> bool:
        return self.slug != UNKNOWN_SLUG

    def public(self) -> dict[str, Any]:
        return {"slug": self.slug, "label": self.label, "channel": self.channel,
                "platform": self.platform, "campaign": self.campaign}


UNKNOWN_ORIGIN = AcquisitionOrigin(UNKNOWN_SLUG, UNKNOWN_LABEL)


def normalize(data: Any) -> AcquisitionOrigin:
    """Converte o JSON de ``sac_origins.data`` no contrato publico de origem.

    Aceita provedores novos sem alteracao de codigo: ``platform`` e ``source``
    formam o slug quando o produtor nao envia um explicito.
    """
    payload = dict(data) if isinstance(data, Mapping) else {}
    platform = _text(payload.get("platform"))
    source = _text(payload.get("source")) or _text(payload.get("origin"))
    campaign = _text(payload.get("campaign"))
    channel = _channel(payload.get("channel"))
    slug = slugify(payload.get("slug"))
    if not slug:
        parts = [part for part in (slugify(platform), slugify(source)) if part]
        slug = "_".join(dict.fromkeys(parts))
    if not slug:
        return UNKNOWN_ORIGIN if not channel else AcquisitionOrigin(
            UNKNOWN_SLUG, UNKNOWN_LABEL, channel)
    label = _text(payload.get("label")) or " · ".join(
        part for part in (platform, source) if part) or slug
    return AcquisitionOrigin(slug, label, channel, platform, campaign)
