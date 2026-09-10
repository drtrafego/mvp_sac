"""Autenticacao e autorizacao de operadores do painel SAC v2.

O painel publicado em ``/sac/`` ja vive atras da autenticacao HTTP do painel
principal, que prova apenas que quem chegou ali pertence a operacao. Escrita
exige mais do que isso: identidade individual, escopo explicito por agente e
trilha de auditoria. Este modulo fornece as tres pecas de identidade.

Regras que valem em todo o arquivo:

* o cadastro de operadores mora no cofre (``SECRET_DIR``) e guarda somente o
  hash derivado da senha; nunca a senha, nunca um token;
* a sessao e server-side e opaca: o navegador recebe um identificador aleatorio
  que nao carrega tenant, agente nem permissao;
* a lista de agentes de um operador e sempre lida do cadastro, nunca do
  pedido HTTP.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable, Mapping, Protocol

PBKDF2_ALGORITHM = "pbkdf2_sha256"
DEFAULT_ITERATIONS = 600_000
MIN_ITERATIONS = 200_000
SALT_BYTES = 16
MIN_PASSWORD_BYTES = 12
MAX_PASSWORD_BYTES = 1024

_OPERATOR_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,63}$")
_SCOPE_ID = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")

# Hash descartavel usado para gastar o mesmo tempo quando o operador nao existe.
_DECOY_HASH = (
    f"{PBKDF2_ALGORITHM}${MIN_ITERATIONS}$"
    "AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
)


def _b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def hash_password(password: str, *, iterations: int = DEFAULT_ITERATIONS,
                  salt: bytes | None = None) -> str:
    """Deriva o hash armazenavel de uma senha de operador."""
    raw = password.encode("utf-8")
    if len(raw) < MIN_PASSWORD_BYTES:
        raise ValueError(f"senha deve ter ao menos {MIN_PASSWORD_BYTES} bytes")
    if len(raw) > MAX_PASSWORD_BYTES:
        raise ValueError("senha grande demais")
    if iterations < MIN_ITERATIONS:
        raise ValueError(f"iteracoes devem ser >= {MIN_ITERATIONS}")
    salt = salt if salt is not None else secrets.token_bytes(SALT_BYTES)
    if len(salt) < SALT_BYTES:
        raise ValueError("salt curto demais")
    digest = hashlib.pbkdf2_hmac("sha256", raw, salt, iterations)
    return f"{PBKDF2_ALGORITHM}${iterations}${_b64encode(salt)}${_b64encode(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    """Compara senha e hash em tempo constante; formato invalido nunca autoriza."""
    try:
        algorithm, raw_iterations, raw_salt, raw_digest = str(encoded).split("$")
        if algorithm != PBKDF2_ALGORITHM:
            return False
        iterations = int(raw_iterations)
        if iterations < MIN_ITERATIONS:
            return False
        salt = base64.b64decode(raw_salt, validate=True)
        expected = base64.b64decode(raw_digest, validate=True)
    except (AttributeError, ValueError, TypeError):
        return False
    if not salt or not expected:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations,
                                    dklen=len(expected))
    return hmac.compare_digest(candidate, expected)


@dataclass(frozen=True)
class AgentGrant:
    """Permissao explicita de um operador sobre um agente do control plane.

    ``write`` e a permissao de escrita daquela fonte. Um operador sem ela le o
    agente e nao consegue mover card, atribuir conversa ou registrar nota.
    """

    tenant_id: str
    agent_id: str
    write: bool = True

    def __post_init__(self) -> None:
        for value, name in ((self.tenant_id, "tenant_id"), (self.agent_id, "agent_id")):
            if not _SCOPE_ID.fullmatch(value or ""):
                raise ValueError(f"{name} invalido no cadastro de operadores")
        if not isinstance(self.write, bool):
            raise ValueError("permissao de escrita deve ser booleana")


@dataclass(frozen=True)
class Operator:
    id: str
    display_name: str
    grants: tuple[AgentGrant, ...] = ()

    def _grant(self, tenant_id: str, agent_id: str) -> AgentGrant | None:
        return next((grant for grant in self.grants
                     if grant.tenant_id == tenant_id and grant.agent_id == agent_id), None)

    def allows(self, tenant_id: str, agent_id: str) -> bool:
        return self._grant(tenant_id, agent_id) is not None

    def can_write(self, tenant_id: str, agent_id: str) -> bool:
        grant = self._grant(tenant_id, agent_id)
        return bool(grant and grant.write)

    def public(self) -> dict[str, object]:
        """Projecao segura: sem hash, sem referencia de cofre."""
        return {"id": self.id, "displayName": self.display_name,
                "agents": [{"tenantId": grant.tenant_id, "agentId": grant.agent_id,
                            "write": grant.write} for grant in self.grants]}


class SecretLoader(Protocol):
    def resolve(self, secret_ref: str) -> str: ...


class OperatorDirectory:
    """Cadastro de operadores lido do cofre a cada consulta.

    Ler sempre do cofre custa pouco (o arquivo e pequeno) e evita que uma
    revogacao de acesso dependa de reiniciar o processo.
    """

    def __init__(self, loader: Callable[[], str]) -> None:
        if not callable(loader):
            raise TypeError("loader deve ser chamavel")
        self._loader = loader

    @classmethod
    def from_secret(cls, resolver: SecretLoader, secret_ref: str) -> "OperatorDirectory":
        ref = (secret_ref or "").strip()
        if not ref:
            raise ValueError("referencia do cadastro de operadores e obrigatoria")
        return cls(lambda: resolver.resolve(ref))

    def _parse(self) -> dict[str, tuple[Operator, str]]:
        payload = json.loads(self._loader())
        if not isinstance(payload, Mapping):
            raise ValueError("cadastro de operadores deve ser objeto")
        entries = payload.get("operators")
        if not isinstance(entries, list) or not entries:
            raise ValueError("cadastro de operadores vazio")
        result: dict[str, tuple[Operator, str]] = {}
        for entry in entries:
            if not isinstance(entry, Mapping):
                raise ValueError("operador invalido no cadastro")
            operator_id = str(entry.get("id", "")).strip()
            if not _OPERATOR_ID.fullmatch(operator_id):
                raise ValueError("id de operador invalido")
            if operator_id in result:
                raise ValueError("operador duplicado no cadastro")
            password_hash = str(entry.get("passwordHash", "")).strip()
            if not password_hash:
                raise ValueError("operador sem hash de senha")
            grants = tuple(AgentGrant(str(item.get("tenantId", "")).strip(),
                                      str(item.get("agentId", "")).strip(),
                                      bool(item.get("write", True)))
                           for item in entry.get("agents", [])
                           if isinstance(item, Mapping))
            display = str(entry.get("displayName", "")).strip() or operator_id
            result[operator_id] = (Operator(operator_id, display, grants), password_hash)
        return result

    def _safe_parse(self) -> dict[str, tuple[Operator, str]]:
        try:
            return self._parse()
        except (LookupError, ValueError, TypeError, json.JSONDecodeError) as exc:
            # str(exc) pode carregar trecho do arquivo; propaga apenas a classe.
            raise LookupError("cadastro de operadores indisponivel") from exc

    def authenticate(self, operator_id: str, password: str) -> Operator | None:
        entries = self._safe_parse()
        found = entries.get(str(operator_id or "").strip())
        operator, password_hash = found if found else (None, _DECOY_HASH)
        matched = verify_password(str(password or ""), password_hash)
        return operator if matched and operator is not None else None

    def get(self, operator_id: str) -> Operator | None:
        found = self._safe_parse().get(str(operator_id or "").strip())
        return found[0] if found else None

    def list_operators(self) -> tuple[Operator, ...]:
        return tuple(operator for operator, _ in self._safe_parse().values())


class LoginThrottle:
    """Freio simples por operador; protege o cofre de forca bruta na sessao."""

    def __init__(self, *, max_failures: int = 5, window_seconds: float = 300.0,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if max_failures < 1 or window_seconds <= 0:
            raise ValueError("limites de throttle invalidos")
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._clock = clock
        self._failures: dict[str, tuple[int, float]] = {}

    def blocked(self, key: str) -> bool:
        count, until = self._failures.get(key, (0, 0.0))
        if until and until <= self._clock():
            self._failures.pop(key, None)
            return False
        return count >= self.max_failures

    def register_failure(self, key: str) -> None:
        now = self._clock()
        count, until = self._failures.get(key, (0, 0.0))
        if until and until <= now:
            count = 0
        self._failures[key] = (count + 1, now + self.window_seconds)

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


@dataclass
class PanelSession:
    key: str
    operator: Operator
    csrf_token: str
    created_at: float
    expires_at: float
    last_seen_at: float


class SessionStore:
    """Sessoes opacas mantidas apenas na memoria do processo do gateway.

    Reiniciar o servidor invalida todas as sessoes de propósito: nenhuma
    credencial de painel sobrevive em disco ou no banco.
    """

    def __init__(self, *, ttl_seconds: float = 8 * 3600, idle_seconds: float = 1800,
                 max_sessions: int = 256, clock: Callable[[], float] = time.time) -> None:
        if ttl_seconds <= 0 or idle_seconds <= 0 or max_sessions < 1:
            raise ValueError("limites de sessao invalidos")
        self.ttl_seconds = ttl_seconds
        self.idle_seconds = idle_seconds
        self.max_sessions = max_sessions
        self._clock = clock
        self._sessions: dict[str, PanelSession] = {}

    @staticmethod
    def _key(token: str) -> str:
        return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()

    def _expired(self, session: PanelSession, now: float) -> bool:
        return now >= session.expires_at or now - session.last_seen_at >= self.idle_seconds

    def _prune(self, now: float) -> None:
        for key in [k for k, s in self._sessions.items() if self._expired(s, now)]:
            self._sessions.pop(key, None)

    def create(self, operator: Operator) -> tuple[str, PanelSession]:
        now = self._clock()
        self._prune(now)
        while len(self._sessions) >= self.max_sessions:
            oldest = min(self._sessions.values(), key=lambda item: item.last_seen_at)
            self._sessions.pop(oldest.key, None)
        token = secrets.token_urlsafe(32)
        session = PanelSession(self._key(token), operator, secrets.token_urlsafe(32),
                               now, now + self.ttl_seconds, now)
        self._sessions[session.key] = session
        return token, session

    def resolve(self, token: str) -> PanelSession | None:
        if not token:
            return None
        now = self._clock()
        self._prune(now)
        session = self._sessions.get(self._key(token))
        if session is None:
            return None
        if self._expired(session, now):
            self._sessions.pop(session.key, None)
            return None
        session.last_seen_at = now
        return session

    def destroy(self, token: str) -> bool:
        return self._sessions.pop(self._key(token), None) is not None

    def destroy_operator(self, operator_id: str) -> int:
        keys = [key for key, session in self._sessions.items()
                if session.operator.id == operator_id]
        for key in keys:
            self._sessions.pop(key, None)
        return len(keys)

    def active(self) -> int:
        self._prune(self._clock())
        return len(self._sessions)
