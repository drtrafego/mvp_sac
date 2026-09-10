"""Roteamento multi-tenant baseado exclusivamente em endpoint provisionado.

O identificador do tenant nunca e derivado do corpo, query string ou headers do
provedor. O endpoint publico e uma capacidade opaca que resolve internamente
para uma vinculacao previamente cadastrada.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol


@dataclass(frozen=True)
class TenantBinding:
    public_endpoint_id: str
    tenant_id: str
    agent_id: str
    channel: str
    provider: str
    # account_id e a chave interna imutavel; external_account_id e o id enviado
    # pelo provedor e serve exclusivamente para validar/normalizar o webhook.
    account_id: str
    external_account_id: str
    signature_secret_ref: str
    verify_secret_ref: str | None = None
    signature_header: str | None = None
    schema_name: str = ""


class TenantRegistry(Protocol):
    def resolve(self, public_endpoint_id: str) -> TenantBinding | None: ...


class SecretResolver(Protocol):
    def resolve(self, secret_ref: str) -> str: ...


class MappingSecretResolver:
    """Resolver util para testes; producao deve usar cofre/KMS injetado."""

    def __init__(self, secrets: Mapping[str, str]) -> None:
        self._secrets = dict(secrets)

    def resolve(self, secret_ref: str) -> str:
        try:
            secret = self._secrets[secret_ref]
        except KeyError as exc:
            raise LookupError("segredo nao encontrado") from exc
        if not secret:
            raise LookupError("segredo vazio")
        return secret


class PostgresTenantRegistry:
    """Registry Postgres sem conexao global e com factory totalmente injetavel."""

    SQL = """
        SELECT ca.public_endpoint_id, ca.tenant_id, ca.agent_id, ca.channel,
               ca.provider, ca.id AS account_id, ca.external_account_id,
               ca.signature_secret_ref, ca.verify_secret_ref,
               ca.signature_header, ag.schema_name
          FROM public.sac_channel_accounts AS ca
          JOIN public.sac_agents AS ag
            ON ag.tenant_id = ca.tenant_id AND ag.id = ca.agent_id
          JOIN public.sac_tenants AS t ON t.id = ca.tenant_id
         WHERE ca.public_endpoint_id = %s
           AND ca.status = 'active' AND ag.status = 'active'
           AND t.status = 'active'
         LIMIT 1
    """

    def __init__(self, connection_factory: Callable[[], Any]) -> None:
        self._connection_factory = connection_factory

    def resolve(self, public_endpoint_id: str) -> TenantBinding | None:
        if not public_endpoint_id:
            return None
        connection = self._connection_factory()
        try:
            cursor = connection.cursor()
            try:
                cursor.execute(self.SQL, (public_endpoint_id,))
                row = cursor.fetchone()
                if row is None:
                    return None
                if isinstance(row, Mapping):
                    values = {name: row.get(name) for name in TenantBinding.__dataclass_fields__}
                    return TenantBinding(**values)
                return TenantBinding(*row)
            finally:
                cursor.close()
        finally:
            connection.close()
