"""Composition service: webhook -> SQLite -> Hermes -> durable outbound."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from multicanal import NormalizedEnvelope

from .connectors import HermesClient
from .service_store import TenantBoundStore, ensure_bound_store
from .store import SQLiteStore


@dataclass(frozen=True)
class ConnectorTarget:
    connector: Any
    provider_account_id: str


class ConnectorResolver(Protocol):
    def resolve(self, channel: str, internal_account_id: str) -> ConnectorTarget: ...


class AccountConnectorResolver:
    """Maps internal account FKs to provider account ids and credentials."""

    def __init__(self, targets: Mapping[tuple[str, str], ConnectorTarget]) -> None:
        self._targets = dict(targets)

    def resolve(self, channel: str, internal_account_id: str) -> ConnectorTarget:
        try:
            return self._targets[(channel, internal_account_id)]
        except KeyError as exc:
            raise LookupError("conector da conta nao configurado") from exc


class _LegacyConnectorResolver:
    def __init__(self, connectors: Mapping[str, Any]) -> None:
        self._connectors = connectors

    def resolve(self, channel: str, internal_account_id: str) -> ConnectorTarget:
        return ConnectorTarget(self._connectors[channel], internal_account_id)


class BackendService:
    """EnvelopeSink duravel e despachante pequeno, adequado a homologacao."""

    def __init__(self, tenant_id: str, store: SQLiteStore | TenantBoundStore, hermes: HermesClient,
                 connectors: Mapping[str, Any]) -> None:
        if not tenant_id.strip():
            raise ValueError("tenant_id e obrigatorio")
        self.tenant_id = tenant_id
        self.store = ensure_bound_store(store, tenant_id)
        self.hermes, self.connectors = hermes, connectors
        self.connector_resolver = _LegacyConnectorResolver(connectors)

    @classmethod
    def from_bound_store(cls, store: TenantBoundStore, hermes: HermesClient,
                         connectors: Mapping[str, Any] | ConnectorResolver) -> "BackendService":
        instance = cls.__new__(cls)
        instance.tenant_id = store.tenant_id
        instance.store = ensure_bound_store(store, store.tenant_id, agent_id=store.agent_id)
        instance.hermes, instance.connectors = hermes, connectors
        instance.connector_resolver = (connectors if hasattr(connectors, "resolve")
                                       else _LegacyConnectorResolver(connectors))
        return instance

    @staticmethod
    def _text(envelope: NormalizedEnvelope) -> str:
        message = envelope.message
        for key in ("text", "body", "content"):
            value = message.get(key)
            if isinstance(value, str):
                return value
        return ""

    def persist(self, envelopes: tuple[NormalizedEnvelope, ...]) -> None:
        """Contrato EnvelopeSink: somente persiste para permitir ACK rapido."""
        for envelope in envelopes:
            self.store.ingest(envelope)

    def process_inbound_once(self) -> bool:
        """Worker separado: chama Hermes e cria saída idempotente."""
        item = self.store.claim_inbound()
        if item is None:
            return False
        try:
            context = self.store.hermes_context(item.message_id)
            answer = self.hermes.reply(
                tenant_id=self.tenant_id, channel=item.channel,
                conversation_id=item.conversation_id, text=item.text,
                context=context,
            )
            decision = {key: answer.get(key) for key in
                        ("text", "tags", "data", "pipeline_stage", "subject")}
            self.store.apply_hermes_decision(
                message_id=item.message_id,
                channel=item.channel, account_id=item.account_id,
                recipient_id=item.recipient_id, decision=decision,
            )
        except Exception as exc:
            self.store.finish_inbound(item, success=False, error=repr(exc))
            raise
        if self.store.finish_inbound(item, success=True) is False:
            raise RuntimeError("lease inbound perdido antes da confirmacao")
        return True

    def dispatch_once(self) -> bool:
        item = self.store.claim_outbound()
        if item is None:
            return False
        try:
            target = self.connector_resolver.resolve(item.channel, item.account_id)
            connector = target.connector
            kwargs = {"recipient_id": item.recipient_id, "text": item.text}
            if item.channel in {"whatsapp", "instagram"}:
                kwargs.update(channel=item.channel, account_id=target.provider_account_id)
            elif item.channel == "email":
                kwargs["subject"] = item.subject
            connector.send(**kwargs)
        except Exception as exc:
            self.store.finish_outbound(item, success=False, error=repr(exc))
            raise
        if self.store.finish_outbound(item, success=True) is False:
            raise RuntimeError("lease outbound perdido antes da confirmacao")
        return True
