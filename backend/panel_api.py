"""API REST do painel do operador (SAC v2, PostgreSQL).

Substitui a simulacao em ``localStorage`` do painel generico por dados reais do
control plane e do schema de cada agente. O contrato tem tres garantias:

1. **Tenant nunca vem do cliente.** O caminho carrega um par tenant/agente, mas
   ele so vale se a sessao do operador o autorizar e se o control plane o
   confirmar. O ``schema_name`` usado nas consultas sai sempre de
   ``public.sac_agents``, jamais do pedido HTTP.
2. **Nenhum segredo sai daqui.** As consultas listam colunas explicitas; as
   colunas ``*_secret_ref`` de ``sac_channel_accounts`` nunca sao selecionadas.
3. **Escrita nao envia nada para fora.** As rotas de escrita gravam somente na
   tabela alvo, no historico correspondente e em ``sac_audit_log``. Nenhuma
   delas toca ``sac_outbox``, que e a unica porta de saida para os canais.

4. **Analytics e somente leitura e so devolve agregado.** As rotas sob
   ``/analytics`` nao escrevem, nao emitem evento e so tocam ``sac_outbox``
   para contar pendencia. Janela de tempo tem teto, agregacao diaria sai no
   fuso configurado (Brasilia por padrao) e a resposta passa por cache curto
   em memoria com orcamento de calculo por agente.
"""
from __future__ import annotations

import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Protocol, Sequence
from urllib.parse import parse_qs, unquote

from .panel_analytics import (ANALYTICS_REPORTS, AnalyticsCache, ComputationBudget,
                              DEFAULT_TIMEZONE, MAX_WINDOW_DAYS, resolve_window)
from .panel_auth import LoginThrottle, OperatorDirectory, PanelSession, SessionStore
from .postgres_store import ConnectionFactory, PostgresStore

SESSION_COOKIE = "sac_panel_session"
CSRF_HEADER = "X-SAC-Panel-CSRF"
_CSRF_ENVIRON = "HTTP_" + CSRF_HEADER.upper().replace("-", "_")
_SAFE_METHODS = frozenset({"GET", "HEAD"})
_VISIBLE_AGENT_STATUS = frozenset({"provisioned", "active"})
_MAX_SEGMENT = 200


@dataclass(frozen=True)
class PanelAgent:
    """Agente confirmado pelo control plane, ja com o schema resolvido."""

    tenant_id: str
    agent_id: str
    schema_name: str
    tenant_name: str
    agent_name: str
    status: str
    channels: tuple[Mapping[str, Any], ...] = ()

    def public(self) -> dict[str, Any]:
        return {"tenantId": self.tenant_id, "agentId": self.agent_id,
                "tenantName": self.tenant_name, "agentName": self.agent_name,
                "status": self.status, "channels": [dict(item) for item in self.channels]}


class PanelAgentCatalog(Protocol):
    def list_all(self) -> tuple[PanelAgent, ...]: ...
    def describe(self, tenant_id: str, agent_id: str) -> PanelAgent | None: ...


class PostgresPanelAgentCatalog:
    """Catalogo somente leitura do control plane, sem nenhuma coluna de segredo."""

    AGENTS_SQL = """
        SELECT ag.tenant_id, ag.id, ag.schema_name, t.display_name, ag.display_name, ag.status
          FROM public.sac_agents AS ag
          JOIN public.sac_tenants AS t ON t.id = ag.tenant_id
         WHERE t.status = 'active' AND ag.status = ANY(%s)
         ORDER BY t.display_name, ag.display_name
    """
    AGENT_SQL = """
        SELECT ag.tenant_id, ag.id, ag.schema_name, t.display_name, ag.display_name, ag.status
          FROM public.sac_agents AS ag
          JOIN public.sac_tenants AS t ON t.id = ag.tenant_id
         WHERE t.status = 'active' AND ag.tenant_id = %s AND ag.id = %s
         LIMIT 1
    """
    CHANNELS_SQL = """
        SELECT tenant_id, agent_id, channel, provider, status, display_name
          FROM public.sac_channel_accounts
         ORDER BY tenant_id, agent_id, channel, id
    """

    def __init__(self, connection_factory: ConnectionFactory) -> None:
        self._factory = connection_factory

    @staticmethod
    def _cell(row: Any, key: str, position: int) -> Any:
        if isinstance(row, Mapping):
            return row.get(key)
        return row[position]

    def _query(self, sql: str, params: tuple[Any, ...] = ()) -> list[Any]:
        connection = self._factory()
        cursor = connection.cursor()
        try:
            cursor.execute(sql, params)
            return list(cursor.fetchall())
        finally:
            close = getattr(cursor, "close", None)
            if callable(close):
                close()
            connection.close()

    def _channels(self) -> dict[tuple[str, str], list[dict[str, Any]]]:
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in self._query(self.CHANNELS_SQL):
            key = (str(self._cell(row, "tenant_id", 0)), str(self._cell(row, "agent_id", 1)))
            grouped.setdefault(key, []).append({
                "channel": self._cell(row, "channel", 2),
                "provider": self._cell(row, "provider", 3),
                "status": self._cell(row, "status", 4),
                "displayName": self._cell(row, "display_name", 5),
            })
        return grouped

    def _agent(self, row: Any, channels: Sequence[Mapping[str, Any]] = ()) -> PanelAgent:
        return PanelAgent(str(self._cell(row, "tenant_id", 0)), str(self._cell(row, "id", 1)),
                          str(self._cell(row, "schema_name", 2)),
                          str(self._cell(row, "display_name", 3) or ""),
                          str(self._cell(row, "display_name", 4) or ""),
                          str(self._cell(row, "status", 5)), tuple(channels))

    def list_all(self) -> tuple[PanelAgent, ...]:
        rows = self._query(self.AGENTS_SQL, (sorted(_VISIBLE_AGENT_STATUS),))
        channels = self._channels()
        return tuple(self._agent(row, channels.get(
            (str(self._cell(row, "tenant_id", 0)), str(self._cell(row, "id", 1))), []))
            for row in rows)

    def describe(self, tenant_id: str, agent_id: str) -> PanelAgent | None:
        rows = self._query(self.AGENT_SQL, (tenant_id, agent_id))
        if not rows:
            return None
        agent = self._agent(rows[0])
        if agent.status not in _VISIBLE_AGENT_STATUS:
            return None
        channels = self._channels().get((agent.tenant_id, agent.agent_id), [])
        return PanelAgent(agent.tenant_id, agent.agent_id, agent.schema_name, agent.tenant_name,
                          agent.agent_name, agent.status, tuple(channels))


StoreFactory = Callable[[PanelAgent], PostgresStore]


class _HttpError(Exception):
    def __init__(self, status: str, error: str, **extra: Any) -> None:
        super().__init__(error)
        self.status = status
        self.payload = {"error": error, **extra}


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _cookie(environ: Mapping[str, Any], name: str) -> str:
    for part in str(environ.get("HTTP_COOKIE") or "").split(";"):
        key, separator, value = part.strip().partition("=")
        if separator and key == name:
            return unquote(value.strip('"'))
    return ""


def _valid_segment(value: str) -> bool:
    return bool(value) and len(value) <= _MAX_SEGMENT and "\x00" not in value


class PanelApplication:
    """Aplicacao WSGI do painel; montada pelo runtime junto ao gateway."""

    PREFIX = "/api/v1/panel"

    def __init__(self, *, directory: OperatorDirectory, sessions: SessionStore,
                 catalog: PanelAgentCatalog, store_factory: StoreFactory,
                 throttle: LoginThrottle | None = None, cookie_secure: bool = True,
                 cookie_path: str = "/", max_body_bytes: int = 65_536,
                 analytics_cache: AnalyticsCache | None = None,
                 analytics_budget: ComputationBudget | None = None,
                 analytics_timezone: str = DEFAULT_TIMEZONE,
                 analytics_max_days: int = MAX_WINDOW_DAYS) -> None:
        self.directory = directory
        self.sessions = sessions
        self.catalog = catalog
        self.store_factory = store_factory
        self.throttle = throttle or LoginThrottle()
        self.cookie_secure = cookie_secure
        self.cookie_path = cookie_path or "/"
        self.max_body_bytes = max_body_bytes
        self.analytics_cache = analytics_cache or AnalyticsCache()
        self.analytics_budget = analytics_budget or ComputationBudget()
        self.analytics_max_days = int(analytics_max_days)
        # Falha no arranque, nao no primeiro pedido: fuso invalido em
        # configuracao nao pode virar 500 na cara do cliente.
        resolve_window(timezone_name=analytics_timezone, max_days=self.analytics_max_days)
        self.analytics_timezone = analytics_timezone

    @classmethod
    def handles(cls, path: str) -> bool:
        return path == cls.PREFIX or path.startswith(cls.PREFIX + "/")

    # ------------------------------------------------------------------ HTTP

    @staticmethod
    def _reply(start_response, status: str, payload: Mapping[str, Any],
               *, extra_headers: Sequence[tuple[str, str]] = (), method: str = "GET"):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_iso).encode()
        headers = [("Content-Type", "application/json; charset=utf-8"),
                   ("Cache-Control", "private, no-store"),
                   ("X-Content-Type-Options", "nosniff"),
                   ("Vary", "Cookie"),
                   ("Content-Length", str(len(body) if method != "HEAD" else 0))]
        headers.extend(extra_headers)
        start_response(status, headers)
        return [] if method == "HEAD" else [body]

    def _body(self, environ: Mapping[str, Any]) -> dict[str, Any]:
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            raise _HttpError("400 Bad Request", "invalid_payload")
        if length < 0 or length > self.max_body_bytes:
            raise _HttpError("413 Payload Too Large", "too_large")
        raw = environ["wsgi.input"].read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except (ValueError, TypeError):
            raise _HttpError("400 Bad Request", "invalid_payload")
        if not isinstance(payload, Mapping):
            raise _HttpError("400 Bad Request", "invalid_payload")
        return dict(payload)

    def _cookie_header(self, token: str, *, max_age: int) -> tuple[str, str]:
        parts = [f"{SESSION_COOKIE}={token}", f"Path={self.cookie_path}",
                 f"Max-Age={max_age}", "HttpOnly", "SameSite=Strict"]
        if self.cookie_secure:
            parts.append("Secure")
        return ("Set-Cookie", "; ".join(parts))

    def __call__(self, environ, start_response):
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        path = str(environ.get("PATH_INFO", ""))
        if not self.handles(path):
            return self._reply(start_response, "404 Not Found", {"error": "not_found"},
                               method=method)
        segments = [unquote(part) for part in path[len(self.PREFIX):].split("/") if part]
        if any(not _valid_segment(part) for part in segments):
            return self._reply(start_response, "400 Bad Request", {"error": "invalid_path"},
                               method=method)
        try:
            status, payload, headers = self._dispatch(environ, method, segments)
        except _HttpError as exc:
            return self._reply(start_response, exc.status, exc.payload, method=method)
        except Exception:
            # Nunca serializa str(exc): mensagens de driver carregam DSN e dados.
            return self._reply(start_response, "503 Service Unavailable",
                               {"error": "backend_unavailable"}, method=method)
        return self._reply(start_response, status, payload, extra_headers=headers, method=method)

    # -------------------------------------------------------------- Sessao

    def _require_session(self, environ: Mapping[str, Any]) -> PanelSession:
        session = self.sessions.resolve(_cookie(environ, SESSION_COOKIE))
        if session is None:
            raise _HttpError("401 Unauthorized", "unauthorized")
        return session

    def _require_csrf(self, environ: Mapping[str, Any], session: PanelSession) -> None:
        header = str(environ.get(_CSRF_ENVIRON) or "")
        if not header or not hmac.compare_digest(header, session.csrf_token):
            raise _HttpError("403 Forbidden", "invalid_csrf")

    def _session_payload(self, session: PanelSession) -> dict[str, Any]:
        return {"operator": session.operator.public(), "csrfToken": session.csrf_token,
                "expiresAt": _iso(datetime.fromtimestamp(session.expires_at, timezone.utc))}

    def _login(self, environ: Mapping[str, Any]):
        payload = self._body(environ)
        operator_id = str(payload.get("operator") or "").strip()
        password = payload.get("password")
        if not operator_id or not isinstance(password, str) or not password:
            raise _HttpError("400 Bad Request", "invalid_payload")
        if self.throttle.blocked(operator_id):
            raise _HttpError("429 Too Many Requests", "too_many_attempts")
        try:
            operator = self.directory.authenticate(operator_id, password)
        except LookupError:
            raise _HttpError("503 Service Unavailable", "operator_directory_unavailable")
        if operator is None:
            self.throttle.register_failure(operator_id)
            raise _HttpError("401 Unauthorized", "invalid_credentials")
        self.throttle.reset(operator_id)
        token, session = self.sessions.create(operator)
        header = self._cookie_header(token, max_age=int(self.sessions.ttl_seconds))
        return "200 OK", self._session_payload(session), [header]

    def _session_route(self, environ: Mapping[str, Any], method: str):
        if method == "POST":
            return self._login(environ)
        if method in _SAFE_METHODS:
            return "200 OK", self._session_payload(self._require_session(environ)), []
        if method == "DELETE":
            self.sessions.destroy(_cookie(environ, SESSION_COOKIE))
            return "200 OK", {"status": "signed_out"}, [self._cookie_header("", max_age=0)]
        raise _HttpError("405 Method Not Allowed", "method_not_allowed")

    # ------------------------------------------------------------ Roteamento

    def _authorize_agent(self, session: PanelSession, tenant_id: str, agent_id: str) -> PanelAgent:
        # A sessao decide o que existe para este operador; o control plane
        # decide qual schema atende. O cliente nao participa de nenhuma etapa.
        if not session.operator.allows(tenant_id, agent_id):
            raise _HttpError("404 Not Found", "not_found")
        agent = self.catalog.describe(tenant_id, agent_id)
        if agent is None:
            raise _HttpError("404 Not Found", "not_found")
        return agent

    @staticmethod
    def _agent_payload(session: PanelSession, agent: PanelAgent) -> dict[str, Any]:
        """A fonte declara o que a sessao pode fazer com ela, nao o que ela "e"."""
        return {**agent.public(),
                "permissions": {"read": True,
                                "write": session.operator.can_write(agent.tenant_id,
                                                                    agent.agent_id)}}

    def _require_write(self, session: PanelSession, agent: PanelAgent) -> None:
        if not session.operator.can_write(agent.tenant_id, agent.agent_id):
            raise _HttpError("403 Forbidden", "read_only")

    def _visible_agents(self, session: PanelSession) -> tuple[PanelAgent, ...]:
        return tuple(agent for agent in self.catalog.list_all()
                     if session.operator.allows(agent.tenant_id, agent.agent_id))

    @staticmethod
    def _query(environ: Mapping[str, Any]) -> dict[str, list[str]]:
        return parse_qs(str(environ.get("QUERY_STRING", "")))

    @staticmethod
    def _single(query: Mapping[str, list[str]], name: str) -> str | None:
        values = query.get(name) or []
        return values[0] if values else None

    def _dispatch(self, environ: Mapping[str, Any], method: str, segments: list[str]):
        if segments == ["session"]:
            return self._session_route(environ, method)
        session = self._require_session(environ)
        if segments == ["agents"]:
            if method not in _SAFE_METHODS:
                raise _HttpError("405 Method Not Allowed", "method_not_allowed")
            return "200 OK", {"agents": [self._agent_payload(session, agent)
                                         for agent in self._visible_agents(session)],
                              "operator": session.operator.public()}, []
        if len(segments) >= 3 and segments[0] == "agents":
            agent = self._authorize_agent(session, segments[1], segments[2])
            return self._agent_route(environ, method, session, agent, segments[3:])
        raise _HttpError("404 Not Found", "not_found")

    def _agent_route(self, environ: Mapping[str, Any], method: str, session: PanelSession,
                     agent: PanelAgent, tail: list[str]):
        store = self.store_factory(agent)
        query = self._query(environ)
        try:
            if not tail:
                self._only(method, _SAFE_METHODS)
                return "200 OK", {"agent": self._agent_payload(session, agent)}, []
            if tail[0] == "analytics":
                self._only(method, _SAFE_METHODS)
                return self._analytics(session, agent, store, query, tail[1:])
            if tail == ["conversations"]:
                self._only(method, _SAFE_METHODS)
                return "200 OK", {"agent": self._agent_payload(session, agent),
                                  **store.panel_conversations(
                                      limit=self._single(query, "limit") or 25,
                                      cursor=self._single(query, "cursor"))}, []
            if tail == ["origins"]:
                self._only(method, _SAFE_METHODS)
                return "200 OK", {"agent": self._agent_payload(session, agent),
                                  **store.panel_origins()}, []
            if len(tail) == 3 and tail[0] == "conversations" and tail[2] == "messages":
                self._only(method, _SAFE_METHODS)
                return "200 OK", store.panel_messages(
                    tail[1], limit=self._single(query, "limit") or 50,
                    cursor=self._single(query, "cursor")), []
            if tail == ["pipeline"]:
                self._only(method, _SAFE_METHODS)
                return "200 OK", {"agent": self._agent_payload(session, agent),
                                  **store.panel_pipeline()}, []
            if tail == ["audit"]:
                self._only(method, _SAFE_METHODS)
                return "200 OK", store.panel_audit(limit=self._single(query, "limit") or 50), []
            if len(tail) == 3 and tail[0] == "conversations" and tail[2] == "notes":
                return self._write_note(environ, method, session, agent, store, tail[1])
            if len(tail) == 3 and tail[0] == "conversations" and tail[2] == "assignment":
                return self._write_assignment(environ, method, session, agent, store, tail[1])
            if len(tail) == 3 and tail[0] == "contacts" and tail[2] == "stage":
                return self._write_stage(environ, method, session, agent, store, tail[1])
        except KeyError:
            raise _HttpError("404 Not Found", "not_found")
        except ValueError:
            raise _HttpError("400 Bad Request", "invalid_request")
        raise _HttpError("404 Not Found", "not_found")

    # ------------------------------------------------------------- Analytics

    def _window(self, query: Mapping[str, list[str]]):
        """Janela pedida pelo cliente, sempre validada e com teto."""
        try:
            return resolve_window(period=self._single(query, "periodo"),
                                  since=self._single(query, "de"),
                                  until=self._single(query, "ate"),
                                  timezone_name=(self._single(query, "fuso")
                                                 or self.analytics_timezone),
                                  max_days=self.analytics_max_days)
        except ValueError:
            # str(exc) e mensagem de dominio, mas o contrato do painel e um
            # codigo estavel; o detalhe fica no proprio nome do erro.
            raise _HttpError("400 Bad Request", "invalid_window",
                             maxDays=self.analytics_max_days)

    def _analytics(self, session: PanelSession, agent: PanelAgent, store: Any,
                   query: Mapping[str, list[str]], tail: list[str]):
        """Relatorio agregado, com cache por (agente, relatorio, janela).

        A autorizacao do agente ja aconteceu antes daqui e a chave do cache
        carrega tenant e agente: um relatorio calculado para um cliente nunca
        pode ser servido para outro.
        """
        if len(tail) > 1:
            raise _HttpError("404 Not Found", "not_found")
        window = self._window(query)
        if not tail:
            return "200 OK", {"agent": self._agent_payload(session, agent),
                              "window": window.public(),
                              "reports": sorted(ANALYTICS_REPORTS),
                              "cacheTtlSeconds": int(self.analytics_cache.ttl_seconds)}, []
        report = tail[0]
        if report not in ANALYTICS_REPORTS:
            raise _HttpError("404 Not Found", "not_found")
        key = (agent.tenant_id, agent.agent_id, report, *window.cache_key())
        payload = self.analytics_cache.get(key)
        hit = payload is not None
        if payload is None:
            if not self.analytics_budget.allow((agent.tenant_id, agent.agent_id)):
                raise _HttpError("429 Too Many Requests", "analytics_busy")
            handler = getattr(store, ANALYTICS_REPORTS[report], None)
            if not callable(handler):
                raise _HttpError("404 Not Found", "not_found")
            payload = handler(window)
            self.analytics_cache.put(key, payload)
        return "200 OK", {"agent": self._agent_payload(session, agent), **payload,
                          "report": report,
                          "cache": {"hit": hit,
                                    "ttlSeconds": int(self.analytics_cache.ttl_seconds)}}, []

    @staticmethod
    def _only(method: str, allowed: frozenset[str]) -> None:
        if method not in allowed:
            raise _HttpError("405 Method Not Allowed", "method_not_allowed")

    # --------------------------------------------------------------- Escrita

    def _write_note(self, environ, method, session, agent, store, conversation_id):
        self._only(method, frozenset({"POST"}))
        self._require_write(session, agent)
        self._require_csrf(environ, session)
        payload = self._body(environ)
        result = store.panel_add_note(conversation_id, text=str(payload.get("text") or ""),
                                      actor_id=session.operator.id,
                                      idempotency_key=payload.get("idempotencyKey"))
        return "201 Created" if not result["idempotent"] else "200 OK", result, []

    def _write_assignment(self, environ, method, session, agent, store, conversation_id):
        self._only(method, frozenset({"POST"}))
        self._require_write(session, agent)
        self._require_csrf(environ, session)
        payload = self._body(environ)
        raw = payload.get("assignee")
        assignee = None if raw is None else str(raw).strip()
        if assignee == "":
            assignee = None
        if assignee is not None and not self._assignable(assignee, agent):
            raise _HttpError("400 Bad Request", "invalid_assignee")
        result = store.panel_assign_conversation(conversation_id, assignee=assignee,
                                                 actor_id=session.operator.id)
        return "200 OK", result, []

    def _write_stage(self, environ, method, session, agent, store, contact_id):
        self._only(method, frozenset({"POST"}))
        self._require_write(session, agent)
        self._require_csrf(environ, session)
        payload = self._body(environ)
        result = store.panel_set_stage(contact_id, stage=str(payload.get("stage") or ""),
                                       actor_id=session.operator.id,
                                       reason=payload.get("reason"))
        return "200 OK", result, []

    def _assignable(self, assignee: str, agent: PanelAgent) -> bool:
        """Responsavel precisa poder agir: exige permissao de escrita no agente.

        Um operador somente leitura pode acompanhar o agente, mas nao pode ser
        apontado como dono de uma conversa que ele nao consegue tratar.
        """
        try:
            operator = self.directory.get(assignee)
        except LookupError:
            raise _HttpError("503 Service Unavailable", "operator_directory_unavailable")
        return operator is not None and operator.can_write(agent.tenant_id, agent.agent_id)


class DisabledPanelApplication:
    """Painel desligado: falha fechada enquanto faltar cadastro de operadores."""

    PREFIX = PanelApplication.PREFIX

    @classmethod
    def handles(cls, path: str) -> bool:
        return PanelApplication.handles(path)

    def __call__(self, environ, start_response):
        body = b'{"error":"panel_disabled"}'
        start_response("503 Service Unavailable",
                       [("Content-Type", "application/json; charset=utf-8"),
                        ("Cache-Control", "private, no-store"),
                        ("X-Content-Type-Options", "nosniff"),
                        ("Content-Length", str(len(body)))])
        return [body]
