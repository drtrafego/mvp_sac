"""Worker v2 montado exclusivamente a partir do control plane e secret refs."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping, Protocol
from urllib.parse import urlparse

from .connectors import BrevoConnector, HermesClient, MetaConnector, SMTPConnector
from .postgres_store import ConnectionFactory, PostgresStore
from .runtime_v2 import AgentScope, TenantWorker
from .tenant_registry import SecretResolver


def _mapping(value: Any, field: str) -> Mapping[str, Any]:
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, Mapping):
        raise ValueError(f"{field} deve ser objeto")
    return value


def _required(config: Mapping[str, Any], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"configuracao obrigatoria ausente: {key}")
    return value.strip()


def _https(value: str, field: str) -> str:
    parsed = urlparse(value)
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        raise ValueError(f"{field} deve ser URL HTTPS sem credenciais")
    return value.rstrip("/")


def _boolean(config: Mapping[str, Any], key: str, default: bool) -> bool:
    value = config.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{key} deve ser booleano")
    return value


def _port(config: Mapping[str, Any], default: int) -> int:
    value = config.get("port", default)
    if isinstance(value, bool):
        raise ValueError("port invalida")
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("port invalida") from exc
    if not 1 <= port <= 65535:
        raise ValueError("port fora do limite")
    return port


@dataclass(frozen=True)
class AccountRuntimeConfig:
    account_id: str
    external_account_id: str
    channel: str
    provider: str
    config: Mapping[str, Any]
    access_token_secret_ref: str | None
    api_key_secret_ref: str | None
    smtp_username_secret_ref: str | None
    smtp_password_secret_ref: str | None
    signature_secret_ref: str | None = None
    verify_secret_ref: str | None = None


@dataclass(frozen=True)
class AgentRuntimeConfig:
    hermes: Mapping[str, Any]
    hermes_api_key_secret_ref: str
    accounts: tuple[AccountRuntimeConfig, ...]


class DomainEventSink(Protocol):
    def publish(self, *, tenant_id: str, agent_id: str, topic: str,
                aggregate_id: str, payload: Mapping[str, Any]) -> None: ...


class LocalDomainEventSink:
    """Safe default: acknowledges the outbox copy; sac_domain_events remains durable."""

    def publish(self, **event: Any) -> None:
        # Deliberately no external I/O. The immutable domain-event row is the local sink.
        return None


class PostgresRuntimeConfigRepository:
    """Lê somente configuração ativa no escopo fornecido pelo catálogo."""

    def __init__(self, connection_factory: ConnectionFactory) -> None:
        self._factory = connection_factory

    def load(self, scope: AgentScope) -> AgentRuntimeConfig:
        connection, cursor = self._factory(), None
        try:
            cursor = connection.cursor()
            cursor.execute(
                "SELECT runtime_config,hermes_api_key_secret_ref FROM public.sac_agents "
                "WHERE tenant_id=%s AND id=%s "
                "AND schema_name=%s AND status='active'",
                (scope.tenant_id, scope.agent_id, scope.schema_name),
            )
            row = cursor.fetchone()
            if row is None:
                raise LookupError("agente ativo nao encontrado")
            settings = _mapping(row[0], "agent.runtime_config")
            hermes = _mapping(settings.get("hermes"), "agent.runtime_config.hermes")
            hermes_secret_ref = str(row[1] or "").strip()
            if not hermes_secret_ref:
                raise ValueError("hermes_api_key_secret_ref ausente")
            cursor.execute(
                "SELECT id,external_account_id,channel,provider,config,access_token_secret_ref,"
                "api_key_secret_ref,smtp_username_secret_ref,smtp_password_secret_ref,"
                "signature_secret_ref,verify_secret_ref "
                "FROM public.sac_channel_accounts WHERE tenant_id=%s AND agent_id=%s "
                "AND status='active' ORDER BY id",
                (scope.tenant_id, scope.agent_id),
            )
            accounts = tuple(AccountRuntimeConfig(str(r[0]), str(r[1]), str(r[2]),
                    str(r[3]), _mapping(r[4], "account.config"),
                    str(r[5]).strip() if r[5] else None,
                    str(r[6]).strip() if r[6] else None,
                    str(r[7]).strip() if r[7] else None,
                    str(r[8]).strip() if r[8] else None,
                    str(r[9]).strip() if r[9] else None,
                    str(r[10]).strip() if r[10] else None)
                             for r in cursor.fetchall())
            if not accounts:
                raise LookupError("agente sem conta ativa")
            return AgentRuntimeConfig(hermes, hermes_secret_ref, accounts)
        finally:
            if cursor is not None:
                close = getattr(cursor, "close", None)
                if callable(close): close()
            connection.close()


class ProductionTenantWorker:
    def __init__(self, scope: AgentScope, store: PostgresStore, hermes: HermesClient,
                 connectors: Mapping[str, tuple[str, str, Any]],
                 domain_events: DomainEventSink | None = None) -> None:
        self.scope, self.store, self.hermes = scope, store, hermes
        self.connectors = dict(connectors)
        self.domain_events = domain_events or LocalDomainEventSink()

    def process_inbound_once(self) -> bool:
        item = self.store.claim_inbound()
        if item is None:
            return False
        try:
            context = self.store.hermes_context(item.message_id)
            answer = self.hermes.reply(tenant_id=self.scope.tenant_id, channel=item.channel,
                conversation_id=item.conversation_id, text=item.text, context=context)
            decision = {key: answer.get(key) for key in
                        ("text", "tags", "data", "pipeline_stage", "subject")}
            self.store.apply_hermes_decision(message_id=item.message_id, channel=item.channel,
                account_id=item.account_id, recipient_id=item.recipient_id, decision=decision)
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
            channel, external_account_id, connector = self.connectors[item.account_id]
            if channel != item.channel:
                raise ValueError("canal do job diverge da conta")
            kwargs = {"recipient_id": item.recipient_id, "text": item.text}
            if channel in {"whatsapp", "instagram"}:
                kwargs.update(channel=channel, account_id=external_account_id)
            else:
                kwargs["subject"] = item.subject
            connector.send(**kwargs)
        except Exception as exc:
            self.store.finish_outbound(item, success=False, error=repr(exc))
            raise
        if self.store.finish_outbound(item, success=True) is False:
            raise RuntimeError("lease outbound perdido antes da confirmacao")
        return True

    def publish_domain_once(self) -> bool:
        item = self.store.claim_domain_event()
        if item is None:
            return False
        try:
            self.domain_events.publish(tenant_id=self.scope.tenant_id,
                agent_id=self.scope.agent_id, topic=item.topic,
                aggregate_id=item.aggregate_id, payload=item.payload)
        except Exception as exc:
            self.store.finish_domain_event(item, success=False, error=repr(exc))
            raise
        if self.store.finish_domain_event(item, success=True) is False:
            raise RuntimeError("lease de evento interno perdido antes da confirmacao")
        return True


class ProductionWorkerFactory:
    def __init__(self, repository: PostgresRuntimeConfigRepository,
                 secrets: SecretResolver,
                 domain_events: DomainEventSink | None = None) -> None:
        self.repository, self.secrets = repository, secrets
        self.domain_events = domain_events or LocalDomainEventSink()

    def build(self, scope: AgentScope, store: PostgresStore) -> TenantWorker:
        runtime = self.repository.load(scope)
        hermes_url = _https(_required(runtime.hermes, "base_url"), "hermes.base_url")
        hermes_key = self.secrets.resolve(runtime.hermes_api_key_secret_ref)
        hermes = HermesClient(hermes_url, hermes_key,
                              model=str(runtime.hermes.get("model") or "Hermes"))
        connectors: dict[str, tuple[str, str, Any]] = {}
        for account in runtime.accounts:
            cfg = account.config
            # Também valida segredos de entrada durante readiness/check.
            if account.signature_secret_ref:
                self.secrets.resolve(account.signature_secret_ref)
            if account.verify_secret_ref:
                self.secrets.resolve(account.verify_secret_ref)
            if account.provider == "meta" and account.channel in {"whatsapp", "instagram"}:
                if not account.access_token_secret_ref:
                    raise ValueError("access_token_secret_ref ausente")
                token = self.secrets.resolve(account.access_token_secret_ref)
                graph = _https(str(cfg.get("graph_url") or "https://graph.facebook.com/v23.0"),
                               "account.graph_url")
                connector = MetaConnector(token, graph_url=graph)
            elif account.provider == "brevo" and account.channel == "email":
                if not account.api_key_secret_ref:
                    raise ValueError("api_key_secret_ref ausente")
                key = self.secrets.resolve(account.api_key_secret_ref)
                api_url = _https(str(cfg.get("api_url") or "https://api.brevo.com/v3"),
                                 "account.api_url")
                connector = BrevoConnector(key, _required(cfg, "sender_email"),
                    sender_name=str(cfg.get("sender_name") or "Hermes"), api_url=api_url)
            elif account.provider == "smtp" and account.channel == "email":
                if not account.smtp_password_secret_ref:
                    raise ValueError("smtp_password_secret_ref ausente")
                password = self.secrets.resolve(account.smtp_password_secret_ref)
                username = (self.secrets.resolve(account.smtp_username_secret_ref)
                            if account.smtp_username_secret_ref else None)
                starttls, use_ssl = _boolean(cfg, "starttls", True), _boolean(cfg, "ssl", False)
                if starttls == use_ssl:
                    raise ValueError("SMTP deve usar exatamente um de STARTTLS ou SSL")
                connector = SMTPConnector(_required(cfg, "host"), _port(cfg, 587),
                    username, password, _required(cfg, "sender_email"),
                    sender_name=str(cfg.get("sender_name") or "Hermes"),
                    starttls=starttls, use_ssl=use_ssl)
            else:
                raise ValueError("provedor/canal ativo sem conector suportado")
            connectors[account.account_id] = (account.channel, account.external_account_id, connector)
        return ProductionTenantWorker(scope, store, hermes, connectors, self.domain_events)
