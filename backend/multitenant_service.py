"""Safe composition and service routing for provisioned tenant bindings."""

from __future__ import annotations

from threading import RLock
from typing import Any, Callable, Mapping

from multicanal import NormalizedEnvelope

from .service import BackendService, ConnectorResolver
from .service_store import TenantBoundStore, ensure_bound_store
from .tenant_registry import TenantBinding


StoreFactory = Callable[[TenantBinding], TenantBoundStore]
HermesFactory = Callable[[TenantBinding], Any]
ConnectorsFactory = Callable[[TenantBinding], Mapping[str, Any] | ConnectorResolver]


class BindingServiceFactory:
    """Build/cache services only from trusted, provisioned TenantBinding values."""

    def __init__(self, store_factory: StoreFactory, hermes_factory: HermesFactory,
                 connectors_factory: ConnectorsFactory) -> None:
        self._store_factory = store_factory
        self._hermes_factory = hermes_factory
        self._connectors_factory = connectors_factory
        self._services: dict[tuple[str, str], BackendService] = {}
        self._schemas: dict[tuple[str, str], str] = {}
        self._lock = RLock()

    def service_for(self, binding: TenantBinding) -> BackendService:
        key = (binding.tenant_id, binding.agent_id)
        with self._lock:
            current = self._services.get(key)
            if current is not None:
                if self._schemas[key] != binding.schema_name:
                    raise ValueError("binding alterou schema de um agente ja carregado")
                return current
            store = ensure_bound_store(self._store_factory(binding), binding.tenant_id,
                                       agent_id=binding.agent_id)
            service = BackendService.from_bound_store(
                store, self._hermes_factory(binding), self._connectors_factory(binding))
            self._services[key] = service
            self._schemas[key] = binding.schema_name
            return service


class MultiTenantBackend:
    """Webhook sink plus explicit worker entry points for one provisioned binding."""

    def __init__(self, services: BindingServiceFactory) -> None:
        self.services = services

    def persist_for_tenant(self, binding: TenantBinding,
                           envelopes: tuple[NormalizedEnvelope, ...]) -> None:
        service = self.services.service_for(binding)
        # Defense in depth: gateway already validates these fields.
        if any(envelope.channel != binding.channel or
               envelope.provider != binding.provider or
               envelope.account_id != binding.account_id for envelope in envelopes):
            raise ValueError("envelope nao pertence ao binding")
        service.persist(envelopes)

    def process_inbound_once(self, binding: TenantBinding) -> bool:
        return self.services.service_for(binding).process_inbound_once()

    def dispatch_once(self, binding: TenantBinding) -> bool:
        return self.services.service_for(binding).dispatch_once()
