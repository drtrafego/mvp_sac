"""Provisionamento idempotente do SAC v2, sem acoplamento ao composition root."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Mapping, Protocol


SLUG_RE = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")
ROLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
SCHEMA_RE = re.compile(r"^sac_[a-z][a-z0-9_]{1,58}$")
SECRET_REF_RE = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$")
SECRET_KEY_RE = re.compile(
    r"secret|token|password|passphrase|credential|authorization|auth|private[_-]?key|api[_-]?key",
    re.I,
)
REQUIRED_TABLES = frozenset(
    {
        "sac_contacts", "sac_identities", "sac_threads", "sac_messages",
        "sac_inbound_events", "sac_origins", "sac_domain_events", "sac_outbox",
        "sac_dead_letters", "sac_pipeline_history", "sac_tags",
        "sac_contact_tags", "sac_contact_points", "sac_profile_fields",
        "sac_contact_merges", "sac_crm_actions", "sac_audit_log",
    }
)


class ProvisioningError(RuntimeError):
    """Erro operacional seguro para exibir no CLI."""


@dataclass(frozen=True)
class Manifest:
    tenant_id: str
    tenant_name: str
    agent_id: str
    agent_name: str
    schema_name: str
    owner_role: str
    app_role: str
    worker_role: str
    registry_key: str
    runtime_config: Mapping[str, Any]
    hermes_api_key_secret_ref: str | None

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> "Manifest":
        allowed = {
            "tenant_id", "tenant_name", "agent_id", "agent_name", "schema_name",
            "owner_role", "app_role", "worker_role", "registry_key",
            "runtime_config", "hermes_api_key_secret_ref",
        }
        unknown = set(raw) - allowed
        if unknown:
            raise ProvisioningError("campos desconhecidos no manifesto: " + ", ".join(sorted(unknown)))
        required = allowed - {
            "schema_name", "registry_key", "runtime_config", "hermes_api_key_secret_ref",
        }
        missing = sorted(key for key in required if not isinstance(raw.get(key), str) or not raw[key].strip())
        if missing:
            raise ProvisioningError("campos obrigatorios ausentes: " + ", ".join(missing))
        tenant_id = str(raw["tenant_id"]).strip()
        agent_id = str(raw["agent_id"]).strip()
        schema = str(raw.get("schema_name") or make_schema_name(tenant_id, agent_id)).strip()
        manifest = cls(
            tenant_id=tenant_id,
            tenant_name=str(raw["tenant_name"]).strip(),
            agent_id=agent_id,
            agent_name=str(raw["agent_name"]).strip(),
            schema_name=schema,
            owner_role=str(raw["owner_role"]).strip(),
            app_role=str(raw["app_role"]).strip(),
            worker_role=str(raw["worker_role"]).strip(),
            registry_key=str(raw.get("registry_key") or agent_id).strip(),
            runtime_config=raw.get("runtime_config") or {},
            hermes_api_key_secret_ref=(
                str(raw["hermes_api_key_secret_ref"]).strip()
                if raw.get("hermes_api_key_secret_ref") is not None else None
            ),
        )
        manifest.validate()
        return manifest

    def validate(self) -> None:
        if not SLUG_RE.fullmatch(self.tenant_id):
            raise ProvisioningError("tenant_id invalido")
        if not SLUG_RE.fullmatch(self.agent_id):
            raise ProvisioningError("agent_id invalido")
        if not SLUG_RE.fullmatch(self.registry_key):
            raise ProvisioningError("registry_key invalido")
        if not SCHEMA_RE.fullmatch(self.schema_name) or self.schema_name.startswith("pg_"):
            raise ProvisioningError("schema_name invalido")
        for label, value in (("tenant_name", self.tenant_name), ("agent_name", self.agent_name)):
            if len(value) > 200 or any(ord(char) < 32 for char in value):
                raise ProvisioningError(f"{label} invalido")
        for label, value in (
            ("owner_role", self.owner_role), ("app_role", self.app_role),
            ("worker_role", self.worker_role),
        ):
            if not ROLE_RE.fullmatch(value):
                raise ProvisioningError(f"{label} invalido")
        if not isinstance(self.runtime_config, Mapping):
            raise ProvisioningError("runtime_config deve ser objeto")
        _validate_public_json(self.runtime_config)
        # Também garante que o objeto seja serializável antes de qualquer write.
        try:
            json.dumps(self.runtime_config, ensure_ascii=False, sort_keys=True)
        except (TypeError, ValueError) as exc:
            raise ProvisioningError("runtime_config nao e JSON valido") from exc
        if self.hermes_api_key_secret_ref is not None:
            _validate_secret_ref(self.hermes_api_key_secret_ref, "hermes_api_key_secret_ref")


@dataclass(frozen=True)
class ProvisionStatus:
    registry_agent_exists: bool
    control_plane_installed: bool
    agent_row_exists: bool
    schema_exists: bool
    schema_matches: bool
    migration_recorded: bool
    required_tables: int
    config_matches: bool = True
    runtime_configured: bool = False
    active_channel_accounts: int = 0
    expected_tables: int = len(REQUIRED_TABLES)

    @property
    def ready(self) -> bool:
        return all(
            (
                self.registry_agent_exists,
                self.control_plane_installed,
                self.agent_row_exists,
                self.schema_exists,
                self.schema_matches,
                self.config_matches,
                self.migration_recorded,
                self.required_tables == self.expected_tables,
            )
        )

    @property
    def operational_ready(self) -> bool:
        return self.ready and self.runtime_configured and self.active_channel_accounts > 0


class Backend(Protocol):
    def registry_agent_exists(self, key: str) -> bool: ...
    def inspect(self, manifest: Manifest) -> ProvisionStatus: ...
    def apply_control_plane(self, sql: str) -> None: ...
    def provision_agent(self, manifest: Manifest) -> None: ...


def make_schema_name(tenant_id: str, agent_id: str) -> str:
    raw = tenant_id + ":" + agent_id
    body = tenant_id.replace("-", "_") + "_" + agent_id.replace("-", "_")
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    return "sac_" + body[:50].rstrip("_") + "_" + digest


def _validate_secret_ref(value: str, field: str) -> None:
    if not SECRET_REF_RE.fullmatch(value) or ".." in value.split("/"):
        raise ProvisioningError(f"{field} invalida")


def _validate_public_json(value: Any) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str) or SECRET_KEY_RE.search(key):
                raise ProvisioningError("runtime_config contem chave reservada para segredo")
            _validate_public_json(child)
    elif isinstance(value, list):
        for child in value:
            _validate_public_json(child)


def load_manifest(path: Path) -> Manifest:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProvisioningError("manifesto ilegivel ou JSON invalido") from exc
    if not isinstance(raw, Mapping):
        raise ProvisioningError("manifesto deve ser um objeto JSON")
    return Manifest.from_mapping(raw)


def validate_offline_registry(path: Path, key: str) -> bool:
    """Aceita {agents:[...]}, lista ou mapa; nunca interpreta segredo."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProvisioningError("inventario de agentes ilegivel ou invalido") from exc
    agents: Any = raw.get("agents") if isinstance(raw, Mapping) and "agents" in raw else raw
    if isinstance(agents, Mapping):
        if key in agents:
            return True
        agents = list(agents.values())
    if not isinstance(agents, list):
        raise ProvisioningError("inventario deve conter lista ou mapa de agentes")
    for item in agents:
        if isinstance(item, str) and item == key:
            return True
        if isinstance(item, Mapping) and key in {
            str(item.get(field, "")) for field in ("id", "slug", "agent_id", "key")
        }:
            return True
    return False


def render_plan(
    manifest: Manifest, *, include_control_plane: bool, migration_sql: str | None = None
) -> str:
    """Plano psql revisavel; todos os literais e identificadores sao citados."""
    manifest.validate()
    lines = ["\\set ON_ERROR_STOP on"]
    if include_control_plane:
        lines.append((migration_sql or "\\ir 002_sac_multiagent_v2.sql").rstrip())
    values = (
        manifest.tenant_id, manifest.tenant_name, manifest.agent_id,
        manifest.agent_name, manifest.schema_name, manifest.owner_role,
        manifest.app_role, manifest.worker_role,
    )
    quoted = ", ".join(_sql_literal(value) for value in values)
    public_config = _sql_literal(json.dumps(
        manifest.runtime_config, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )) + "::jsonb"
    secret_ref = (
        _sql_literal(manifest.hermes_api_key_secret_ref)
        if manifest.hermes_api_key_secret_ref is not None else "NULL"
    )
    lines.extend([
        "SELECT public.sac_provision_agent(",
        f"  {quoted}, {public_config}, {secret_ref}", ");", "",
    ])
    return "\n".join(lines)


def _sql_literal(value: str) -> str:
    if "\x00" in value:
        raise ProvisioningError("valor contem caractere nulo")
    return "'" + value.replace("'", "''") + "'"


class Provisioner:
    def __init__(self, backend: Backend) -> None:
        self.backend = backend

    def status(self, manifest: Manifest) -> ProvisionStatus:
        exists = self.backend.registry_agent_exists(manifest.registry_key)
        status = self.backend.inspect(manifest)
        if status.registry_agent_exists != exists:
            status = replace(status, registry_agent_exists=exists)
        return status

    def apply(
        self,
        manifest: Manifest,
        migration_sql: str,
        *,
        apply_control_plane: bool,
        apply_agent: bool,
    ) -> ProvisionStatus:
        if not apply_control_plane and not apply_agent:
            raise ProvisioningError("nenhuma etapa de aplicacao foi autorizada")
        if not self.backend.registry_agent_exists(manifest.registry_key):
            raise ProvisioningError("agente nao existe no cadastro central")
        before = self.backend.inspect(manifest)
        if before.ready:
            return before
        if before.agent_row_exists or before.schema_exists:
            raise ProvisioningError("estado parcial ou divergente; correcao manual segura necessaria")
        if not before.control_plane_installed:
            if not apply_control_plane:
                raise ProvisioningError("control plane ausente; autorize --apply-control-plane")
            self.backend.apply_control_plane(migration_sql)
        if apply_agent:
            try:
                self.backend.provision_agent(manifest)
            except Exception:
                # Outra execução pode ter vencido a corrida. Só converte a
                # exceção em sucesso quando o estado autoritativo está completo.
                raced = self.backend.inspect(manifest)
                if raced.ready:
                    return raced
                raise
        after = self.backend.inspect(manifest)
        if apply_agent and not after.ready:
            raise ProvisioningError("provisionamento terminou sem estado pronto")
        return after


class DatabaseBackend:
    """Adaptador DB-API. Não recebe nem conserva a URL do banco."""

    def __init__(self, connection: Any) -> None:
        self.connection = connection

    def _one(self, query: str, params: tuple[Any, ...] = ()) -> Any:
        cur = self.connection.cursor()
        try:
            cur.execute(query, params)
            return cur.fetchone()
        finally:
            close = getattr(cur, "close", None)
            if callable(close):
                close()

    def registry_agent_exists(self, key: str) -> bool:
        row = self._one(
            "SELECT array_agg(column_name) FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='agents' "
            "AND column_name IN ('id','slug','agent_id','key')"
        )
        columns = list(row[0] or []) if row else []
        columns = [name for name in columns if name in {"id", "slug", "agent_id", "key"}]
        if not columns:
            return False
        predicate = " OR ".join(f'"{name}"::text=%s' for name in columns)
        result = self._one(f"SELECT EXISTS (SELECT 1 FROM public.agents WHERE {predicate})", tuple(key for _ in columns))
        return bool(result and result[0])

    def inspect(self, manifest: Manifest) -> ProvisionStatus:
        control = self._one(
            "SELECT to_regclass('public.sac_tenants') IS NOT NULL "
            "AND to_regclass('public.sac_agents') IS NOT NULL "
            "AND to_regclass('public.sac_channel_accounts') IS NOT NULL "
            "AND to_regclass('public.sac_schema_migrations') IS NOT NULL"
        )
        control_exists = bool(control and control[0])
        if not control_exists:
            return ProvisionStatus(self.registry_agent_exists(manifest.registry_key), False, False, False, False, False, 0)
        row = self._one(
            "SELECT schema_name::text, runtime_config, hermes_api_key_secret_ref, status "
            "FROM public.sac_agents WHERE tenant_id=%s AND id=%s",
            (manifest.tenant_id, manifest.agent_id),
        )
        recorded_schema = str(row[0]) if row else None
        recorded_config = row[1] if row else None
        if isinstance(recorded_config, str):
            recorded_config = json.loads(recorded_config)
        config_matches = bool(
            row and recorded_config == dict(manifest.runtime_config)
            and row[2] == manifest.hermes_api_key_secret_ref
        )
        runtime_configured = bool(
            row and row[2] and isinstance(recorded_config, Mapping)
            and isinstance(recorded_config.get("hermes"), Mapping)
            and recorded_config["hermes"].get("base_url")
        )
        schema_row = self._one("SELECT to_regnamespace(%s) IS NOT NULL", (manifest.schema_name,))
        schema_exists = bool(schema_row and schema_row[0])
        migration = self._one(
            "SELECT EXISTS (SELECT 1 FROM public.sac_schema_migrations "
            "WHERE tenant_id=%s AND agent_id=%s AND version='002')",
            (manifest.tenant_id, manifest.agent_id),
        )
        table_count = 0
        if schema_exists:
            placeholders = ",".join("%s" for _ in REQUIRED_TABLES)
            count = self._one(
                "SELECT count(*) FROM information_schema.tables WHERE table_schema=%s "
                f"AND table_name IN ({placeholders})",
                (manifest.schema_name, *sorted(REQUIRED_TABLES)),
            )
            table_count = int(count[0]) if count else 0
        channels = self._one(
            "SELECT count(*) FROM public.sac_channel_accounts "
            "WHERE tenant_id=%s AND agent_id=%s AND status='active'",
            (manifest.tenant_id, manifest.agent_id),
        )
        return ProvisionStatus(
            self.registry_agent_exists(manifest.registry_key), control_exists, row is not None,
            schema_exists, recorded_schema == manifest.schema_name,
            bool(migration and migration[0]), table_count, config_matches,
            runtime_configured, int(channels[0]) if channels else 0,
        )

    def apply_control_plane(self, sql: str) -> None:
        cur = self.connection.cursor()
        try:
            cur.execute(sql)
            self.connection.commit()
        except BaseException:
            self.connection.rollback()
            raise
        finally:
            close = getattr(cur, "close", None)
            if callable(close):
                close()

    def provision_agent(self, manifest: Manifest) -> None:
        cur = self.connection.cursor()
        try:
            cur.execute(
                "SELECT public.sac_provision_agent(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
                (
                    manifest.tenant_id, manifest.tenant_name, manifest.agent_id,
                    manifest.agent_name, manifest.schema_name, manifest.owner_role,
                    manifest.app_role, manifest.worker_role,
                    json.dumps(manifest.runtime_config, ensure_ascii=False, sort_keys=True),
                    manifest.hermes_api_key_secret_ref,
                ),
            )
            self.connection.commit()
        except BaseException:
            self.connection.rollback()
            raise
        finally:
            close = getattr(cur, "close", None)
            if callable(close):
                close()
