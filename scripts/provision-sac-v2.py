#!/usr/bin/env python3
"""CLI seguro do provisionador SAC v2."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.sac_provisioner import (  # noqa: E402
    DatabaseBackend, Provisioner, ProvisioningError, load_manifest,
    render_plan, validate_offline_registry,
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Provisiona SAC v2 sem revelar credenciais")
    result.add_argument("--manifest", type=Path, required=True)
    result.add_argument("--registry-json", type=Path, help="inventario offline para dry-run")
    result.add_argument("--status", action="store_true", help="somente consulta o banco")
    result.add_argument("--dry-run", action="store_true", help="gera plano; e o comportamento padrao")
    result.add_argument("--output", type=Path, help="grava o plano SQL no dry-run")
    result.add_argument("--apply-control-plane", action="store_true")
    result.add_argument("--apply-agent", action="store_true")
    result.add_argument("--confirm", help="deve ser exatamente tenant_id/agent_id")
    result.add_argument("--database-url-env", default="SAC_DATABASE_URL",
                        help="nome da variavel com DSN; nunca o proprio DSN")
    return result


def connect_from_env(env_name: str):
    if not env_name or not env_name.replace("_", "").isalnum():
        raise ProvisioningError("nome da variavel de banco invalido")
    dsn = os.environ.get(env_name)
    if not dsn:
        raise ProvisioningError(f"variavel {env_name} nao definida")
    try:
        try:
            import psycopg  # type: ignore
            return psycopg.connect(dsn)
        except ImportError:
            import psycopg2  # type: ignore
            return psycopg2.connect(dsn)
    except ImportError as exc:
        raise ProvisioningError("instale psycopg ou psycopg2 no ambiente operacional") from exc
    except Exception as exc:
        # A excecao do driver pode repetir DSN; não a encadeamos nem imprimimos.
        raise ProvisioningError("nao foi possivel conectar ao banco") from None


def emit_status(status) -> None:
    print(json.dumps({
        "ready": status.ready,
        "operational_ready": status.operational_ready,
        "registry_agent_exists": status.registry_agent_exists,
        "control_plane_installed": status.control_plane_installed,
        "agent_row_exists": status.agent_row_exists,
        "schema_exists": status.schema_exists,
        "schema_matches": status.schema_matches,
        "migration_recorded": status.migration_recorded,
        "config_matches": status.config_matches,
        "runtime_configured": status.runtime_configured,
        "active_channel_accounts": status.active_channel_accounts,
        "required_tables": status.required_tables,
        "expected_tables": status.expected_tables,
    }, sort_keys=True))


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    manifest = load_manifest(args.manifest)
    wants_apply = args.apply_control_plane or args.apply_agent
    if sum((bool(args.status), bool(args.dry_run), wants_apply)) > 1:
        raise ProvisioningError("escolha status, dry-run ou aplicacao")

    if not args.status and not wants_apply:
        args.dry_run = True
    if args.dry_run:
        if args.registry_json is None:
            raise ProvisioningError("dry-run exige --registry-json para validar o agente")
        if not validate_offline_registry(args.registry_json, manifest.registry_key):
            raise ProvisioningError("agente nao existe no inventario informado")
        migration = (ROOT / "002_sac_multiagent_v2.sql").read_text(encoding="utf-8")
        plan = render_plan(manifest, include_control_plane=True, migration_sql=migration)
        if args.output:
            args.output.write_text(plan, encoding="utf-8")
            print(json.dumps({"dry_run": True, "agent_validated": True,
                              "schema_name": manifest.schema_name,
                              "plan_written": True}, sort_keys=True))
        else:
            print(plan, end="")
        return 0

    expected = f"{manifest.tenant_id}/{manifest.agent_id}"
    if wants_apply and args.confirm != expected:
        raise ProvisioningError(f"aplicacao exige --confirm {expected}")
    connection = connect_from_env(args.database_url_env)
    try:
        provisioner = Provisioner(DatabaseBackend(connection))
        if args.status:
            emit_status(provisioner.status(manifest))
            return 0
        migration = (ROOT / "002_sac_multiagent_v2.sql").read_text(encoding="utf-8")
        emit_status(provisioner.apply(
            manifest, migration, apply_control_plane=args.apply_control_plane,
            apply_agent=args.apply_agent,
        ))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvisioningError as exc:
        print(f"erro: {exc}", file=sys.stderr)
        raise SystemExit(2)
    except Exception:
        # Falhas de driver nunca vazam DSN, senha ou query com valores.
        print("erro: falha operacional; consulte o log seguro do servidor", file=sys.stderr)
        raise SystemExit(1)
