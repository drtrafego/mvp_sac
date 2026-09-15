"""Composition root do SAC compartilhado v2 (PostgreSQL, multi-tenant).

Importar este módulo não conecta banco, lê segredos nem abre sockets. O CLI
legado permanece independente em ``backend.cli``.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
from dataclasses import dataclass
from threading import Event
from time import sleep
from typing import Callable, Iterable, Mapping, Protocol
from wsgiref.simple_server import make_server

from multicanal import NormalizedEnvelope

from .multitenant_app import MultiTenantWebhookApplication
from .panel_analytics import AnalyticsCache, DEFAULT_TIMEZONE, MAX_WINDOW_DAYS
from .panel_api import (DisabledPanelApplication, PanelApplication, PanelAgent,
                        PostgresPanelAgentCatalog)
from .panel_auth import OperatorDirectory, SessionStore
from .panel_config import SecretVault, SecretWriteQuota, normalize_webhook_base
from .postgres_store import ConnectionFactory, PostgresStore
from .secret_resolver import DirectorySecretResolver
from .tenant_registry import PostgresTenantRegistry, TenantBinding


@dataclass(frozen=True)
class AgentScope:
    tenant_id: str
    agent_id: str
    schema_name: str


class ActiveAgentCatalog(Protocol):
    def list_active(self) -> tuple[AgentScope, ...]: ...


class TenantWorker(Protocol):
    def process_inbound_once(self) -> bool: ...
    def dispatch_once(self) -> bool: ...
    def publish_domain_once(self) -> bool: ...


class TenantWorkerFactory(Protocol):
    def build(self, scope: AgentScope, store: PostgresStore) -> TenantWorker: ...


class PostgresActiveAgentCatalog:
    SQL = """
        SELECT ag.tenant_id, ag.id, ag.schema_name
          FROM public.sac_agents AS ag
          JOIN public.sac_tenants AS t ON t.id = ag.tenant_id
         WHERE ag.status = 'active' AND t.status = 'active'
         ORDER BY ag.tenant_id, ag.id
    """

    def __init__(self, connection_factory: ConnectionFactory) -> None:
        self._factory = connection_factory

    def list_active(self) -> tuple[AgentScope, ...]:
        connection = self._factory()
        cursor = connection.cursor()
        try:
            cursor.execute(self.SQL)
            rows = cursor.fetchall()
            return tuple(AgentScope(str(row[0]), str(row[1]), str(row[2])) for row in rows)
        finally:
            close = getattr(cursor, "close", None)
            if callable(close):
                close()
            connection.close()


class PostgresStoreFactory:
    def __init__(self, connection_factory: ConnectionFactory) -> None:
        self._connection_factory = connection_factory

    def for_scope(self, scope: AgentScope) -> PostgresStore:
        return PostgresStore(self._connection_factory, tenant_id=scope.tenant_id,
                             agent_id=scope.agent_id, schema=scope.schema_name)

    def for_binding(self, binding: TenantBinding) -> PostgresStore:
        if not binding.schema_name:
            raise ValueError("binding sem schema_name")
        return self.for_scope(AgentScope(binding.tenant_id, binding.agent_id,
                                         binding.schema_name))

    def for_panel_agent(self, agent: PanelAgent) -> PostgresStore:
        """O schema vem do control plane; o painel nunca informa esse valor."""
        if not agent.schema_name:
            raise ValueError("agente sem schema_name")
        return self.for_scope(AgentScope(agent.tenant_id, agent.agent_id, agent.schema_name))


class TenantPostgresSink:
    """Adapta o gateway para PostgresStore mantendo o escopo do registry."""

    def __init__(self, stores: PostgresStoreFactory) -> None:
        self._stores = stores

    def persist_for_tenant(self, binding: TenantBinding,
                           envelopes: tuple[NormalizedEnvelope, ...]) -> None:
        for envelope in envelopes:
            # A conta já foi normalizada pelo gateway para a chave interna.
            if (envelope.account_id != binding.account_id or
                    envelope.identity.account_id != binding.account_id or
                    envelope.channel != binding.channel or
                    envelope.identity.channel != binding.channel or
                    envelope.provider != binding.provider):
                raise ValueError("envelope fora do binding")
        store = self._stores.for_binding(binding)
        for envelope in envelopes:
            store.ingest(envelope)


class MultiTenantWorkerScheduler:
    """Uma rodada justa por agente; nenhum job carrega escopo escolhido pelo payload."""

    def __init__(self, catalog: ActiveAgentCatalog, stores: PostgresStoreFactory,
                 workers: TenantWorkerFactory, *,
                 on_error: Callable[[AgentScope, str, Exception], None] | None = None,
                 fail_fast: bool = False) -> None:
        self.catalog, self.stores, self.workers = catalog, stores, workers
        self.on_error = on_error or self._log_error
        self.fail_fast = fail_fast

    @staticmethod
    def _log_error(scope: AgentScope, phase: str, error: Exception) -> None:
        # Não serializa str(error): exceções de SDKs podem conter credenciais.
        logging.getLogger("sac.worker").error(json.dumps({
            "event": "tenant_worker_error", "tenant_id": scope.tenant_id,
            "agent_id": scope.agent_id, "phase": phase,
            "error_type": type(error).__name__,
        }, separators=(",", ":")))

    def _failed(self, scope: AgentScope, phase: str, error: Exception) -> None:
        self.on_error(scope, phase, error)
        if self.fail_fast:
            raise error

    def run_cycle(self) -> int:
        processed = 0
        for scope in self.catalog.list_active():
            try:
                worker = self.workers.build(scope, self.stores.for_scope(scope))
            except Exception as exc:
                self._failed(scope, "build", exc)
                continue
            try:
                processed += int(worker.process_inbound_once())
            except Exception as exc:
                self._failed(scope, "inbound", exc)
            try:
                processed += int(worker.dispatch_once())
            except Exception as exc:
                self._failed(scope, "outbound", exc)
            publish = getattr(worker, "publish_domain_once", None)
            if callable(publish):
                try:
                    processed += int(publish())
                except Exception as exc:
                    self._failed(scope, "domain", exc)
        return processed


class ReadinessProbe:
    """Readiness real: conexão e objetos mínimos do control plane."""

    SQL = """
        SELECT to_regclass('public.sac_tenants') IS NOT NULL
           AND to_regclass('public.sac_agents') IS NOT NULL
           AND to_regclass('public.sac_channel_accounts') IS NOT NULL
    """

    def __init__(self, connection_factory: ConnectionFactory) -> None:
        self._factory = connection_factory

    def ready(self) -> bool:
        try:
            connection = self._factory()
            cursor = connection.cursor()
            try:
                cursor.execute(self.SQL)
                row = cursor.fetchone()
                return bool(row and row[0])
            finally:
                close = getattr(cursor, "close", None)
                if callable(close):
                    close()
                connection.close()
        except Exception:
            return False


class ProductionReadiness:
    """Inclui banco, catálogo, configurações e todas as secret refs ativas."""

    def __init__(self, database: ReadinessProbe, catalog: ActiveAgentCatalog,
                 stores: PostgresStoreFactory, workers: TenantWorkerFactory) -> None:
        self.database, self.catalog, self.stores, self.workers = database, catalog, stores, workers

    def ready(self) -> bool:
        if not self.database.ready():
            return False
        try:
            scopes = self.catalog.list_active()
            if not scopes:
                return False
            for scope in scopes:
                # build valida configuração/segredos, sem chamada aos provedores.
                self.workers.build(scope, self.stores.for_scope(scope))
            return True
        except Exception:
            return False


class RuntimeApplication:
    def __init__(self, gateway: MultiTenantWebhookApplication, readiness: ReadinessProbe,
                 panel: object | None = None) -> None:
        self.gateway, self.readiness = gateway, readiness
        self.panel = panel or DisabledPanelApplication()

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path == "/livez":
            return self._reply(start_response, "200 OK", {"status": "ok"})
        if path == "/readyz":
            ready = self.readiness.ready()
            return self._reply(start_response, "200 OK" if ready else "503 Service Unavailable",
                               {"status": "ready" if ready else "unavailable"})
        if PanelApplication.handles(path):
            return self.panel(environ, start_response)
        return self.gateway(environ, start_response)

    @staticmethod
    def _reply(start_response, status: str, payload: Mapping[str, str]):
        body = json.dumps(payload, separators=(",", ":")).encode()
        start_response(status, [("Content-Type", "application/json"),
                                ("Content-Length", str(len(body)))])
        return [body]


def _flag(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} deve ser booleano")


@dataclass(frozen=True)
class RuntimeSettings:
    database_url: str
    secret_dir: str
    host: str = "127.0.0.1"
    port: int = 8080
    poll_seconds: float = 1.0
    readiness_mode: str = "production"
    # Painel do operador. Sem referencia de cadastro no cofre ele fica
    # desligado e responde 503; nunca "aberto porque nao configurado".
    panel_operators_ref: str = ""
    panel_cookie_secure: bool = True
    panel_cookie_path: str = "/"
    panel_session_ttl_seconds: float = 28800.0
    panel_session_idle_seconds: float = 1800.0
    # Analytics: fuso da agregacao diaria, validade do cache e teto da janela.
    panel_analytics_timezone: str = DEFAULT_TIMEZONE
    panel_analytics_cache_seconds: float = 60.0
    panel_analytics_max_days: int = MAX_WINDOW_DAYS
    # Configuração de canais. A base pública só serve para montar a URL que o
    # operador cola no provedor; sem ela o painel devolve apenas o caminho.
    panel_webhook_base_url: str = ""
    panel_secret_writes_per_session: int = 20

    @property
    def panel_enabled(self) -> bool:
        return bool(self.panel_operators_ref)

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "RuntimeSettings":
        database_url, secret_dir = env.get("DATABASE_URL", "").strip(), env.get("SECRET_DIR", "").strip()
        if not database_url or not secret_dir:
            raise ValueError("DATABASE_URL e SECRET_DIR sao obrigatorios")
        try:
            port = int(env.get("BACKEND_PORT", "8080"))
            poll = float(env.get("WORKER_POLL_SECONDS", "1"))
            ttl = float(env.get("PANEL_SESSION_TTL_SECONDS", "28800"))
            idle = float(env.get("PANEL_SESSION_IDLE_SECONDS", "1800"))
            cache_seconds = float(env.get("PANEL_ANALYTICS_CACHE_SECONDS", "60"))
            max_days = int(env.get("PANEL_ANALYTICS_MAX_DAYS", str(MAX_WINDOW_DAYS)))
            secret_writes = int(env.get("PANEL_SECRET_WRITES_PER_SESSION", "20"))
        except ValueError as exc:
            raise ValueError("porta ou intervalo invalido") from exc
        if not 1 <= secret_writes <= 500:
            raise ValueError("PANEL_SECRET_WRITES_PER_SESSION fora do limite")
        webhook_base = normalize_webhook_base(env.get("PANEL_WEBHOOK_BASE_URL", ""))
        if not 1 <= port <= 65535 or not 0.05 <= poll <= 60:
            raise ValueError("porta ou intervalo fora do limite")
        if not 60 <= ttl <= 86400 or not 60 <= idle <= ttl:
            raise ValueError("janela de sessao do painel fora do limite")
        if not 1 <= cache_seconds <= 3600 or not 1 <= max_days <= MAX_WINDOW_DAYS:
            raise ValueError("limites de analytics do painel fora do intervalo")
        analytics_tz = env.get("PANEL_ANALYTICS_TZ", DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
        readiness_mode = env.get("READINESS_MODE", "production").strip().lower()
        if readiness_mode not in {"production", "database"}:
            raise ValueError("READINESS_MODE deve ser production ou database")
        cookie_path = env.get("PANEL_COOKIE_PATH", "/").strip() or "/"
        if not cookie_path.startswith("/"):
            raise ValueError("PANEL_COOKIE_PATH deve comecar com /")
        return cls(database_url, secret_dir, env.get("BACKEND_HOST", "127.0.0.1"),
                   port, poll, readiness_mode,
                   panel_operators_ref=env.get("PANEL_OPERATORS_REF", "").strip(),
                   panel_cookie_secure=_flag(env, "PANEL_COOKIE_SECURE", True),
                   panel_cookie_path=cookie_path,
                   panel_session_ttl_seconds=ttl, panel_session_idle_seconds=idle,
                   panel_analytics_timezone=analytics_tz,
                   panel_analytics_cache_seconds=cache_seconds,
                   panel_analytics_max_days=max_days,
                   panel_webhook_base_url=webhook_base,
                   panel_secret_writes_per_session=secret_writes)


def usa_pooler_transacional(database_url: str) -> bool:
    """Detecta pooler em modo transacao (PgBouncer/Supavisor).

    O psycopg 3 passa a usar prepared statements no servidor depois da quinta
    execucao da mesma consulta (prepare_threshold=5). Num pooler transacional a
    conexao de servidor muda a cada transacao, entao o statement preparado some
    e a consulta seguinte falha com "prepared statement does not exist". O erro
    nao aparece no primeiro acesso: aparece depois que a fila esquenta.

    Supabase usa a porta 6543 para o pooler transacional e 5432 para conexao
    direta; o host do pooler tambem carrega "pooler" no nome.
    """
    if not database_url:
        return False
    alvo = database_url.lower()
    return ":6543" in alvo or "pooler." in alvo or "pgbouncer=true" in alvo


def psycopg_connection_factory(database_url: str) -> ConnectionFactory:
    def connect():
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover - depende da imagem de produção
            raise RuntimeError("driver psycopg nao instalado") from exc
        if usa_pooler_transacional(database_url):
            return psycopg.connect(database_url, prepare_threshold=None)
        return psycopg.connect(database_url)
    return connect


def build_panel(settings: RuntimeSettings, factory: ConnectionFactory,
                secrets: DirectorySecretResolver):
    """Painel ligado somente quando o cadastro de operadores existe no cofre."""
    if not settings.panel_enabled:
        return DisabledPanelApplication()
    stores = PostgresStoreFactory(factory)
    return PanelApplication(
        directory=OperatorDirectory.from_secret(secrets, settings.panel_operators_ref),
        sessions=SessionStore(ttl_seconds=settings.panel_session_ttl_seconds,
                              idle_seconds=settings.panel_session_idle_seconds),
        catalog=PostgresPanelAgentCatalog(factory),
        store_factory=stores.for_panel_agent,
        cookie_secure=settings.panel_cookie_secure,
        cookie_path=settings.panel_cookie_path,
        analytics_cache=AnalyticsCache(ttl_seconds=settings.panel_analytics_cache_seconds),
        analytics_timezone=settings.panel_analytics_timezone,
        analytics_max_days=settings.panel_analytics_max_days,
        # O cofre de escrita aponta para o mesmo SECRET_DIR que o resolver de
        # leitura usa; escrita e leitura ficam em objetos separados de propósito.
        vault=SecretVault(settings.secret_dir),
        webhook_base_url=settings.panel_webhook_base_url,
        secret_quota=SecretWriteQuota(
            max_writes=settings.panel_secret_writes_per_session))


def build_gateway(settings: RuntimeSettings, connection_factory: ConnectionFactory | None = None):
    factory = connection_factory or psycopg_connection_factory(settings.database_url)
    registry = PostgresTenantRegistry(factory)
    secrets = DirectorySecretResolver(settings.secret_dir)
    sink = TenantPostgresSink(PostgresStoreFactory(factory))
    gateway = MultiTenantWebhookApplication(registry, secrets, sink)
    return RuntimeApplication(gateway, ReadinessProbe(factory),
                              build_panel(settings, factory, secrets))


def _install_handlers(stop: Event) -> None:
    def request_stop(_signum, _frame): stop.set()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)


def main(argv: list[str] | None = None, env: Mapping[str, str] = os.environ,
         *, worker_factory: TenantWorkerFactory | None = None,
         connection_factory: ConnectionFactory | None = None) -> int:
    parser = argparse.ArgumentParser(description="SAC multi-tenant v2")
    parser.add_argument("command", choices=("server", "worker", "check"))
    args = parser.parse_args(argv)
    try:
        settings = RuntimeSettings.from_env(env)
        factory = connection_factory or psycopg_connection_factory(settings.database_url)
        application = build_gateway(settings, factory)
    except (ValueError, OSError) as exc:
        print(f"configuracao invalida: {exc}", file=sys.stderr)
        return 2
    stores = PostgresStoreFactory(factory)
    catalog = PostgresActiveAgentCatalog(factory)
    if worker_factory is None:
        from .production_worker import PostgresRuntimeConfigRepository, ProductionWorkerFactory
        worker_factory = ProductionWorkerFactory(PostgresRuntimeConfigRepository(factory),
                                                 DirectorySecretResolver(settings.secret_dir))
    if settings.readiness_mode == "production":
        application.readiness = ProductionReadiness(application.readiness, catalog, stores,
                                                    worker_factory)
    if args.command == "check":
        return 0 if application.readiness.ready() else 1
    stop = Event()
    _install_handlers(stop)
    if args.command == "server":
        with make_server(settings.host, settings.port, application) as server:
            server.timeout = 1
            while not stop.is_set():
                server.handle_request()
        return 0
    scheduler = MultiTenantWorkerScheduler(catalog, stores, worker_factory)
    while not stop.is_set():
        if scheduler.run_cycle() == 0:
            sleep(settings.poll_seconds)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
