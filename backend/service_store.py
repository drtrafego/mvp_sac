"""Store contracts and adapters used by the tenant-bound backend service."""

from __future__ import annotations

from typing import Any, Mapping, Optional, Protocol

from multicanal import ChannelIdentity, NormalizedEnvelope

from .store import IngestResult, PendingInbound, PendingOutbound, SQLiteStore


class TenantBoundStore(Protocol):
    """Persistence API whose scope is fixed before untrusted input is handled."""

    tenant_bound: bool
    tenant_id: str
    agent_id: str

    def ingest(self, envelope: NormalizedEnvelope) -> IngestResult: ...
    def link_identity(self, contact_id: str, identity: ChannelIdentity) -> str: ...
    def advance_pipeline(self, contact_id: str, target_stage: str) -> str: ...
    def tag_contact(self, contact_id: str, name: str, *, source: str = "hermes") -> None: ...
    def enrich_contact(self, contact_id: str, *, fields: Mapping[str, Any] | None = None,
                       contact_points: Mapping[str, str] | None = None,
                       source: str = "hermes", confidence: float = 1.0) -> None: ...
    def merge_contacts(self, source_contact_id: str, target_contact_id: str, *,
                       actor: str, reason: str) -> str: ...
    def claim_inbound(self) -> Optional[Any]: ...
    def finish_inbound(self, item: Any, *, success: bool,
                       error: Optional[str] = None) -> bool | None: ...
    def hermes_context(self, message_id: str) -> dict[str, Any]: ...
    def apply_hermes_decision(self, *, message_id: str, channel: str, account_id: str,
                              recipient_id: str, decision: Mapping[str, Any]) -> bool: ...
    def claim_outbound(self) -> Optional[Any]: ...
    def finish_outbound(self, item: Any, *, success: bool,
                        error: Optional[str] = None) -> bool | None: ...


class SQLiteTenantStoreAdapter:
    """Keeps SQLite as a compatible single-tenant test/homologation backend."""

    tenant_bound = True

    def __init__(self, store: SQLiteStore, tenant_id: str, *, agent_id: str = "legacy") -> None:
        self.store = store
        self.tenant_id = tenant_id.strip()
        self.agent_id = agent_id.strip()
        if not self.tenant_id or not self.agent_id:
            raise ValueError("tenant_id e agent_id sao obrigatorios")

    def ingest(self, envelope: NormalizedEnvelope) -> IngestResult:
        return self.store.ingest(self.tenant_id, envelope)

    def link_identity(self, contact_id: str, identity: ChannelIdentity) -> str:
        return self.store.link_identity(self.tenant_id, contact_id, identity)

    def advance_pipeline(self, contact_id: str, target_stage: str) -> str:
        return self.store.advance_pipeline(self.tenant_id, contact_id, target_stage)

    def tag_contact(self, contact_id: str, name: str, *, source: str = "hermes") -> None:
        self.store.tag_contact(self.tenant_id, contact_id, name, source=source)

    def enrich_contact(self, contact_id: str, *, fields: Mapping[str, Any] | None = None,
                       contact_points: Mapping[str, str] | None = None,
                       source: str = "hermes", confidence: float = 1.0) -> None:
        self.store.enrich_contact(self.tenant_id, contact_id, fields=fields,
                                  contact_points=contact_points, source=source,
                                  confidence=confidence)

    def merge_contacts(self, source_contact_id: str, target_contact_id: str, *,
                       actor: str, reason: str) -> str:
        return self.store.merge_contacts(self.tenant_id, source_contact_id, target_contact_id,
                                         actor=actor, reason=reason)

    def claim_inbound(self) -> Optional[PendingInbound]:
        return self.store.claim_inbound(self.tenant_id)

    def finish_inbound(self, item: PendingInbound, *, success: bool,
                       error: Optional[str] = None) -> None:
        self.store.finish_inbound(item.outbox_id, success=success, error=error)

    def hermes_context(self, message_id: str) -> dict[str, Any]:
        return self.store.hermes_context(self.tenant_id, message_id)

    def apply_hermes_decision(self, *, message_id: str, channel: str, account_id: str,
                              recipient_id: str, decision: Mapping[str, Any]) -> bool:
        return self.store.apply_hermes_decision(
            tenant_id=self.tenant_id, message_id=message_id, channel=channel,
            account_id=account_id, recipient_id=recipient_id, decision=dict(decision))

    def claim_outbound(self) -> Optional[PendingOutbound]:
        return self.store.claim_outbound(self.tenant_id)

    def finish_outbound(self, item: PendingOutbound, *, success: bool,
                        error: Optional[str] = None) -> None:
        self.store.finish_outbound(item.id, success=success, error=error)


def ensure_bound_store(store: Any, tenant_id: str, *, agent_id: str = "legacy") -> TenantBoundStore:
    """Normalize legacy SQLite or verify an already-bound production store."""
    if getattr(store, "tenant_bound", False):
        if store.tenant_id != tenant_id:
            raise ValueError("store pertence a outro tenant")
        if agent_id != "legacy" and store.agent_id != agent_id:
            raise ValueError("store pertence a outro agente")
        return store
    if isinstance(store, SQLiteStore):
        return SQLiteTenantStoreAdapter(store, tenant_id, agent_id=agent_id)
    raise TypeError("store deve implementar TenantBoundStore ou ser SQLiteStore")

