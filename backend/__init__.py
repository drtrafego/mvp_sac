"""Backend persistente da homologacao multicanal."""

from .pipeline import DEFAULT_STAGES, PipelineEngine
from .store import IngestResult, PendingInbound, PendingOutbound, SQLiteStore, Store
from .app import AppConfig, InMemoryEnvelopeSink, WebhookApplication
from .service import AccountConnectorResolver, BackendService, ConnectorTarget
from .postgres_store import ClaimedDomainEvent, ClaimedInbound, ClaimedOutbound, PostgresStore
from .service_store import SQLiteTenantStoreAdapter, TenantBoundStore
from .multitenant_service import BindingServiceFactory, MultiTenantBackend

__all__ = ["AccountConnectorResolver", "AppConfig", "BackendService", "BindingServiceFactory", "ClaimedDomainEvent", "ClaimedInbound",
           "ClaimedOutbound", "DEFAULT_STAGES", "InMemoryEnvelopeSink", "IngestResult",
           "MultiTenantBackend", "PendingInbound", "PendingOutbound", "PipelineEngine",
           "PostgresStore", "SQLiteStore", "SQLiteTenantStoreAdapter", "Store", "ConnectorTarget",
           "TenantBoundStore", "WebhookApplication"]
